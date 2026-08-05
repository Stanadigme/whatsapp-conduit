# Fix pairing-code WebSocket readiness

The pairing-code flow currently requests a code from the `connecting` event.
Baileys emits that event before its WebSocket and Noise handshake are ready,
while `requestPairingCode()` immediately sends an IQ node. Baileys therefore
raises `Connection Closed` or closes the session with status 428 before the
pairing request can be completed.

## Scope

- Use Baileys' post-handshake `qr` event as the pairing-code trigger and also
  wait for `sock.waitForSocketOpen()` before requesting a pairing code.
- Preserve only safe connection status information in logs and errors.
- Clear provisional pairing credentials after an unsuccessful, unauthenticated
  attempt so `status` and `run` do not treat it as a linked session.
- Keep an already authenticated session intact.
- Add focused tests without a live WhatsApp connection.

## Acceptance criteria

- The pairing request is not sent before the WebSocket is ready.
- A failed pairing leaves `authLinked: false` when no account was authenticated.
- A completed account remains linked after unrelated link failure handling.
- Phone numbers, pairing codes, auth payloads, and message text never enter logs.
- `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and
  `pnpm build` pass.
