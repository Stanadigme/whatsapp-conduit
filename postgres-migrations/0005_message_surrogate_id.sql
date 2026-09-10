-- Phase 2 (ADR-0033) pagination and export cursors are built on SQLite's
-- implicit, monotonic `rowid` (see src/read/messages.ts, db/queries.ts's
-- ExportRow.export_rowid). PostgreSQL rows have no equivalent stable
-- identifier — ctid changes across updates and vacuum — so this adds one
-- explicit surrogate, playing the same role: insertion-ordered, stable
-- across an ON CONFLICT DO UPDATE replay (the projection's upserts never
-- reference this column, so it is only ever assigned once, on first insert).
alter table messages add column id bigserial;
create unique index messages_id_idx on messages (id);
