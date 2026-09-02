# Diagnostic du `405` : version WA Web périmée — résolution en direct

Décision : ADR-0020 (dépôt parent), révise ADR-0009.

## Constat

Le `405` à l'appairage n'est pas lié à l'IP de sortie. Sur la machine cible
(OVH `ns3023775`), le bridge WhatsApp de Hermes Agent
(`@whiskeysockets/baileys` 7.0.0-rc13, même compte `33744707085`) tourne
connecté depuis des mois, sans `405`. Sa seule différence : il résout la
version WA Web via `fetchLatestBaileysVersion()` à chaque connexion.

`grh_whatsapp` forçait `DEFAULT_BAILEYS_VERSION = [2,3000,1033893291]` (pin de
`.plans/0003`), aujourd'hui périmé (live ≈ `[2,3000,1043857760]`). WhatsApp
rejette une version trop ancienne au login → `405` avant même l'événement `qr`.

## Changements

- `src/baileys/version.ts` (nouveau) — `createVersionResolver(config, logger,
  fetchLatest?, timeoutMs?)` : `fetchLatestBaileysVersion()` avec timeout,
  cache du dernier bon résultat, repli sur `config.baileys.version`. Si
  `baileys.pin_version: true`, renvoie le pin sans fetch.
- `src/commands/run.ts`, `src/commands/link.ts` — passent
  `fetchVersion: createVersionResolver(...)` dans les `ConnectionDeps` du
  chemin Baileys (le hook `deps.fetchVersion` existait, jamais utilisé).
- `src/baileys/connect.ts` — `resolveVersion()` factorisé, re-résolu au
  reconnect (une déconnexion forcée peut suivre un bump de version).
- `src/config.ts` — `transport` par défaut = `baileys` ; `baileys.pin_version`
  (bool, défaut `false`) ; `DEFAULT_BAILEYS_VERSION` re-documenté « repli
  hors-ligne ». `defaultConfigYaml` mis à jour.
- `src/commands/web.ts` — le garde `transport: whatsmeow` ne s'applique plus
  qu'avec l'appairage activé ; `--no-pairing` autorise le dashboard lecture
  seule sur tout transport.

## Écart de parité (transport Baileys, déjà existant)

Pas de `DirectorySync`, pas de `HistoryControlServer` (`wa_history_download`
MCP indisponible), pas d'onglet appairage dashboard. Suivi backlog parent.

## Tests

`test/baileys-version.test.ts` (résolveur : live / pin / repli / cache /
timeout / erreur). `test/connect.test.ts` (version résolue passée au socket ;
re-résolution au reconnect). `test/config.test.ts` (défaut `baileys`,
`pinVersion`). `test/run.test.ts` / `test/link.test.ts` : cas whatsmeow
explicitement pinnés + cas défaut Baileys.

## Vérifié

`fetchLatestBaileysVersion()` répond depuis `ns3023775`
(`[2,3000,1043857760]`). `link --qr` atteint l'affichage du QR, **aucun
`405`**.
