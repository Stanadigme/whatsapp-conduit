-- GRH ingestion contract.
-- Additive migration: 0001_initial.sql remains the upstream baseline.

alter table participants add column lid text;
create index participants_by_lid
  on participants (account_id, lid);

alter table messages add column duration_s integer;
alter table messages add column ingestion_source text not null default 'live'
  check (ingestion_source in ('live', 'history', 'backup'));

create index messages_by_ingestion_source
  on messages (account_id, ingestion_source, received_at);
