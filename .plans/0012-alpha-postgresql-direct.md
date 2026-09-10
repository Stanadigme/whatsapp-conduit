# 0012 — Alpha : socle PostgreSQL direct

## But

Livrer le premier incrément de l’alpha définie par
[ADR-0033](../../../decisions/ADR-0033-alpha-hybride-direct-postgresql-gcs.md) :
l’ingestion écrit directement dans le PostgreSQL du client, tandis que SQLite
reste seulement un cache de travail provisoire. Cette tranche ne branche ni le
spool, ni GCS, ni les lectures MCP/dashboard distantes.

## État livré

Cette tranche est livrée. Ce qui existe désormais :

- `persistence.postgres` dans le YAML opérateur — URL sans mot de passe,
  `password_file` et `ca_file` locaux `0600`, TLS vérifiant le certificat
  serveur. Une URL portant un mot de passe ou un `sslmode` est refusée ; le
  dashboard et l’environnement ne peuvent pas la modifier.
- `whatsapp-conduit postgres migrate` applique
  [0001_message_snapshots.sql](../postgres-migrations/0001_message_snapshots.sql)
  et [0002_alpha_projection.sql](../postgres-migrations/0002_alpha_projection.sql).
  Le daemon ne migre jamais la base cliente.
- [src/db/postgres-projection.ts](../src/db/postgres-projection.ts) : file
  mémoire sérielle déclenchée après chaque écriture SQLite pertinente. Les jobs
  ne transportent que des clés naturelles et relisent SQLite au moment de
  s’exécuter, donc une transaction annulée projette l’état réellement conservé
  et les répétitions coalescent. Chaque job s’exécute dans une transaction
  PostgreSQL, avec une échéance de 5 secondes après acquisition de la connexion ;
  l’acquisition elle-même est bornée par `connectionTimeoutMillis`.
- Sous ce profil, `run` n’injecte plus de clé outbox dans l’ingestion.
- Un échec distant produit une seule ligne de journal — famille d’opération et
  code SQLSTATE — sans texte, JID, secret, URL ni payload, sans retry et sans
  statut public.

Validation exécutée : `pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
`pnpm build`, `pnpm test`, plus
[test/postgres-integration.test.ts](../test/postgres-integration.test.ts) contre
un PostgreSQL éphémère (`WA_TEST_POSTGRES_URL`, voir l’en-tête du fichier).

Reste ouvert : la vérification sur le PostgreSQL réel du pilote, et la question
d’une borne de taille pour la file mémoire.

## État de départ

- L’outbox SQLite chiffrée et son forwarder existent, mais l’ADR-0033 les
  reporte à la bêta ; ils ne doivent pas devenir le transport alpha.
- La migration PostgreSQL
  [0001_message_snapshots.sql](../postgres-migrations/0001_message_snapshots.sql)
  et son adaptateur mTLS ne couvrent que les comptes, conversations et messages
  et ne sont instanciés par aucun processus.
- L’ingestion Baileys est synchrone vis-à-vis de SQLite. La nouvelle écriture
  PostgreSQL doit être explicitement best-effort : son échec est signalé sans
  texte de message et n’entraîne ni relecture ni reprise durable.

## Livrables

1. Des migrations PostgreSQL versionnées couvrant les données nécessaires à la
   source de vérité alpha : comptes, conversations, messages, annuaire,
   allowlist/blocage, pièces jointes, transcriptions, jobs et statistiques.
2. Une configuration de persistance uniquement fournie par l’opérateur : un
   endpoint PostgreSQL explicite, TLS avec validation du certificat serveur et
   une identité applicative dédiée. Aucun réglage de destination n’est exposé
   au dashboard ou par une variable d’environnement modifiable.
3. Un adaptateur direct idempotent et une intégration à l’ingestion pour les
   événements qui modifient ces données. La voie alpha n’enqueue pas
   l’opération dans l’outbox et ne prétend jamais qu’une écriture refusée a
   abouti.
4. Des tests de migration et d’intégration PostgreSQL sur le chemin nominal,
   sans contenu WhatsApp dans les logs ou les assertions.

## Découpage

1. Cartographier les tables SQLite et les requêtes de lecture qui seront
   nécessaires en phase 2 ; figer les clés naturelles, contraintes et index
   PostgreSQL correspondants avant d’écrire les migrations.
2. Ajouter les migrations et un runner explicite réservé à la base du pilote.
   Vérifier une base vide, une migration répétée et les contraintes
   d’idempotence.
3. Introduire une abstraction d’écriture directe injectable dans l’ingestion.
   Les handlers Baileys attendent son résultat de manière contrôlée afin de
   signaler un échec, sans bloquer indéfiniment la réception ni constituer une
   file durable.
4. Écrire les projections de messages, annuaire et politique d’accès, puis les
   projections restantes nécessaires à la lecture alpha. Désactiver la remise
   d’instantanés à l’outbox pour ce profil.
5. Ajouter les tests de contrat et exécuter `pnpm lint`, `pnpm format:check`,
   `pnpm typecheck`, `pnpm build` et `pnpm test`.

## Hors périmètre

- Lire PostgreSQL depuis MCP, dashboard ou export : phase 2.
- Upload, import et streaming GCS : phase 3.
- Spool, retry, chiffrement de configuration, mTLS, fédération GCS et tests de
  panne : bêta.
- Déploiement Compose, proxy TLS et appairage du pilote : phase 4.

## Critère de sortie

Sur PostgreSQL de test, un événement entrant autorisé et une modification de
politique d’accès produisent une projection idempotente dans les tables du
pilote. Une indisponibilité distante est rendue visible sans loguer le contenu,
sans fausse confirmation et sans reprise après redémarrage.
