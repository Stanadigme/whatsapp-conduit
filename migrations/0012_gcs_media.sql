-- Phase 3 (ADR-0033): tracks whether an attachment's bytes have been
-- confirmed uploaded to the client's GCS bucket, independently of
-- `downloaded_at` (which only means "fetched from WhatsApp to local disk").
-- The object key itself is not stored: it is derived from `sha256` plus the
-- attachment's extension, the same content-addressed scheme already used for
-- the local cache path (src/ingest/audio.ts), so it never needs to be kept in
-- sync separately.
alter table attachments add column gcs_uploaded_at integer;
