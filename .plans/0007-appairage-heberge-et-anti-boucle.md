# Appairage serveur hébergé et anti-boucle

Contexte complet et décision : ADR-0020 (dépôt parent), complète ADR-0009.

## Constat

Sur un serveur hébergé (IP datacenter), l'enregistrement d'un appareil lié est
refusé (`405` Baileys ; côté whatsmeow le handshake + QR + LID map aboutissent
mais `whatsmeow_device` reste vide). Aggravé par :

- `runWhatsmeow` ne teste que `existsSync(whatsmeowStore)` — un fichier de
  store laissé par un `link` interrompu passe le garde, puis `transport.start()`
  lève et le conteneur quitte en boucle (`restart: unless-stopped`).
- `RuntimeStatusWriter(..., { authLinked: true })` en dur ; `status.ts` calcule
  `authLinked` sur la seule présence du fichier. Les deux mentent.

## Changements

- `src/whatsmeow/session.ts` (nouveau) : `whatsmeowSessionLinked(storePath)` —
  ouvre le store en lecture seule, `true` seulement si `whatsmeow_device`
  contient au moins une ligne.
- `src/whatsmeow/session-lock.ts` (nouveau) : verrou `${store}.lock`
  (`{pid,host,startedAt}`). `sessionLockHeld` détecte un pid vivant sur le même
  hôte ; `acquireSessionLock` écrase un lock périmé, refuse un lock vivant.
- `src/commands/run.ts` : `waitForLinkedSession()` — boucle de backoff
  (10 → 30 → 60 s) jusqu'à ce qu'une session apparaisse, interruptible par
  `SIGINT`/`SIGTERM`/`AbortSignal` (`RunOptions.signal`). `run` prend le verrou
  après détection, le relâche à l'arrêt. `authLinked` du runtime-status reflète
  `whatsmeowSessionLinked`.
- `src/commands/link.ts` : `runWhatsmeowLink` prend le verrou avant de toucher
  whatsmeow ; échoue net si `run` le détient ; relâche sur succès et sur échec.
- `src/commands/status.ts` : `authLinked` via `whatsmeowSessionLinked` pour le
  transport whatsmeow.

## Tests

- `test/whatsmeow-session.test.ts`, `test/session-lock.test.ts` (nouveaux).
- `test/run.test.ts` réécrit : `run` attend et s'arrête proprement sur
  `AbortSignal` au lieu de rejeter.
- `test/link.test.ts` : `link` refuse quand le verrou est tenu.
- `test/status.test.ts` : store avec table `whatsmeow_device` vide →
  `authLinked:false`.

## Hors périmètre

Plomberie `whatsmeow.proxy_url` (variable d'env du sous-processus Go) — à
vérifier empiriquement, suivi `backlog/ingestion.md`.
