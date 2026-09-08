-- Drop `normalized_text` from the search index.
--
-- The column was only ever written as a verbatim copy of `text`
-- (`normalizedText: text` at the ingestion sites), so indexing it doubled the
-- FTS content for no gain: since 0003 the tokenizer applies
-- `remove_diacritics 2`, and the search matches all columns at once, so
-- accent-insensitive search already works through `text` alone.
--
-- The column itself is kept on `messages`. Dropping it would be a destructive
-- migration for a column nothing reads.
drop trigger if exists messages_fts_after_insert;
drop trigger if exists messages_fts_after_delete;
drop trigger if exists messages_fts_after_update;
drop table if exists messages_fts;

create virtual table messages_fts using fts5(
  text,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

create trigger messages_fts_after_insert
after insert on messages begin
  insert into messages_fts(rowid, text) values (new.rowid, new.text);
end;

create trigger messages_fts_after_delete
after delete on messages begin
  insert into messages_fts(messages_fts, rowid, text)
  values ('delete', old.rowid, old.text);
end;

create trigger messages_fts_after_update
after update of text on messages begin
  insert into messages_fts(messages_fts, rowid, text)
  values ('delete', old.rowid, old.text);
  insert into messages_fts(rowid, text) values (new.rowid, new.text);
end;

insert into messages_fts(messages_fts) values ('rebuild');
