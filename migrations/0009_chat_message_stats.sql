-- Lightweight, materialized per-chat statistics for conversation views.
-- Reads must never aggregate the messages table during page rendering.

create table chat_message_stats (
  account_id text not null,
  chat_jid text not null,
  message_count integer not null default 0,
  media_message_count integer not null default 0,
  oldest_message_ts integer,
  newest_message_ts integer,
  updated_at integer not null,
  primary key (account_id, chat_jid),
  foreign key (account_id, chat_jid) references chats (account_id, jid)
);

insert into chat_message_stats (
  account_id, chat_jid, message_count, media_message_count,
  oldest_message_ts, newest_message_ts, updated_at
)
select account_id, chat_jid, count(*), sum(has_media), min(timestamp),
       max(timestamp), cast(strftime('%s', 'now') as integer)
from messages
group by account_id, chat_jid
on conflict (account_id, chat_jid) do update set
  message_count = excluded.message_count,
  media_message_count = excluded.media_message_count,
  oldest_message_ts = excluded.oldest_message_ts,
  newest_message_ts = excluded.newest_message_ts,
  updated_at = excluded.updated_at;

create trigger chat_message_stats_after_insert
after insert on messages begin
  insert into chat_message_stats (
    account_id, chat_jid, message_count, media_message_count,
    oldest_message_ts, newest_message_ts, updated_at
  ) values (
    new.account_id, new.chat_jid, 1, new.has_media, new.timestamp,
    new.timestamp, cast(strftime('%s', 'now') as integer)
  ) on conflict (account_id, chat_jid) do update set
    message_count = chat_message_stats.message_count + 1,
    media_message_count = chat_message_stats.media_message_count + new.has_media,
    oldest_message_ts = case
      when chat_message_stats.oldest_message_ts is null then new.timestamp
      when new.timestamp is null then chat_message_stats.oldest_message_ts
      else min(chat_message_stats.oldest_message_ts, new.timestamp)
    end,
    newest_message_ts = case
      when chat_message_stats.newest_message_ts is null then new.timestamp
      when new.timestamp is null then chat_message_stats.newest_message_ts
      else max(chat_message_stats.newest_message_ts, new.timestamp)
    end,
    updated_at = excluded.updated_at;
end;

-- Replays normally leave these values unchanged, so they avoid a costly
-- aggregation. A rare changed timestamp/media flag is recomputed at write time.
create trigger chat_message_stats_after_update
after update of timestamp, has_media on messages
when old.timestamp is not new.timestamp or old.has_media is not new.has_media
begin
  update chat_message_stats
  set message_count = (select count(*) from messages
                       where account_id = new.account_id and chat_jid = new.chat_jid),
      media_message_count = (select count(*) from messages
                             where account_id = new.account_id and chat_jid = new.chat_jid
                               and has_media = 1),
      oldest_message_ts = (select min(timestamp) from messages
                           where account_id = new.account_id and chat_jid = new.chat_jid),
      newest_message_ts = (select max(timestamp) from messages
                           where account_id = new.account_id and chat_jid = new.chat_jid),
      updated_at = cast(strftime('%s', 'now') as integer)
  where account_id = new.account_id and chat_jid = new.chat_jid;
end;

create trigger chat_message_stats_after_delete
after delete on messages begin
  update chat_message_stats
  set message_count = (select count(*) from messages
                       where account_id = old.account_id and chat_jid = old.chat_jid),
      media_message_count = (select count(*) from messages
                             where account_id = old.account_id and chat_jid = old.chat_jid
                               and has_media = 1),
      oldest_message_ts = (select min(timestamp) from messages
                           where account_id = old.account_id and chat_jid = old.chat_jid),
      newest_message_ts = (select max(timestamp) from messages
                           where account_id = old.account_id and chat_jid = old.chat_jid),
      updated_at = cast(strftime('%s', 'now') as integer)
  where account_id = old.account_id and chat_jid = old.chat_jid;

  delete from chat_message_stats
  where account_id = old.account_id and chat_jid = old.chat_jid
    and message_count = 0;
end;
