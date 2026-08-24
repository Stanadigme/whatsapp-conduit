-- Voice-note transcription output and its work queue.
-- `text_raw` is the engine's own output and is never rewritten; the dashboard
-- and a future post-correction layer may write `text_corrected`.

create table transcriptions (
  account_id text not null,
  chat_jid text not null,
  message_id text not null,
  audio_sha256 text,
  text_raw text,
  text_corrected text,
  language text,
  confidence real,
  engine text not null,
  engine_model text,
  lexicon_version integer not null default 0,
  duration_s real,
  cost_usd real,
  transcribed_at integer not null,
  raw_json text,
  primary key (account_id, chat_jid, message_id),
  foreign key (account_id, chat_jid, message_id)
    references messages (account_id, chat_jid, message_id)
);

create index transcriptions_by_lexicon_version
  on transcriptions (account_id, lexicon_version);

create table transcription_jobs (
  id integer primary key,
  account_id text not null,
  chat_jid text not null,
  message_id text not null,
  status text not null
    check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  reason text,
  attempts integer not null default 0,
  target_lexicon_version integer not null default 0,
  created_at integer not null,
  updated_at integer not null,
  foreign key (account_id, chat_jid, message_id)
    references messages (account_id, chat_jid, message_id)
);

create unique index transcription_jobs_by_message
  on transcription_jobs (account_id, chat_jid, message_id);

create index transcription_jobs_by_status
  on transcription_jobs (account_id, status, updated_at);
