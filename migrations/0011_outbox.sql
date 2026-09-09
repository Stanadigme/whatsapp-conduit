-- Durable local hand-off queue for the future PostgreSQL/GCS forwarder.
-- Sensitive operation data is AES-256-GCM encrypted before insertion; only an
-- opaque HMAC deduplication key and dispatch bookkeeping remain queryable.

create table outbox (
  id integer primary key,
  operation text not null,
  dedupe_key blob not null unique,
  nonce blob not null check (length(nonce) = 12),
  ciphertext blob not null,
  auth_tag blob not null check (length(auth_tag) = 16),
  created_at integer not null,
  attempts integer not null default 0 check (attempts >= 0),
  lease_token text,
  lease_until integer,
  check (
    (lease_token is null and lease_until is null) or
    (lease_token is not null and lease_until is not null)
  )
);

create index outbox_available
  on outbox (lease_until, id);
