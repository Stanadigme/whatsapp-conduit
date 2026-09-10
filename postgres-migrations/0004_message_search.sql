-- Full-text search for phase 2 (ADR-0033), mirroring the diacritics-
-- insensitive, non-stemming SQLite FTS5 tokenizer
-- (migrations/0003_mcp_search_diacritics.sql: `unicode61 remove_diacritics 2`).
-- 'simple' does not stem; unaccent folds accents the same way.
--
-- unaccent() is STABLE, not IMMUTABLE, so it cannot appear directly in a
-- generated column. This thin wrapper is the standard workaround: the
-- unaccent dictionary does not change at runtime for a given installation.
create extension if not exists unaccent;

create function immutable_unaccent(text) returns text as
$$ select unaccent('unaccent', $1) $$ language sql immutable parallel safe;

alter table messages add column search_vector tsvector
  generated always as
    (to_tsvector('simple', immutable_unaccent(coalesce(text, '')))) stored;

create index messages_search_vector_idx on messages using gin (search_vector);

-- The effective transcript only: corrected text when present, else raw — the
-- same precedence wa_get_transcript and wa_messages_search apply elsewhere.
-- text_raw itself is never overwritten (invariant 8); this column only
-- shadows it for search ranking.
alter table transcriptions add column search_vector tsvector
  generated always as (
    to_tsvector('simple', immutable_unaccent(coalesce(text_corrected, text_raw, '')))
  ) stored;

create index transcriptions_search_vector_idx
  on transcriptions using gin (search_vector);
