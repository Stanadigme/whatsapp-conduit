-- PostgreSQL target for the first outbox operation: message.upsert.
-- Timestamps are Unix seconds UTC, as in the SQLite source schema.

create table accounts (
  id text primary key,
  label text,
  self_jid text,
  phone_number text,
  created_at bigint not null,
  updated_at bigint not null
);

create table chats (
  account_id text not null references accounts (id),
  jid text not null,
  name text,
  push_name text,
  is_group boolean not null default false,
  is_status boolean not null default false,
  is_blocked boolean not null default false,
  is_allowed boolean not null default false,
  discovered_at bigint not null,
  updated_at bigint not null,
  last_message_ts bigint,
  raw_json text,
  primary key (account_id, jid)
);

create table messages (
  account_id text not null,
  chat_jid text not null,
  message_id text not null,
  sender_jid text,
  from_me boolean not null default false,
  timestamp bigint,
  received_at bigint not null,
  message_type text,
  text text,
  normalized_text text,
  has_media boolean not null default false,
  duration_s integer,
  ingestion_source text not null check (ingestion_source in ('live', 'history', 'backup')),
  quoted_message_id text,
  quoted_sender_jid text,
  edited_message_id text,
  deleted_at bigint,
  raw_json text,
  primary key (account_id, chat_jid, message_id),
  foreign key (account_id, chat_jid) references chats (account_id, jid)
);

create index messages_by_chat_ts on messages (account_id, chat_jid, timestamp);
create index messages_by_ts on messages (account_id, timestamp);
