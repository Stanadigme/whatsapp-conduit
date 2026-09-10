-- Canonical client-side tables for the direct alpha (ADR-0033).
--
-- Two deliberate departures from the SQLite source schema:
--   * identity is always a canonical JID, never a SQLite autoincrement id, so
--     a rebuilt local cache never renumbers client-owned rows;
--   * attachments carry no local path — the bytes live in the client bucket,
--     and phase 3 adds their opaque object id.
--
-- Timestamps are Unix seconds UTC, as everywhere else in this project.

create table directory_entities (
  account_id text not null references accounts (id),
  canonical_jid text not null,
  entity_type text not null check (entity_type in ('contact', 'group')),
  name text,
  display_name text,
  push_name text,
  verified_name text,
  name_source text,
  first_seen_at bigint not null,
  updated_at bigint not null,
  last_synced_at bigint,
  raw_json text,
  primary key (account_id, canonical_jid)
);

create index directory_entities_by_type_name
  on directory_entities (account_id, entity_type, name);

create table directory_aliases (
  account_id text not null,
  alias_jid text not null,
  canonical_jid text not null,
  alias_type text not null check (alias_type in ('canonical', 'phone', 'lid')),
  first_seen_at bigint not null,
  updated_at bigint not null,
  primary key (account_id, alias_jid),
  foreign key (account_id, canonical_jid)
    references directory_entities (account_id, canonical_jid)
);

create index directory_aliases_by_canonical
  on directory_aliases (account_id, canonical_jid);

create table directory_group_members (
  account_id text not null,
  group_jid text not null,
  member_jid text not null,
  role text check (role in ('member', 'admin', 'superadmin')),
  is_active boolean not null default true,
  first_seen_at bigint not null,
  updated_at bigint not null,
  primary key (account_id, group_jid, member_jid),
  foreign key (account_id, group_jid)
    references directory_entities (account_id, canonical_jid),
  foreign key (account_id, member_jid)
    references directory_entities (account_id, canonical_jid)
);

create index directory_group_members_by_member
  on directory_group_members (account_id, member_jid, is_active);

create table attachments (
  account_id text not null,
  chat_jid text not null,
  message_id text not null,
  attachment_index integer not null default 0,
  media_type text,
  mime_type text,
  file_name text,
  sha256 text,
  size_bytes bigint,
  downloaded_at bigint,
  raw_json text,
  primary key (account_id, chat_jid, message_id, attachment_index),
  foreign key (account_id, chat_jid, message_id)
    references messages (account_id, chat_jid, message_id)
);

-- `text_raw` is the engine output and is never rewritten; post-correction
-- writes `text_corrected` (invariant 8).
create table transcriptions (
  account_id text not null,
  chat_jid text not null,
  message_id text not null,
  audio_sha256 text,
  text_raw text,
  text_corrected text,
  language text,
  confidence double precision,
  engine text not null,
  engine_model text,
  lexicon_version integer not null default 0,
  duration_s double precision,
  cost_usd double precision,
  transcribed_at bigint not null,
  raw_json text,
  primary key (account_id, chat_jid, message_id),
  foreign key (account_id, chat_jid, message_id)
    references messages (account_id, chat_jid, message_id)
);

create table transcription_jobs (
  account_id text not null,
  chat_jid text not null,
  message_id text not null,
  status text not null
    check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  reason text,
  attempts integer not null default 0,
  target_lexicon_version integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (account_id, chat_jid, message_id),
  foreign key (account_id, chat_jid, message_id)
    references messages (account_id, chat_jid, message_id)
);

create index transcription_jobs_by_status
  on transcription_jobs (account_id, status, updated_at);

create table history_jobs (
  id text primary key,
  account_id text not null references accounts (id),
  chat_jid text not null,
  since_ts bigint not null,
  until_ts bigint not null,
  status text not null
    check (status in ('queued', 'waiting_connection', 'running', 'completed', 'failed')),
  phase text not null
    check (phase in ('queued', 'waiting_connection', 'requesting', 'ingesting', 'finalizing', 'done', 'failed')),
  progress_percent integer
    check (progress_percent is null or (progress_percent between 0 and 100)),
  anchor_sender_jid text,
  anchor_message_id text,
  anchor_timestamp bigint,
  oldest_seen_ts bigint,
  batches_requested integer not null default 0,
  batches_completed integer not null default 0,
  messages_received integer not null default 0,
  messages_inserted integer not null default 0,
  coverage_complete boolean not null default false,
  completion_reason text,
  error_code text,
  created_at bigint not null,
  started_at bigint,
  updated_at bigint not null,
  completed_at bigint,
  foreign key (account_id, chat_jid) references chats (account_id, jid)
);

create index history_jobs_by_chat_updated
  on history_jobs (account_id, chat_jid, updated_at desc);

-- Materialized per-chat counters. Reads must never aggregate `messages`
-- during page rendering; the runtime projects this row with the message.
create table chat_message_stats (
  account_id text not null,
  chat_jid text not null,
  message_count bigint not null default 0,
  media_message_count bigint not null default 0,
  oldest_message_ts bigint,
  newest_message_ts bigint,
  updated_at bigint not null,
  primary key (account_id, chat_jid),
  foreign key (account_id, chat_jid) references chats (account_id, jid)
);
