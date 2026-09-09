# 0011 — Outbox/spool local chiffré

## But

Préserver l'atomicité synchrone de l'ingestion avant le port PostgreSQL : le
chemin chaud ajoutera une opération durable à `outbox` dans la transaction
SQLite, puis un forwarder asynchrone l'écrira dans la persistance du client.

## Première tranche

1. Ajouter la migration
   [`0011_outbox.sql`](../migrations/0011_outbox.sql) : opérations ordonnées, clé de
   déduplication opaque, charge AES-256-GCM, tentatives et lease de reprise.
2. Écrire [`src/db/outbox.ts`](../src/db/outbox.ts) avec uniquement `node:crypto` : création d'une
   clé locale `0600`, chiffrement authentifié, enqueue idempotent, lease,
   acknowledgement et remise en attente.
3. Couvrir le chiffrement, la déduplication, la reprise après lease et le fait
   qu'un acknowledgement soit la seule suppression possible.

Cette tranche ne contacte aucun service distant et ne branche pas encore
l'outbox sur le daemon : tant que le forwarder PostgreSQL/GCS n'existe pas,
l'activer ferait seulement accumuler des messages dans SQLite.

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
l'ingestion) est ouverte : elle devra être décidée avant le branchement du
daemon, jamais choisie implicitement par cette première tranche.

## Hors périmètre

- Forwarder PostgreSQL/GCS et leur réseau privé.
- Upload/purge des fichiers média.
- Modification des surfaces MCP ou dashboard.
