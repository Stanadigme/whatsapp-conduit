-- Phase 3 (ADR-0033): tracks whether an attachment's bytes have been
-- confirmed uploaded to the client's GCS bucket. Mirrors
-- migrations/0012_gcs_media.sql on the SQLite side. The object key is not
-- stored here either, for the same reason: it is derived from `sha256` plus
-- the attachment's extension, never kept as a separate column to drift from.
alter table attachments add column gcs_uploaded_at bigint;
