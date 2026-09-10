-- Export consumer cursors, added for phase 2 (ADR-0033): `wa_export` and
-- `offsets commit` need a --since-last cursor that survives once export reads
-- no longer touch SQLite. Same shape as the SQLite source table
-- (migrations/0001_initial.sql).
create table consumer_offsets (
  consumer_name text primary key,
  last_seen_timestamp bigint,
  last_seen_event_id bigint,
  updated_at bigint not null
);
