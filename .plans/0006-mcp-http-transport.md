# Transport MCP Streamable HTTP

## Objectif

Ajouter le transport Streamable HTTP au serveur MCP de lecture, sans toucher à
la surface fonctionnelle. Les 13 tools, leurs schémas, l'allowlist, la
pagination, les curseurs et le plafond `WA_MCP_MAX_RESULT_CHARS` restent
définis une seule fois dans `src/mcp/server.ts` (`createMcpServer`). Le mode
stdio reste le comportement par défaut de la commande `mcp`.

Décision de référence : ADR-0019 (dépôt parent). Met en œuvre ADR-0002 ;
n'annule pas ADR-0010.

## Périmètre

- `src/config.ts` — bloc `mcp.http` (`enabled`, `host`, `port`, `token_file`)
  avec valeurs par défaut loopback et port `8766` ; `defaultConfigYaml` mis à
  jour.
- `src/util/token-file.ts` — `ensureTokenFile` / `readTokenFile` extraits de
  `src/dashboard/token.ts` (création `0700`/`0600`, refus symlink, longueur
  minimale). `dashboard/token.ts` délègue désormais à ce module ; les sessions
  navigateur HMAC restent chez lui.
- `src/mcp/http.ts` — serveur `node:http` :
  - `GET /health` public, en amont du bearer, charge utile minimale sans donnée
    privée (`status`, `name`, `version`, `transport`, `connection`, `schema`) ;
  - `POST/GET/DELETE /mcp` derrière un bearer comparé en temps constant ;
  - une `StreamableHTTPServerTransport` + un `createMcpServer` par
    `Mcp-Session-Id`, suivis dans une `Map`, nettoyés sur `DELETE` /
    `transport.onclose` ;
  - garde `Host` loopback quand le bind est loopback ; sautée sinon (reverse
    proxy responsable).
- `src/commands/mcp.ts` — branche `--http` : même ouverture SQLite lecture
  seule et même `createMcpContext` que stdio, puis `startMcpHttpServer`,
  attente `SIGINT`/`SIGTERM`, fermeture propre. Avertissement si le host n'est
  pas loopback.
- `src/cli.ts` — options `--http`, `--host`, `--port` sur la commande `mcp`.

## Tests

- `test/mcp-http.test.ts` — handshake + `tools/list` (13 tools, mêmes que
  stdio), allowlist respectée, `401` sans bearer / bearer faux (token jamais
  renvoyé), `/health` public sans secret ni texte ni JID ni compteur,
  `Mcp-Session-Id` inconnu → `400`, `DELETE` termine la session.
- `test/util-token-file.test.ts` — création `0600`, refus symlink, refus token
  trop court, idempotence.
- `test/dashboard-token.test.ts` inchangé (délégation transparente).

## Hors périmètre

Reverse proxy, certificat TLS, journal d'accès, enregistrement du connecteur
côté claude.ai, rotation de token, OAuth. L'état de session est en mémoire du
process.
