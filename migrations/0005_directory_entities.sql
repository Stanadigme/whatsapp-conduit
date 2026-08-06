-- Directory source of truth. 0004 remains immutable and is kept as a
-- compatibility projection for existing ingestion consumers.

create table directory_entities (
  id integer primary key autoincrement,
  account_id text not null,
  entity_type text not null
    check (entity_type in ('contact', 'group')),
  canonical_jid text not null,
  name text,
  display_name text,
  push_name text,
  verified_name text,
  name_source text,
  first_seen_at integer not null,
  updated_at integer not null,
  last_synced_at integer,
  raw_json text,
  unique (account_id, canonical_jid),
  foreign key (account_id) references accounts (id)
);

create index directory_entities_by_canonical
  on directory_entities (account_id, canonical_jid);

create index directory_entities_by_type_name
  on directory_entities (account_id, entity_type, name);

create table directory_aliases (
  account_id text not null,
  alias_jid text not null,
  entity_id integer not null,
  alias_type text not null
    check (alias_type in ('canonical', 'phone', 'lid')),
  first_seen_at integer not null,
  updated_at integer not null,
  primary key (account_id, alias_jid),
  foreign key (entity_id) references directory_entities (id)
);

create index directory_aliases_by_entity
  on directory_aliases (account_id, entity_id);

create table directory_group_members (
  account_id text not null,
  group_entity_id integer not null,
  member_entity_id integer not null,
  role text check (role in ('member', 'admin', 'superadmin')),
  is_active integer not null default 1 check (is_active in (0, 1)),
  first_seen_at integer not null,
  updated_at integer not null,
  primary key (account_id, group_entity_id, member_entity_id),
  foreign key (group_entity_id) references directory_entities (id),
  foreign key (member_entity_id) references directory_entities (id)
);

create index directory_group_members_by_group
  on directory_group_members (account_id, group_entity_id, is_active);

create index directory_group_members_by_member
  on directory_group_members (account_id, member_entity_id, is_active);

insert into directory_entities (
  account_id, entity_type, canonical_jid, name, first_seen_at, updated_at,
  last_synced_at, raw_json
)
select account_id, 'group', jid, nullif(trim(name), ''), discovered_at,
       updated_at, updated_at, raw_json
from chats
where is_group = 1 or jid like '%@g.us';

insert into directory_entities (
  account_id, entity_type, canonical_jid, name, display_name, push_name,
  verified_name, name_source, first_seen_at, updated_at, last_synced_at,
  raw_json
)
select account_id, 'contact', jid,
       coalesce(nullif(trim(display_name), ''),
                nullif(trim(verified_name), ''),
                nullif(trim(push_name), '')),
       nullif(trim(display_name), ''), nullif(trim(push_name), ''),
       nullif(trim(verified_name), ''),
       case
         when nullif(trim(display_name), '') is not null then 'display_name'
         when nullif(trim(verified_name), '') is not null then 'verified_name'
         when nullif(trim(push_name), '') is not null then 'push_name'
         else null
       end,
       first_seen_at, updated_at, updated_at, raw_json
from participants;

insert into directory_entities (
  account_id, entity_type, canonical_jid, name, display_name, first_seen_at,
  updated_at, last_synced_at, raw_json
)
select c.account_id, 'contact', c.jid, nullif(trim(c.name), ''),
       nullif(trim(c.name), ''), c.discovered_at, c.updated_at, c.updated_at,
       c.raw_json
from chats c
where c.is_group = 0 and c.jid not like '%@g.us'
  and not exists (
    select 1 from directory_entities e
    where e.account_id = c.account_id and e.canonical_jid = c.jid
  );

update directory_entities
set name = coalesce(
      (select nullif(trim(c.name), '') from chats c
       where c.account_id = directory_entities.account_id
         and c.jid = directory_entities.canonical_jid
         and c.is_group = 0 and c.jid not like '%@g.us'), name),
    display_name = coalesce(
      (select nullif(trim(c.name), '') from chats c
       where c.account_id = directory_entities.account_id
         and c.jid = directory_entities.canonical_jid
         and c.is_group = 0 and c.jid not like '%@g.us'), display_name),
    name_source = case when exists (
      select 1 from chats c
      where c.account_id = directory_entities.account_id
        and c.jid = directory_entities.canonical_jid
        and c.is_group = 0 and c.jid not like '%@g.us'
        and nullif(trim(c.name), '') is not null
    ) then 'local' else name_source end
where entity_type = 'contact';

-- Keep the pre-0005 participant projection complete for contacts discovered
-- through chats alone, so older ingestion and MCP readers remain usable.
insert into participants (
  account_id, jid, phone, display_name, push_name, verified_name,
  first_seen_at, updated_at, raw_json
)
select e.account_id, e.canonical_jid,
       case when e.canonical_jid like '%@s.whatsapp.net'
            then replace(e.canonical_jid, '@s.whatsapp.net', '') end,
       e.display_name, e.push_name, e.verified_name,
       e.first_seen_at, e.updated_at, e.raw_json
from directory_entities e
where e.entity_type = 'contact'
  and not exists (
    select 1 from participants p
    where p.account_id = e.account_id and p.jid = e.canonical_jid
  );

insert into directory_aliases (
  account_id, alias_jid, entity_id, alias_type, first_seen_at, updated_at
)
select e.account_id, e.canonical_jid, e.id, 'canonical',
       e.first_seen_at, e.updated_at
from directory_entities e;

insert into directory_aliases (
  account_id, alias_jid, entity_id, alias_type, first_seen_at, updated_at
)
select a.account_id, a.alias_jid, e.id,
       case when a.alias_jid like '%@lid' then 'lid' else 'phone' end,
       a.first_seen_at, a.updated_at
from participant_aliases a
join directory_entities e
  on e.account_id = a.account_id
 and e.canonical_jid = a.canonical_jid
on conflict (account_id, alias_jid) do update set
  entity_id = excluded.entity_id,
  alias_type = excluded.alias_type,
  updated_at = max(directory_aliases.updated_at, excluded.updated_at);

insert into directory_group_members (
  account_id, group_entity_id, member_entity_id, role, is_active,
  first_seen_at, updated_at
)
select gm.account_id, g.id, m.id, gm.role, gm.is_active,
       gm.first_seen_at, gm.updated_at
from group_members gm
join directory_entities g
  on g.account_id = gm.account_id
 and g.canonical_jid = gm.group_jid
 and g.entity_type = 'group'
join directory_aliases a
  on a.account_id = gm.account_id
 and a.alias_jid = gm.participant_jid
join directory_entities m
  on m.id = a.entity_id
 and m.entity_type = 'contact';
