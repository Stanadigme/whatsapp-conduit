-- One-shot repair for chat policy split across LID/phone aliases of the same
-- directory identity (ST1, phase
-- backlog/phases/2026-09-18-identite-unique-par-conversation.md).
--
-- Before this migration, `chats.is_allowed`/`is_blocked` were read and
-- written per row, so a conversation known under both a phone JID and a LID
-- (the "double identifiant WhatsApp" piege, CLAUDE.md) could have one row
-- authorized and the other still discovered-only — typically because history
-- delivered under the phone JID landed in a separate row from the LID chat
-- the dashboard already allowed. `src/db/queries.ts` now keeps every alias's
-- row aligned going forward (`syncChatPolicyAcrossAliases`,
-- `src/db/directory.ts`); this migration applies the same rule once to
-- whatever the database already holds.
--
-- Same semantics as `chatPolicyForAliases`: blocked wins over allowed.

-- Step 1: any row already blocked blocks every sibling row of the same
-- directory entity.
update chats
set is_blocked = 1,
    is_allowed = 0,
    updated_at = cast(strftime('%s', 'now') as integer)
where (is_blocked = 0 or is_allowed = 1)
  and exists (
    select 1
    from directory_aliases self_alias
    join directory_aliases sibling_alias
      on sibling_alias.account_id = self_alias.account_id
     and sibling_alias.entity_id = self_alias.entity_id
    join chats sibling_chat
      on sibling_chat.account_id = sibling_alias.account_id
     and sibling_chat.jid = sibling_alias.alias_jid
    where self_alias.account_id = chats.account_id
      and self_alias.alias_jid = chats.jid
      and sibling_chat.is_blocked = 1
  );

-- Step 2: among what step 1 left alone, any row already allowed allows every
-- sibling row.
update chats
set is_allowed = 1,
    updated_at = cast(strftime('%s', 'now') as integer)
where is_allowed = 0
  and is_blocked = 0
  and exists (
    select 1
    from directory_aliases self_alias
    join directory_aliases sibling_alias
      on sibling_alias.account_id = self_alias.account_id
     and sibling_alias.entity_id = self_alias.entity_id
    join chats sibling_chat
      on sibling_chat.account_id = sibling_alias.account_id
     and sibling_chat.jid = sibling_alias.alias_jid
    where self_alias.account_id = chats.account_id
      and self_alias.alias_jid = chats.jid
      and sibling_chat.is_allowed = 1
  );
