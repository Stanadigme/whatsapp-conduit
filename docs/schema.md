# Database schema

Small, migration-friendly SQLite schema. **All timestamps are epoch seconds.**
Migrations live in `migrations/` and are tracked in `schema_migrations`; apply
them with `whatsapp-conduit db migrate` and validate with `db check`.

Persistence is idempotent on each table's primary key. Partial replays (edits,
deletes, late normalization) refresh only the fields they carry and never
clobber known values (`COALESCE` / provided-flag guards).

## Tables

### Annuaire (`directory_entities`, `directory_aliases`)

La migration additive `0005_directory_entities.sql` fait de ces tables la
source de vérité des contacts et groupes. `directory_entities` conserve le JID
canonique, le nom, `display_name`, `push_name`, `verified_name`, la source du
nom et `last_synced_at`. `directory_aliases` mappe chaque JID téléphonique ou
LID vers une seule entité. Le JID téléphonique devient canonique dès qu'il est
connu ; le LID reste un alias.

### `directory_group_members`

Cette table conserve les membres actifs et leur rôle (`member`, `admin` ou
`superadmin`) avec les timestamps. Les anciennes tables d'annuaire restent
des projections compatibles pour l'ingestion et les consommateurs existants.
Les événements live appliquent uniquement les métadonnées reçues. Les appels
`getJoinedGroups()`, `getGroupInfo()` et `getUserInfo()` sont réservés à la
commande explicite `directory sync`.

### `accounts`
One row per linked account. `id` is the configured `account.name`.

| column | notes |
|---|---|
| `id` (PK) | account id (config `account.name`) |
| `label`, `self_jid`, `phone_number` | identity, filled on link |
| `created_at`, `updated_at` | |

### `chats`
PK `(account_id, jid)`.

| column | notes |
|---|---|
| `name`, `push_name` | best-known display names |
| `is_group`, `is_status` | classification (only updated when ingestion provides it) |
| `is_blocked`, `is_allowed` | **policy**, owned by `chats allow/block` — never touched by ingestion |
| `last_message_ts` | monotonic, null-safe |
| `discovered_at`, `updated_at`, `raw_json` | |

### `participants`
PK `(account_id, jid)`. Per-sender metadata (`phone`, `display_name`,
`push_name`, `verified_name`, `first_seen_at`). `lid` is indexed and links the
opaque WhatsApp identity (`@lid`) to the canonical phone JID. The
`participant_aliases` table is the authoritative bidirectional JID/LID map and
prevents one contact from being represented by two participant rows.

### `participant_aliases`

PK `(account_id, alias_jid)`. Each known phone JID or LID points to exactly one
canonical `participants.jid`. Existing participant/message references are
merged when a phone JID becomes known.

### `group_members`

PK `(account_id, group_jid, participant_jid)`. Stores the latest known active
state and role (`member`, `admin`, `superadmin`) for group members. Partial
events may update membership without replacing an already-known role; full
group snapshots reconcile inactive members.

### `messages`
PK `(account_id, chat_jid, message_id)`. Normalized common columns plus
`raw_json`.

| column | notes |
|---|---|
| `sender_jid`, `from_me`, `timestamp`, `received_at` | |
| `message_type` | `text`/`image`/`video`/`audio`/`document`/`sticker`/`contact`/`location`/`poll`/`reaction`/`unknown` |
| `text`, `normalized_text` | omitted when `store_message_text: false` |
| `has_media` | preserved across partial replays |
| `duration_s` | audio duration, persisted before any future media download |
| `ingestion_source` | `live`, `history`, or `backup`; defaults to `live` |
| `quoted_message_id`, `quoted_sender_jid` | reply context |
| `edited_message_id` | set when an edit is applied |
| `deleted_at` | tombstone for delete-for-everyone |
| `raw_json` | full payload when `store_raw_json: true` |

Indexed by `(account_id, chat_jid, timestamp)` and `(account_id, timestamp)`.

### `attachments`
PK `(account_id, chat_jid, message_id, attachment_index)`. Media metadata
(type, mime, filename, path, sha256, size). Media is **not** downloaded by
default — these are metadata-only rows.

### `events`
Append-only audit log (`id` autoincrement). Used for `ignored` markers
(filtered chat/sender + reason — never message text).

### `consumer_offsets`
PK `consumer_name`. `last_seen_event_id` stores the export **cursor** (a
message rowid); `last_seen_timestamp` is informational. Both are preserved
independently on a partial advance so `--since-last` can resume.

## Export cursor

`export` orders messages by ascending SQLite `rowid` and emits it as `cursor`.
`--since-last <consumer>` resumes after the stored `last_seen_event_id`. This
is at-least-once and ingestion-ordered; edits/deletes update a row in place and
are not re-exported by cursor alone.
