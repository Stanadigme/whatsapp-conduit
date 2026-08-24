-- Durable, resumable on-demand history synchronization jobs.

create table history_jobs (
  id text primary key,
  account_id text not null,
  chat_jid text not null,
  since_ts integer not null,
  until_ts integer not null,
  status text not null
    check (status in ('queued', 'waiting_connection', 'running', 'completed', 'failed')),
  phase text not null
    check (phase in ('queued', 'waiting_connection', 'requesting', 'ingesting', 'finalizing', 'done', 'failed')),
  progress_percent integer
    check (progress_percent is null or (progress_percent >= 0 and progress_percent <= 100)),
  anchor_sender_jid text,
  anchor_message_id text,
  anchor_timestamp integer,
  oldest_seen_ts integer,
  batches_requested integer not null default 0,
  batches_completed integer not null default 0,
  messages_received integer not null default 0,
  messages_inserted integer not null default 0,
  coverage_complete integer not null default 0 check (coverage_complete in (0, 1)),
  completion_reason text,
  error_code text,
  created_at integer not null,
  started_at integer,
  updated_at integer not null,
  completed_at integer,
  foreign key (account_id) references accounts (id),
  foreign key (account_id, chat_jid) references chats (account_id, jid)
);

create index history_jobs_by_account_updated
  on history_jobs (account_id, updated_at desc);

create index history_jobs_by_chat_updated
  on history_jobs (account_id, chat_jid, updated_at desc);

create unique index history_jobs_one_active_per_account
  on history_jobs (account_id)
  where status in ('queued', 'waiting_connection', 'running');
