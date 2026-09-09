# 0011 — Outbox/spool local chiffré

## But

Préserver l'atomicité synchrone de l'ingestion avant le port PostgreSQL : le
chemin chaud ajoutera une opération durable à `outbox` dans la transaction
SQLite, puis un forwarder asynchrone l'écrira dans la persistance du client.

## Première tranche (livrée)

1. Ajouter la migration
   [`0011_outbox.sql`](../migrations/0011_outbox.sql) : opérations ordonnées, clé de
   déduplication opaque, charge AES-256-GCM, tentatives et lease de reprise.
2. Écrire [`src/db/outbox.ts`](../src/db/outbox.ts) avec uniquement `node:crypto` : création d'une
   clé locale `0600`, chiffrement authentifié, enqueue idempotent, lease,
   acknowledgement et remise en attente.
3. Couvrir le chiffrement, la déduplication, la reprise après lease et le fait
   qu'un acknowledgement soit la seule suppression possible.

Cette tranche ne contacte aucun service distant.

## Deuxième tranche (en cours)

Le daemon crée la clé locale et écrit, dans la même transaction SQLite que
l'ingestion, un instantané chiffré `message.upsert` après chaque création,
édition ou révocation de message. Les relectures du même message coalescent sur
sa clé naturelle. L'outbox est donc active sans dépendre du VPS client ; aucun
forwarder réseau ne démarre encore tant que l'adaptateur PostgreSQL/GCS et sa
configuration validée ne sont pas livrés.

Le mécanisme de forwarder est également livré sans endpoint : il obtient un
lease ordonné, appelle l'adaptateur injecté, acknowledge uniquement une écriture
confirmée et conserve la première erreur avec les opérations suivantes. Il ne
fait donc aucun appel réseau à lui seul ; l'adaptateur PostgreSQL/GCS sera son
unique transport.

Le premier adaptateur PostgreSQL est disponible : il exige mTLS, refuse les
URL portant un mot de passe et écrit le snapshot `message.upsert` dans une
transaction. Sa migration est
[`0001_message_snapshots.sql`](../postgres-migrations/0001_message_snapshots.sql).
Il n'est pas instancié par le daemon : la configuration cliente chiffrée, le
runner de migrations distant, GCS et les autres opérations restent distincts.

## Garanties du contrat

- Le texte et les identifiants WhatsApp sont dans la charge chiffrée, jamais
  dans les logs ni dans les colonnes d'index.
- AES-256-GCM authentifie aussi le type d'opération et la clé de
  déduplication ; une altération rend la charge illisible.
- Une opération n'est supprimée qu'après l'acknowledgement du forwarder.
- Un lease expiré redevient disponible après redémarrage ; une erreur distante
  ne supprime rien.

## Limite volontaire

Le volume de l'instance reste le premier chiffrement au repos, exigé par
ADR-0028. Une clé de fichier locale protège en plus la table contre une copie
isolée de SQLite, mais ne remplace ni le volume chiffré ni une future gestion
de secrets. La politique de saturation (taille, durée de panne et arrêt de
l'ingestion) reste ouverte. Elle est explicitement différée pour avancer sur
l'adaptateur de persistance ; aucune limite n'est choisie implicitement dans le
code.

## Hors périmètre

- Forwarder PostgreSQL/GCS et leur réseau privé.
- Upload/purge des fichiers média.
- Modification des surfaces MCP ou dashboard.
