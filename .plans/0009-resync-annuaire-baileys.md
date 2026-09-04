# Rafraîchir l'annuaire Baileys : resync à la connexion + bouton dashboard

Décision : ADR-0022 (dépôt parent), section « Rafraîchissement ».

## Constat

Depuis ADR-0022, l'ingestion Baileys sépare `push_name` (public, issu du
`pushName` des messages en direct — **alimenté**) de `display_name` (nom local
téléphone / WhatsApp Web) et des sujets de groupes. Or `display_name` et les
sujets ne proviennent que de la **synchro d'app-state Baileys**, qui parke à
l'appairage (`critical_block blocked on missing key from v0`) et n'est jamais
relancée sur reconnexion. Résultat : `display_name` vide partout (0/23 en base
sur le compte de test), le dashboard n'affiche que le nom public, et certains
contacts ou groupes restent un JID nu (ex. `199879305461931@lid`).

## Changements

- `src/baileys/directory.ts` (nouveau) — `resyncBaileysDirectory(sock, deps)` :
  `sock.resyncAppState(["critical_block", "critical_unblock_low",
  "regular_high", "regular_low", "regular"], true)` re-télécharge les
  collections contacts/chats (les handlers `contacts.*` / `chats.*` d'ADR-0022
  persistent les noms), puis `sock.groupMetadata(jid)` pour chaque groupe déjà
  connu en base (`is_group = 1`), concurrence 4, try/catch par groupe, le
  `subject` est écrit via `persistChatMetadata`. Renvoie
  `{ contacts, groups }` (delta de contacts nommés, groupes rafraîchis).
  Requêtes IQ de lecture seule — aucun `sendMessage` / `readMessages`
  (couvert par `test/safety.test.ts`).
- `src/baileys/ingest.ts` — `persistChatMetadata` exporté ; écoute
  `groups.upsert` / `groups.update` (le `subject` y arrive aussi hors resync).
- `src/baileys/connect.ts` — `ConduitConnection.socket()` expose le socket
  vivant.
- `src/control/ipc.ts` — canal de contrôle généralisé : `ControlRequest` est
  une union `history.start | directory.resync` ; `ControlResponse` porte
  `resynced?: { contacts, groups }` ; `sendControlRequest` factorisé ;
  nouveau client `requestDirectoryResync(path, timeoutMs = 30_000)`. Alias
  dépréciés conservés (`HistoryControl*`).
- `src/commands/run.ts` — le chemin **Baileys** démarre désormais un
  `HistoryControlServer` sur `config.paths.controlSocket` (parité avec
  whatsmeow) : `directory.resync` → `resyncBaileysDirectory`,
  `history.start` → erreur claire (« requires transport: whatsmeow »,
  dashboard dégrade en 409). `onOpen` lance un resync fire-and-forget si
  `config.baileys.resyncDirectoryOnConnect` (une fois par process). Le chemin
  **whatsmeow** étend son handler existant : `directory.resync` →
  `DirectorySync.sync({ groups: true, contacts: true })`.
- `src/config.ts` — `BaileysConfig.resyncDirectoryOnConnect` (bool, défaut
  `true`), `asBool(baileysRaw.resync_directory_on_connect, true)`, ligne
  commentée dans `defaultConfigYaml`.
- `src/dashboard/api.ts` — `POST /api/directory/refresh` →
  `requestDirectoryResync` → `{ status: "done", contacts, groups }` (202),
  erreur → 409.
- `src/dashboard/server.ts` — carte « Contacts et groupes » : bouton
  « Rafraîchir les noms » + ligne de statut ; JS `POST /api/directory/refresh`
  puis `refresh()` de la liste.

## Tests

`test/baileys-directory.test.ts` (nouveau : 5 collections + `isInitialSync`,
`groupMetadata` par groupe connu, `subject` persisté, survit à un échec
d'app-state). `test/history-ipc.test.ts` (`directory.resync` round-trip via
`requestDirectoryResync` ; message d'erreur du handler propagé).
`test/dashboard-api.test.ts` (`POST /api/directory/refresh` → 202 avec
compteurs ; contrôle injoignable → 409). `test/config.test.ts`
(`resyncDirectoryOnConnect` défaut `true`). `test/safety.test.ts` scanne
automatiquement `src/baileys/directory.ts`.

## Limites connues

- Un tiers non enregistré dans le carnet d'adresses et jamais vu avec un
  `pushName` (ni via l'app-state) reste sans nom : le dashboard affiche son JID
  (ex. `@lid`). C'est le comportement attendu de WhatsApp — il n'existe aucune
  source de nom pour ce contact.
- Quand l'app-state parke sur `missing key from v0`, `resyncAppState` rejoue le
  même instantané et échoue de nouveau : `display_name` reste vide pour tous
  les contacts sur cette session. Les sujets de groupes viennent de
  `groupMetadata` et sont bien rafraîchis. Seul un ré-appairage du linked
  device redéclenche l'envoi des `App State Sync Key Share`. Vérifié le
  2026-09-04 sur le compte hébergé (`33744707085`) : 5/5 groupes nommés,
  0/24 `display_name` tant que l'app-state est parké ; le bouton et le resync
  à la connexion fonctionnent (`{"status":"done","contacts":0,"groups":5}`).
