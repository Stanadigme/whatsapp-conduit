# Operations

## Rafraîchir l’annuaire

Il n’existe pas de commande CLI `directory sync` : ce chemin a été retiré avec
le transport whatsmeow (ADR-0042 du dépôt parent). Le rafraîchissement des
noms de contacts et de groupes joints se déclenche de deux façons : une passe
bornée automatique à chaque connexion Baileys lorsque
`baileys.resync_directory_on_connect` reste activé, ou une demande explicite
adressée à l’unique démon d’ingestion — depuis le dashboard, ou depuis un
client MCP via le tool `wa_directory_refresh`.

Ce rafraîchissement ne synchronise pas l’historique et ne lit ni ne persiste
le contenu des messages. Les groupes restent invisibles dans MCP tant qu’ils
ne sont pas explicitement autorisés. Les événements live appliquent
uniquement les métadonnées reçues et n’appellent aucun rafraîchissement
réseau par message.

Day-to-day running of `whatsapp-conduit`.

## First-run flow

```bash
pnpm install
pnpm build

# 1. Create config, data dirs (0700), and the migrated SQLite DB.
whatsapp-conduit init --data-dir <DATA_DIR>

# 2. Link the account as a secondary device. Pairing code is the default;
#    use --qr only as an explicit fallback.
whatsapp-conduit link --phone 49123456789

# 3. Run the foreground observe-only daemon.
whatsapp-conduit run

# 4. Discover chats, then allow the ones you want exported.
whatsapp-conduit chats list
whatsapp-conduit chats allow 49123456789@s.whatsapp.net
```

All commands accept `--config <path>` (default
`~/.config/whatsapp-conduit/config.yaml`).

## Inspection

```bash
whatsapp-conduit status                 # auth + sync state
whatsapp-conduit mcp                    # local read-only MCP server over stdio
whatsapp-conduit mcp --http             # Streamable HTTP MCP server (ADR-0019)
whatsapp-conduit mcp oauth set-password # set/rotate the local OAuth operator password
whatsapp-conduit chats list --json
whatsapp-conduit chats show <jid>
whatsapp-conduit messages list --chat <jid> --limit 50
whatsapp-conduit messages list --since 24h --json
whatsapp-conduit transcribe             # run the local transcription worker pass
whatsapp-conduit web                    # local configuration dashboard
whatsapp-conduit postgres migrate       # apply the client PostgreSQL migrations
whatsapp-conduit postgres import        # one-shot backfill of existing SQLite rows
whatsapp-conduit gcs import             # backfill locally downloaded media to GCS
```

## Export

Exports emit one JSON object per line (JSONL) on stdout, ordered by a stable
per-message `cursor` (the SQLite rowid). **Allowed chats only is the default**
since `--allowed-only` was deprecated to a no-op; `--all` is the explicit
opt-out that also includes non-allowed chats.

```bash
# Only chats you have allowed (default, no flag needed):
whatsapp-conduit export

# Explicit opt-out — be careful, includes non-allowed chats:
whatsapp-conduit export --all

# Time-bounded:
whatsapp-conduit export --since 24h

# Resumable, two-phase for a named consumer:
whatsapp-conduit export --since-last hermes > /tmp/new.jsonl
whatsapp-conduit offsets commit hermes --through <cursor>   # cursor printed by export

# Or advance the offset atomically with the export:
whatsapp-conduit export --since-last hermes --commit > /tmp/new.jsonl
```

`--since-last` resumes after the consumer's stored cursor. Without `--commit`
the offset is left unchanged (two-phase), so a failed downstream step can be
retried safely. `--redact-phone-numbers` replaces phone JIDs with a stable,
non-reversible token; `--include-raw-json` adds the raw Baileys payload.
`--since-last` is a CLI-only capability: the MCP tool `wa_export` exposes only
`after`/`before`/`limit`/`cursor`, not a named consumer offset.

## Service mode (systemd user unit)

```bash
whatsapp-conduit service install --now    # writes ~/.config/systemd/user/whatsapp-conduit.service
whatsapp-conduit service status
whatsapp-conduit service logs
whatsapp-conduit service restart
whatsapp-conduit service stop
```

For a system-wide unit, adapt `systemd/whatsapp-conduit.service` (template in
the repo) and install it under `/etc/systemd/system`. The daemon shuts down
gracefully on SIGINT/SIGTERM (closes the socket and the database).

## Database maintenance

```bash
whatsapp-conduit db migrate           # apply pending migrations
whatsapp-conduit db check             # integrity + foreign-key + migration check
whatsapp-conduit db backup            # online SQLite backup to a given path
whatsapp-conduit db backfill-sender   # one-shot repair of sender identity on older rows
```

## Backup

The database is plain SQLite; back it up with the online backup API so you
don't copy a half-written WAL:

```bash
sqlite3 /path/to/whatsapp-conduit.db ".backup '/backup/whatsapp-conduit-$(date +%F).db'"
```

Treat backups as sensitive (see [security.md](./security.md)).

## Docker

The parent repository is the deployment entrypoint. Initialize the submodule,
then use the same image for development and production:

```bash
git submodule update --init --recursive
cp .env.docker.example .env
docker compose build
docker compose run --rm ingestion init
docker compose run --rm -it ingestion link --phone 49123456789
docker compose up -d ingestion
docker compose logs -f ingestion
```

The parent repository mounts private host directories below
`${WHATSAPP_CONDUIT_VOLUMES_DIR:-./volumes}/ingestion/`: `config/` contains
configuration and `data/` contains SQLite, Baileys authentication and media
state. Back up the SQLite database with its online backup API; never copy a
live WAL by hand.

Pairing waits for the Baileys handshake-ready event before requesting the code,
then confirms that the underlying WebSocket is open. If a link attempt is
interrupted before authentication completes, its provisional pairing
credentials are cleared automatically; retry `link` without deleting an
existing authenticated auth directory.

QR pairing needs two scans since 2026: after the first one WhatsApp sends
`<notification type="companion_reg_refresh">` to retire the adv secret encoded
in the QR, then asks the phone to scan again. Baileys ≤ 7.0.0-rc14 ignores it
(WhiskeySockets/Baileys#2737), so the second scan fails with "check your
connection" while the logs show `failed to ack notification` followed by a 408.
`ConduitConnection` (`src/baileys/connect.ts`) handles the notification itself:
new secret, same QR ref re-rendered, later rotations rewritten. Keep that
handler until a Baileys release listens to
`CB:notification,type:companion_reg_refresh` (upstream PR #2765). The
`failed to ack notification` line is upstream noise (PR #2749) and does not
block pairing.

Baileys logs are kept at `warn` by default. For a protocol diagnosis, set
`logging.baileys_level: trace` while keeping
`logging.baileys_log_message_text: false`, repeat the command, and collect only
the redacted output locally. Message payloads and pairing credentials must not
be logged.

By default, the daemon resolves the current Baileys protocol version at each
connection and falls back to the configured `baileys.version` if that lookup
fails. Set `baileys.pin_version: true` only for a deliberate reproducible or
air-gapped run; update the fallback tuple and rebuild when compatibility
requires it.
