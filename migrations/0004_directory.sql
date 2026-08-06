-- Contact and group directory.
-- This migration is additive. Earlier migrations are intentionally immutable.

alter table participants add column verified_name text;

create table participant_aliases (
  account_id text not null,
  alias_jid text not null,
  canonical_jid text not null,
  first_seen_at integer not null,
  updated_at integer not null,
  primary key (account_id, alias_jid),
  foreign key (account_id, canonical_jid)
    references participants (account_id, jid)
);

create index participant_aliases_by_canonical
  on participant_aliases (account_id, canonical_jid);

create table group_members (
  account_id text not null,
  group_jid text not null,
  participant_jid text not null,
  role text check (role in ('member', 'admin', 'superadmin')),
  is_active integer not null default 1 check (is_active in (0, 1)),
  first_seen_at integer not null,
  updated_at integer not null,
  primary key (account_id, group_jid, participant_jid),
  foreign key (account_id, group_jid)
    references chats (account_id, jid),
  foreign key (account_id, participant_jid)
    references participants (account_id, jid)
);

create index group_members_by_participant
  on group_members (account_id, participant_jid, is_active);

-- Consolidate legacy rows when a phone JID already advertises the LID stored
-- on a separate participant row. The phone JID is the deterministic canonical
-- identity; non-empty values already present on it win.
update participants as phone
set display_name = coalesce(
      nullif(trim(phone.display_name), ''),
      (select nullif(trim(lid.display_name), '')
       from participants as lid
       where lid.account_id = phone.account_id
         and lid.jid = phone.lid
       order by lid.jid limit 1)
    ),
    push_name = coalesce(
      nullif(trim(phone.push_name), ''),
      (select nullif(trim(lid.push_name), '')
       from participants as lid
       where lid.account_id = phone.account_id
         and lid.jid = phone.lid
       order by lid.jid limit 1)
    ),
    phone = coalesce(
      nullif(trim(phone.phone), ''),
      (select nullif(trim(lid.phone), '')
       from participants as lid
       where lid.account_id = phone.account_id
         and lid.jid = phone.lid
       order by lid.jid limit 1)
    ),
    raw_json = coalesce(phone.raw_json,
      (select lid.raw_json
       from participants as lid
       where lid.account_id = phone.account_id
         and lid.jid = phone.lid
       order by lid.jid limit 1)
    ),
    updated_at = max(phone.updated_at,
      coalesce((select lid.updated_at
        from participants as lid
        where lid.account_id = phone.account_id
          and lid.jid = phone.lid
        order by lid.jid limit 1), phone.updated_at))
where phone.jid not like '%@lid'
  and phone.lid is not null
  and exists (
    select 1 from participants as lid
    where lid.account_id = phone.account_id and lid.jid = phone.lid
  );

update messages
set sender_jid = (
  select phone.jid
  from participants as phone
  where phone.account_id = messages.account_id
    and phone.lid = messages.sender_jid
  order by phone.jid limit 1
)
where exists (
  select 1 from participants as phone
  where phone.account_id = messages.account_id
    and phone.lid = messages.sender_jid
);

update messages
set quoted_sender_jid = (
  select phone.jid
  from participants as phone
  where phone.account_id = messages.account_id
    and phone.lid = messages.quoted_sender_jid
  order by phone.jid limit 1
)
where exists (
  select 1 from participants as phone
  where phone.account_id = messages.account_id
    and phone.lid = messages.quoted_sender_jid
);

delete from participants
where jid like '%@lid'
  and exists (
    select 1 from participants as phone
    where phone.account_id = participants.account_id
      and phone.lid = participants.jid
  );

insert into participant_aliases (
  account_id, alias_jid, canonical_jid, first_seen_at, updated_at
)
select account_id, jid, jid, first_seen_at, updated_at
from participants;

insert into participant_aliases (
  account_id, alias_jid, canonical_jid, first_seen_at, updated_at
)
select account_id, lid, min(jid), min(first_seen_at), max(updated_at)
from participants
where lid is not null and trim(lid) <> ''
group by account_id, lid
on conflict (account_id, alias_jid) do update set
  canonical_jid = excluded.canonical_jid,
  updated_at = excluded.updated_at;
