-- Operations de maintenance locales. Elles restent séparées de `events` afin
-- qu'un reset de l'audit ne masque jamais l'état de son propre reset.

create table maintenance_operations (
  id text primary key,
  account_id text not null,
  scope text not null check (scope in (
    'directory', 'live_messages', 'history', 'transcriptions', 'media',
    'audit', 'all'
  )),
  status text not null check (status in ('queued', 'running', 'completed', 'failed')),
  counts_json text,
  error_code text,
  created_at integer not null,
  started_at integer,
  completed_at integer,
  foreign key (account_id) references accounts (id)
);

create index maintenance_operations_by_account_created
  on maintenance_operations (account_id, created_at desc);

-- Une seule suppression destructive peut être active pour un compte. Cette
-- contrainte est aussi la frontière de coordination entre ingestion et STT.
create unique index maintenance_operations_one_active_per_account
  on maintenance_operations (account_id)
  where status in ('queued', 'running');

create table maintenance_state (
  account_id text primary key,
  generation integer not null default 0,
  directory_rebuild_required integer not null default 0
    check (directory_rebuild_required in (0, 1)),
  directory_rebuild_error text,
  updated_at integer not null,
  foreign key (account_id) references accounts (id)
);
