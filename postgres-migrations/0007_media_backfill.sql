-- Mirrors migrations/0013_media_backfill.sql on the SQLite side. On-demand
-- backfill of media that was never downloaded (store_media was false at
-- ingestion, or the message came through a history sync, which never
-- fetches media on its own — ADR-0012 as amended by ADR-0035).

alter table attachments add column download_attempts integer;
alter table attachments add column download_last_error text;
alter table attachments add column download_attempted_at bigint;

alter table history_jobs add column fetch_media boolean not null default false;

create table media_backfill_jobs (
  id text primary key,
  account_id text not null references accounts (id),
  chat_jid text,
  status text not null
    check (status in ('queued', 'running', 'completed', 'failed')),
  current_chat_jid text,
  attachments_found integer not null default 0,
  attachments_downloaded integer not null default 0,
  attachments_failed integer not null default 0,
  created_at bigint not null,
  started_at bigint,
  updated_at bigint not null,
  completed_at bigint
);

create unique index media_backfill_jobs_one_active_per_account
  on media_backfill_jobs (account_id)
  where status in ('queued', 'running');
