# Ré-appairage fiable et maintenance locale

## Objectif

Éviter que le succès d’un QR Baileys soit déclaré avant la réception de la clé
d’état applicatif, puis permettre à l’opérateur de réinitialiser sélectivement
les données locales depuis le dashboard protégé.

## Mise en œuvre

1. Attendre `myAppStateKeyId` après `connection=open`, puis arrêter proprement
   la session de pairing. Conserver les clés d’état et effacer uniquement leurs
   curseurs pour imposer un snapshot au démon redémarré.
2. Réinitialiser automatiquement les projections d’annuaire après un
   ré-appairage réussi et conserver un marqueur de reconstruction jusqu’à une
   synchronisation sans erreur.
3. Ajouter une migration et un moteur d’opérations exclusives couvrant
   annuaire, messages live, historique/jobs, transcriptions, médias,
   audit/curseurs et reset global.
4. Piloter ces opérations avec le socket local de l’ingestion ; le dashboard
   ne fait qu’authentifier, confirmer et suivre une opération.
5. Protéger les fichiers média et empêcher le worker STT de réécrire une
   transcription calculée avant un reset grâce à une génération persistée.
   Après une interruption du démon, marquer l’opération inachevée comme telle
   et exiger une nouvelle demande confirmée au lieu de reprendre une
   suppression automatiquement.

## Validation

- Test du QR conservé jusqu’à la persistance de la clé et échec si elle
  n’arrive pas.
- Tests de chaque domaine de suppression, de la politique de conversation,
  des dépendances SQL, des chemins média externes et de l’exclusion des
  opérations concurrentes.
- `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck` et
  `pnpm build`.
