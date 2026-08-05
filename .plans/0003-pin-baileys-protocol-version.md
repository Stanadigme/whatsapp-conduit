# Pin the Baileys protocol version

Pairing-code attempts reach the Baileys handshake but can be rejected with
status `405` when the protocol version selected by the package is not accepted
by WhatsApp. The deployment needs a deliberate, inspectable protocol-version
override instead of relying on an implicit bundled default.

## Scope

- Pin `[2, 3000, 1033893291]` as the default Baileys protocol version.
- Allow a validated three-part numeric override in `config.yaml`.
- Pass the configured version to every newly-created socket, including
  reconnects.
- Keep the version change independent from observe-only behavior and auth
  state handling.

## Acceptance criteria

- A freshly generated configuration contains the pinned version.
- Malformed version overrides fall back to the pinned version.
- Socket construction and reconnects receive the configured tuple.
- `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and
  `pnpm build` pass.
