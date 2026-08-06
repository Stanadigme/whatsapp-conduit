-- Rebuild the MCP message index with accent-insensitive matching.
drop trigger if exists messages_fts_after_insert;
drop trigger if exists messages_fts_after_delete;
drop trigger if exists messages_fts_after_update;
drop table if exists messages_fts;

create virtual table messages_fts using fts5(
  text,
  normalized_text,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

create trigger messages_fts_after_insert
after insert on messages begin
  insert into messages_fts(rowid, text, normalized_text)
  values (new.rowid, new.text, new.normalized_text);
end;

create trigger messages_fts_after_delete
after delete on messages begin
  insert into messages_fts(messages_fts, rowid, text, normalized_text)
  values ('delete', old.rowid, old.text, old.normalized_text);
end;

create trigger messages_fts_after_update
after update of text, normalized_text on messages begin
  insert into messages_fts(messages_fts, rowid, text, normalized_text)
  values ('delete', old.rowid, old.text, old.normalized_text);
  insert into messages_fts(rowid, text, normalized_text)
  values (new.rowid, new.text, new.normalized_text);
end;

insert into messages_fts(messages_fts) values ('rebuild');
