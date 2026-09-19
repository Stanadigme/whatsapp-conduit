# Security & privacy model

`whatsapp-conduit` touches private messages. Safety defaults matter more than
convenience.

## Observe-only posture (enforced, not just documented)

By default the bridge only reads. These invariants are covered by tests
(`test/safety.test.ts`, `test/socket.test.ts`):

- Never calls `sock.sendMessage()` / `sock.readMessages()` / presence APIs from
  any path (asserted by a source scan).
- `markOnlineOnConnect` defaults to `false`.
- `syncFullHistory` defaults to `false`.
- `observe_only: true` and `send_enabled: true` are rejected as a config error.

## Sensitive files

Treat all of the following as equivalent to a logged-in WhatsApp session or
private message data. They are git-ignored and created owner-only (`0700`
directories, `0600` files):

- the Baileys auth directory (`auth/`) — a linked-device session;
- the SQLite database and its `-wal` / `-shm` / `-journal` sidecars;
- database backups;
- stored media (if `store_media` is ever enabled);
- JSONL exports (`exports/`, `*.jsonl`);
- the dashboard bearer token (`dashboard.token`);
- the MCP HTTP static bearer token (`mcp-http.token`);
- the local OAuth state: the operator password hash
  (`mcp-oauth-password`), the HMAC signing key for access/refresh tokens
  (`mcp-oauth-key`), and the OAuth state file itself (`mcp-oauth.json` —
  hashed codes and refresh tokens, never in the clear);
- the outbox AES key (`outbox.key`), when the outbox profile is in use.

## Logging

Message text is **not** logged unless `logging.log_message_text: true`. As
defense-in-depth, the logger redacts message-content fields and whole content
containers (`message`, `raw`, `rawJson`, `raw_json`, and `messages[*].message`
batch arrays) by default. The Baileys logger is additionally clamped to `warn`+
unless message text is enabled, because Baileys logs decrypted content at
`debug`/`trace` and handshake/device-pairing key material at `info`.

## Exports

- Exports include **only allowed chats by default**; `--all` is the explicit
  opt-out (`--allowed-only` is deprecated to a no-op, since allowed-only is
  now the default). An empty allowlist means chats are discovered but not
  exposed.
- `--redact-phone-numbers` replaces phone JIDs with a stable SHA-256-derived
  token (non-reversible, but consistent so consumers can still correlate a
  sender). Note: this redacts JIDs, not phone numbers embedded in message text.
- Raw payloads are only included with `--include-raw-json`.

## MCP write surface

The MCP server is not read-only in the strict sense: it registers a small,
named and bounded set of control tools (ADR-0038 of the parent repository)
that may write to `config.yaml` — only the transcription and capture settings
the dashboard can already write — or ask the ingestion daemon for a local
operation (history sync, media backfill, directory refresh, restart). There is
no generic configuration-write tool and no arbitrary relay to the control
socket; no tool ever transmits or modifies a WhatsApp message.

## Threat model notes

This is not a security product, but it avoids obvious footguns: no cloud, no
telemetry, no remote logging, local-first storage. Auditable `ignored` events
record *that* a message was filtered (chat/sender + reason) but never its text.

## Possible future hardening

- SQLCipher or filesystem-level encryption for the DB.
- Encrypted / OS-keychain-backed auth-state storage.
- Per-chat retention policies and message-text redaction in exports.
