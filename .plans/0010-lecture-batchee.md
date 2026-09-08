# 0010 — Lecture batchée et index de recherche sur `text`

## Problème

Le chemin de lecture émettait **160 à 262 requêtes SQL pour une page de 50
messages**. Pour chaque ligne : `transcriptFor` (un `hasTable` sur
`sqlite_master` non mémoïsé + un `select`), puis `participantName`
(`getDirectoryEntityByJid`, 1 à 2 requêtes, plus un repli `participants`).

SQLite local masquait ce coût — quelques microsecondes par requête. Il devient
rédhibitoire dès que la base est distante. Le dashboard le payait déjà à chaque
défilement, `listMessages` étant partagé avec le MCP.

## Ce qui a été fait

### Résolution en SQL plutôt que par ligne

`messageRows` (`src/read/messages.ts`) résout désormais le nom d'expéditeur et
la transcription par `left join`, en reprenant le motif déjà employé par
`listDashboardChats` (`src/dashboard/chats.ts`) et `selectExportMessages`
(`src/db/queries.ts`) : entité canonique d'abord, alias ensuite, puis repli
`participants`.

La projection est factorisée dans `buildMessageView`, partagée par le chemin
unitaire (`messageView`, inchangé) et le chemin joint (`resolvedMessageView`),
pour qu'une page et un message isolé ne puissent pas diverger.

Les trois autres boucles passent par le même chemin : `messageContext` (avant et
après) et `searchMessages` dans `src/mcp/read.ts`. `searchMessages` faisait déjà
la jointure `transcriptions` mais n'en tirait que `matched_transcript` avant de
refaire un `select` par ligne.

Toutes les jointures ajoutées sont des `left join` : un `join` ferait
silencieusement disparaître les messages dont l'expéditeur est inconnu de
l'annuaire.

### Deux gaspillages supprimés

- `hasTable` / `hasVirtualTable` (`src/mcp/types.ts`) sont mémoïsés par
  connexion, sur le modèle de `directoryTablesCache`. Comme lui, **un `false`
  n'est jamais mémoïsé** : une connexion ouverte avant les migrations doit
  pouvoir voir les tables apparaître.
- `listMessages` appelait `listEquivalentJids` une seconde fois pour un JID que
  `allowedChat` venait de résoudre. `allowedChatWithAliases` rend l'expansion
  déjà calculée ; la signature publique d'`allowedChat` est inchangée.

**Mesure : 5 requêtes pour une page de 50 messages**, et le coût ne dépend plus
du nombre de lignes.

### `normalized_text` retiré de l'index de recherche

La colonne n'était écrite qu'en copie littérale de `text`, donc l'index
contenait deux fois le même contenu. Depuis la migration 0003 le tokenizer
applique `remove_diacritics 2` et la recherche matche toutes colonnes
confondues : l'insensibilité aux accents venait déjà de `text` seul.

`migrations/0010_mcp_search_text_only.sql` reconstruit `messages_fts` sur `text`
seul. L'ingestion cesse d'écrire la colonne. **La colonne elle-même est
conservée** sur `messages` : la supprimer serait une migration destructive pour
une colonne que rien ne lit.

Vérifié sur une copie de la base réelle (877 messages) : index reconstruit,
`integrity_check` ok, et `etre`/`être` comme `probleme`/`problème` renvoient des
résultats identiques.

## Tests

- `test/read-messages.test.ts` — plafond de requêtes par page, invariance au
  nombre de lignes, et **équivalence entre `listMessages` (SQL) et `getMessage`
  (par ligne)** sur les quatre cas de résolution : entité canonique, alias LID,
  repli `participants`, expéditeur inconnu. Vérifié par mutation : retirer la
  jointure d'alias fait bien échouer le cas LID.
- `test/mcp-search-contract.test.ts` — accents, casse, et surtout `resum` → 0
  résultat. Ce dernier cas existe pour le futur port : `unicode61
  remove_diacritics 2` correspond à `to_tsvector('simple', …)` avec unaccent, et
  **non** à `'french'`, dont le `french_stem` élargirait silencieusement toutes
  les recherches.

Les tests de contrat existants (`test/dashboard-messages.test.ts`,
`test/mcp.test.ts`) passent sans modification.

## Laissé de côté volontairement

- `src/db/queries.ts:listMessages` (utilisé par `wa messages list`) n'applique
  aucun filtre d'allowlist. Chemin CLI local, à trancher séparément.
- `chatStats` (`src/mcp/read.ts`) agrège `messages` en direct alors que
  `chat_message_stats` matérialise déjà ces compteurs.
- `messageContext` filtre sur `is_allowed` sans `is_blocked`, et sans expansion
  d'alias là où `listMessages` l'utilise.
- La branche transcription de `searchMessages` utilise `lower(...) like`, qui
  conserve les diacritiques : la recherche est accent-insensible sur le texte
  écrit mais pas sur les transcriptions.
