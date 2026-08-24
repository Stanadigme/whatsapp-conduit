# Local configuration dashboard

The service is configured from a single local YAML file. Editing it by hand is
error-prone and, worse, invites edits that silently weaken the observe-only
posture. A small `config` CLI surface — `show` and `set` — gives a read/edit
path over that file without adding a web server (unnecessary attack surface for
an observe-only bridge).

## Scope

- `config show` prints the resolved effective config with secret-named leaves
  masked; `--json` for machine consumption.
- `config set <key> <value>` edits one dotted scalar key in place, preserving
  comments, via an atomic temp-file + rename write that keeps the file
  owner-only (`0o600`).
- `set` writes only keys on an explicit allowlist of safe scalars. Anything
  absent is refused rather than silently written.
- Posture-weakening keys are refused *by name*, before any mutation:
  `privacy.observe_only`, `privacy.send_enabled`, `privacy.mark_read`,
  `baileys.mark_online_on_connect`, `baileys.sync_full_history`.
- Chat-filter lists (`filters.allowed_*`/`blocked_*`) are not editable via
  `set`. They remain managed by `chats allow`/`chats block`, which validate
  JIDs. `set` would only accept them once strict JID validation is implemented
  here too; until then they are documented as CLI-managed.
- The merged document is validated with `resolveConfig` before it reaches disk,
  so a conflicting combination (e.g. observe_only + send_enabled) is rejected as
  defense in depth.

## Acceptance criteria

- `set` on an allowlisted scalar edits the value and preserves template
  comments; the file stays `0o600`.
- Each refused key throws with a "Refusing to set" message and leaves the file
  byte-for-byte unchanged (no write-then-rollback).
- A known-but-non-allowlisted key and an unknown key are both refused as "not
  editable", pointing at `config show` and the `chats` commands.
- Tests do not assert that `sync_full_history=true` succeeds.
- `pnpm typecheck` and the config-command tests pass.
