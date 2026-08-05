# Operations

Day-to-day running of `whatsapp-conduit`.

## First-run flow

```bash
pnpm install
pnpm build

# 1. Create config, data dirs (0700), and the migrated SQLite DB.
whatsapp-conduit init --data-dir /srv/agents-state/nicolai/whatsapp-conduit

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
whatsapp-conduit chats list --json
whatsapp-conduit chats show <jid>
whatsapp-conduit messages list --chat <jid> --limit 50
whatsapp-conduit messages list --since 24h --json
```

## Export

Exports emit one JSON object per line (JSONL) on stdout, ordered by a stable
per-message `cursor` (the SQLite rowid).

```bash
# Everything (be careful — includes non-allowed chats):
whatsapp-conduit export

# Only chats you have allowed:
whatsapp-conduit export --allowed-only

# Time-bounded:
whatsapp-conduit export --since 24h --allowed-only

# Resumable, two-phase for a named consumer:
whatsapp-conduit export --since-last hermes --allowed-only > /tmp/new.jsonl
whatsapp-conduit offsets commit hermes --through <cursor>   # cursor printed by export

# Or advance the offset atomically with the export:
whatsapp-conduit export --since-last hermes --allowed-only --commit > /tmp/new.jsonl
```

`--since-last` resumes after the consumer's stored cursor. Without `--commit`
the offset is left unchanged (two-phase), so a failed downstream step can be
retried safely. `--redact-phone-numbers` replaces phone JIDs with a stable,
non-reversible token; `--include-raw-json` adds the raw Baileys payload.

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
whatsapp-conduit db migrate   # apply pending migrations
whatsapp-conduit db check     # integrity + foreign-key + migration check
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

Pairing waits for the Baileys WebSocket to become ready before requesting the
code. If a link attempt is interrupted before authentication completes, its
provisional pairing credentials are cleared automatically; retry `link` without
deleting an existing authenticated auth directory.
