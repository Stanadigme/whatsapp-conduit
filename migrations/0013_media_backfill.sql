-- On-demand backfill of media that was never downloaded: voice notes
-- received while privacy.store_media was false, or messages obtained
-- through a history sync (which never fetches media on its own, see
-- ADR-0012 as amended by ADR-0035).

-- Tracks download attempts on attachments, whether the row already existed
-- (a retried live failure) or is created by the backfill scan itself (a
-- message that never had a row because store_media was false at the time).
-- Nullable like every other column upsertAttachment coalesce-preserves
-- (src/db/queries.ts): a NOT NULL default would fight that "only touch what
-- the caller passed" semantics on the very first insert.
alter table attachments add column download_attempts integer;
alter table attachments add column download_last_error text;
alter table attachments add column download_attempted_at integer;

-- Remembers the choice made when a history job was started, so the
-- classifier knows whether THIS job's history-sourced messages should also
-- fetch media (opt-in only, never the default — ADR-0035).
alter table history_jobs add column fetch_media integer not null default 0
  check (fetch_media in (0, 1));

-- Durable, resumable backfill jobs. Unlike history_jobs, there is no anchor
-- or batch protocol: this is a plain scan of already-persisted messages
-- followed by a sequential download attempt per candidate.
create table media_backfill_jobs (
  id text primary key,
  account_id text not null,
  chat_jid text,
  status text not null
    check (status in ('queued', 'running', 'completed', 'failed')),
  current_chat_jid text,
  attachments_found integer not null default 0,
  attachments_downloaded integer not null default 0,
  attachments_failed integer not null default 0,
  created_at integer not null,
  started_at integer,
  updated_at integer not null,
  completed_at integer,
  foreign key (account_id) references accounts (id)
);

create unique index media_backfill_jobs_one_active_per_account
  on media_backfill_jobs (account_id)
  where status in ('queued', 'running');
