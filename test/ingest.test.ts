import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proto, type WAMessage, type WASocket } from "baileys";
import type * as BaileysNS from "baileys";
import { resolveConfig, type Config } from "../src/config.js";
import {
  exposedForSideEffects,
  ingestMessage,
  ingestReaction,
  ingestUpdate,
  registerIngestion,
  type IngestDeps,
} from "../src/baileys/ingest.js";
import { openDb } from "../src/db/index.js";
import { getDirectoryEntityByJid } from "../src/db/directory.js";
import {
  countMessages,
  getChat,
  getMessage,
  setChatAllowed,
  setChatBlocked,
  upsertChat,
  upsertParticipant,
  upsertAccount,
} from "../src/db/queries.js";
import { listDashboardChats } from "../src/dashboard/chats.js";
import { createLogger } from "../src/util/logging.js";

const baileysMock = vi.hoisted(() => ({ downloadMediaMessage: vi.fn() }));
vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof BaileysNS>();
  return { ...actual, downloadMediaMessage: baileysMock.downloadMediaMessage };
});

beforeEach(() => {
  baileysMock.downloadMediaMessage.mockReset();
  baileysMock.downloadMediaMessage.mockResolvedValue(
    new Readable({
      read(): void {
        this.push(null);
      },
    }),
  );
});

function deps(config: Config): IngestDeps {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "personal" });
  return {
    db,
    accountId: "personal",
    config,
    logger: createLogger({ level: "error" }),
  };
}

function msg(overrides: Partial<WAMessage>): WAMessage {
  return {
    key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "M1" },
    messageTimestamp: 1700,
    pushName: "Alice",
    ...overrides,
  } as WAMessage;
}

const baseConfig = resolveConfig({}, { dataDir: "/data" });

class FakeEventSocket {
  private readonly listeners = new Map<
    string,
    Array<(value: unknown) => void>
  >();
  readonly ev = {
    on: (event: string, listener: (value: unknown) => void): void => {
      const current = this.listeners.get(event) ?? [];
      current.push(listener);
      this.listeners.set(event, current);
    },
  };

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

describe("ingestMessage persistence", () => {
  it.each([
    proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
    proto.HistorySync.HistorySyncType.FULL,
  ])(
    "stores pairing history as history without implicit media (%s)",
    (syncType) => {
      const d = deps(baseConfig);
      const socket = new FakeEventSocket();
      registerIngestion(socket as unknown as WASocket, d);

      socket.emit("messaging-history.set", {
        chats: [],
        contacts: [],
        messages: [
          msg({
            message: { audioMessage: { url: "https://example.invalid/audio" } },
          }),
        ],
        syncType,
      });

      expect(
        getMessage(d.db, "personal", "c@s.whatsapp.net", "M1")
          ?.ingestion_source,
      ).toBe("history");
      expect(baileysMock.downloadMediaMessage).not.toHaveBeenCalled();
      d.db.close();
    },
  );

  it("persists an allowed reconnect message delivered in a recent-history batch", () => {
    const d = deps(
      resolveConfig(
        { filters: { allowed_chats: ["c@s.whatsapp.net"] } },
        { dataDir: "/data" },
      ),
    );
    const socket = new FakeEventSocket();
    registerIngestion(socket as unknown as WASocket, d);

    socket.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [msg({ message: { conversation: "reconnect" } })],
      syncType: proto.HistorySync.HistorySyncType.RECENT,
    });

    expect(
      getMessage(d.db, "personal", "c@s.whatsapp.net", "M1"),
    ).toMatchObject({ ingestion_source: "live" });
    d.db.close();
  });

  it("stores a text message with chat, sender, and metadata", () => {
    const d = deps(baseConfig);
    ingestMessage(d, msg({ message: { conversation: "hi there" } }));

    expect(countMessages(d.db)).toBe(1);
    const row = getMessage(d.db, "personal", "c@s.whatsapp.net", "M1");
    expect(row?.text).toBe("hi there");
    expect(row?.message_type).toBe("text");
    const chat = getChat(d.db, "personal", "c@s.whatsapp.net");
    expect(chat?.last_message_ts).toBe(1700);
    expect(chat?.push_name).toBe("Alice");
    d.db.close();
  });

  it("is idempotent on repeated delivery", () => {
    const d = deps(baseConfig);
    const m = msg({ message: { conversation: "dup" } });
    ingestMessage(d, m);
    ingestMessage(d, m);
    expect(countMessages(d.db)).toBe(1);
    d.db.close();
  });

  it("resolves an incoming LID and stores audio duration", () => {
    const d = deps(baseConfig);
    upsertParticipant(d.db, {
      accountId: "personal",
      jid: "49111@s.whatsapp.net",
      lid: "9001@lid",
    });
    ingestMessage(
      d,
      msg({
        key: {
          remoteJid: "c@s.whatsapp.net",
          fromMe: false,
          id: "AUDIO1",
          participant: "9001@lid",
        },
        message: {
          audioMessage: {
            seconds: 42,
            mimetype: "audio/ogg; codecs=opus",
          },
        },
      }),
    );
    const row = getMessage(d.db, "personal", "c@s.whatsapp.net", "AUDIO1");
    expect(row?.sender_jid).toBe("49111@s.whatsapp.net");
    expect(row?.duration_s).toBe(42);
    d.db.close();
  });

  it("resolves a fromMe group message from messaging-history.set with no participant to self_jid", () => {
    const d = deps(baseConfig);
    // messaging-history.set carries no participant at all for our own group
    // messages (live delivery instead sets key.participant to our LID).
    upsertAccount(d.db, {
      id: "personal",
      selfJid: "33744707085@s.whatsapp.net",
    });
    ingestMessage(
      d,
      msg({
        key: { remoteJid: "g@g.us", fromMe: true, id: "SELF1" },
        message: { conversation: "sent by me" },
      }),
      "history",
    );
    const row = getMessage(d.db, "personal", "g@g.us", "SELF1");
    expect(row?.sender_jid).toBe("33744707085@s.whatsapp.net");
    expect(row?.from_me).toBe(1);
    d.db.close();
  });

  it("persists Baileys LID mapping events", () => {
    const d = deps(baseConfig);
    const socket = new FakeEventSocket();
    registerIngestion(socket as unknown as WASocket, d);

    socket.emit("lid-mapping.update", {
      pn: "49111@s.whatsapp.net",
      lid: "9001@lid",
    });

    const participant = d.db
      .prepare(
        "select jid, lid from participants where account_id = 'personal'",
      )
      .get() as { jid: string; lid: string } | undefined;
    expect(participant).toEqual({
      jid: "49111@s.whatsapp.net",
      lid: "9001@lid",
    });
    d.db.close();
  });

  it("persists phone-only contacts and keeps local, verified, and public names separate", () => {
    const d = deps(baseConfig);
    const socket = new FakeEventSocket();
    registerIngestion(socket as unknown as WASocket, d);

    socket.emit("contacts.upsert", [
      {
        id: "49111@s.whatsapp.net",
        name: "Nom local",
        notify: "Nom public",
        verifiedName: "Entreprise vérifiée",
      },
    ]);

    expect(
      d.db
        .prepare(
          "select jid, lid, phone, display_name, push_name, verified_name from participants",
        )
        .get(),
    ).toEqual({
      jid: "49111@s.whatsapp.net",
      lid: null,
      phone: "49111",
      display_name: "Nom local",
      push_name: "Nom public",
      verified_name: "Entreprise vérifiée",
    });
    const entity = getDirectoryEntityByJid(
      d.db,
      "personal",
      "49111@s.whatsapp.net",
      "contact",
    );
    expect(entity?.name).toBe("Nom local");
    expect(entity?.name_source).toBe("display_name");
    d.db.close();
  });

  it("applies partial contact updates without erasing existing metadata", () => {
    const d = deps(baseConfig);
    const socket = new FakeEventSocket();
    registerIngestion(socket as unknown as WASocket, d);

    socket.emit("contacts.upsert", [
      {
        id: "49112@s.whatsapp.net",
        name: "Nom local",
        notify: "Public initial",
        verifiedName: "Entreprise initiale",
      },
    ]);
    socket.emit("contacts.update", [
      { id: "49112@s.whatsapp.net", notify: "Public actualisé" },
    ]);
    socket.emit("contacts.update", [
      { id: "49112@s.whatsapp.net", name: "", verifiedName: "" },
    ]);

    expect(
      d.db
        .prepare(
          "select display_name, push_name, verified_name from participants",
        )
        .get(),
    ).toEqual({
      display_name: "Nom local",
      push_name: "Public actualisé",
      verified_name: "Entreprise initiale",
    });
    d.db.close();
  });

  it("merges a LID-first contact with its phone JID", () => {
    const d = deps(baseConfig);
    const socket = new FakeEventSocket();
    registerIngestion(socket as unknown as WASocket, d);

    socket.emit("contacts.upsert", [
      { id: "9001@lid", name: "Nom local LID", notify: "Public LID" },
    ]);
    socket.emit("contacts.upsert", [
      { id: "49113@s.whatsapp.net", lid: "9001@lid" },
    ]);

    expect(
      d.db
        .prepare("select jid, lid, display_name, push_name from participants")
        .all(),
    ).toEqual([
      {
        jid: "49113@s.whatsapp.net",
        lid: "9001@lid",
        display_name: "Nom local LID",
        push_name: "Public LID",
      },
    ]);
    expect(
      d.db
        .prepare(
          "select canonical_jid from directory_entities where entity_type = 'contact'",
        )
        .all(),
    ).toEqual([{ canonical_jid: "49113@s.whatsapp.net" }]);
    d.db.close();
  });

  it("ingests contact and chat metadata from messaging-history.set", () => {
    const d = deps(baseConfig);
    const socket = new FakeEventSocket();
    registerIngestion(socket as unknown as WASocket, d);

    socket.emit("messaging-history.set", {
      contacts: [
        {
          id: "49114@s.whatsapp.net",
          name: "Nom historique local",
          notify: "Nom historique public",
        },
      ],
      chats: [{ id: "49114@s.whatsapp.net", name: "Nom chat historique" }],
      lidPnMappings: [{ lid: "9002@lid", pn: "49114@s.whatsapp.net" }],
      messages: [],
    });

    expect(getChat(d.db, "personal", "49114@s.whatsapp.net")?.name).toBe(
      "Nom chat historique",
    );
    expect(
      listDashboardChats(d.db, "personal").find(
        (chat) => chat.jid === "49114@s.whatsapp.net",
      )?.name,
    ).toBe("Nom historique local");
    expect(d.db.prepare("select jid, lid from participants").get()).toEqual({
      jid: "49114@s.whatsapp.net",
      lid: "9002@lid",
    });
    d.db.close();
  });

  it("does not store text when store_message_text is false", () => {
    const d = deps(
      resolveConfig(
        { privacy: { store_message_text: false } },
        { dataDir: "/data" },
      ),
    );
    ingestMessage(d, msg({ message: { conversation: "secret" } }));
    const row = getMessage(d.db, "personal", "c@s.whatsapp.net", "M1");
    expect(row).toBeDefined();
    expect(row?.text).toBeNull();
    expect(row?.normalized_text).toBeNull();
    expect(row?.message_type).toBe("text");
    // store_message_text=false is authoritative: raw_json (which contains text)
    // is suppressed too, even though store_raw_json defaults true.
    expect(row?.raw_json).toBeNull();
    d.db.close();
  });

  // ADR-0037 §1: the capture scope governs exposure, not retention. A message
  // the phone delivers is stored no matter the category or allow/block list —
  // "excluded" now means "never exposed", decided at read time.
  it("stores group messages regardless of `include_groups`", () => {
    const group = msg({
      key: {
        remoteJid: "g@g.us",
        fromMe: false,
        id: "G1",
        participant: "49a@s.whatsapp.net",
      },
      message: { conversation: "group msg" },
    });

    const off = deps(baseConfig);
    ingestMessage(off, group);
    expect(countMessages(off.db)).toBe(1);
    off.db.close();

    const on = deps(
      resolveConfig(
        { privacy: { include_groups: true } },
        { dataDir: "/data" },
      ),
    );
    ingestMessage(on, group);
    expect(countMessages(on.db)).toBe(1);
    on.db.close();
  });

  it("stores a message from a blocked chat and records no ignored event", () => {
    const d = deps(
      resolveConfig(
        { filters: { blocked_chats: ["c@s.whatsapp.net"] } },
        { dataDir: "/data" },
      ),
    );
    ingestMessage(d, msg({ message: { conversation: "topsecretbody" } }));
    expect(countMessages(d.db)).toBe(1);
    // ADR-0037 §5: no more `ignored` journal line for a scope reason — the
    // message is in `messages`, a second record would say the same thing.
    const events = d.db
      .prepare("select event_type from events")
      .all() as Array<{ event_type: string }>;
    expect(events).toHaveLength(0);
    d.db.close();
  });

  it("applies a revoke as a tombstone on the target message", () => {
    const d = deps(baseConfig);
    ingestMessage(d, msg({ message: { conversation: "will be deleted" } }));
    ingestMessage(
      d,
      msg({
        key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "REVOKE_EVT" },
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { id: "M1" },
          },
        },
      }),
    );
    const row = getMessage(d.db, "personal", "c@s.whatsapp.net", "M1");
    expect(row?.deleted_at).not.toBeNull();
    // Original text is preserved as a tombstone record.
    expect(row?.text).toBe("will be deleted");
    d.db.close();
  });

  it("still stores messages from a chat blocked via `chats block` (DB flag)", () => {
    const d = deps(baseConfig);
    // Discover the chat, then block it via the DB policy flag.
    ingestMessage(d, msg({ message: { conversation: "first" } }));
    expect(countMessages(d.db)).toBe(1);
    setChatBlocked(d.db, "personal", "c@s.whatsapp.net", true);

    ingestMessage(
      d,
      msg({
        key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "M2" },
        message: { conversation: "after block" },
      }),
    );
    expect(
      getMessage(d.db, "personal", "c@s.whatsapp.net", "M2"),
    ).toBeDefined();
    d.db.close();
  });

  it("ingests a reaction, and a later removal clears the emoji", () => {
    const d = deps(baseConfig);
    ingestMessage(d, msg({ message: { conversation: "react to me" } }));
    const target = { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "M1" };
    const reactorKey = { remoteJid: "c@s.whatsapp.net", fromMe: false };
    // Reactor is the 1:1 counterparty → row id derived from target + reactor.
    const rowId = "reaction:M1:c@s.whatsapp.net";

    ingestReaction(d, target, { text: "🔥", key: reactorKey });
    let r = getMessage(d.db, "personal", "c@s.whatsapp.net", rowId);
    expect(r?.message_type).toBe("reaction");
    expect(r?.text).toBe("🔥");
    expect(r?.quoted_message_id).toBe("M1");

    // Removal (no text) overwrites the stored emoji on the same row.
    ingestReaction(d, target, { key: reactorKey });
    r = getMessage(d.db, "personal", "c@s.whatsapp.net", rowId);
    expect(r?.text).toBe("");
    d.db.close();
  });

  it("dedupes a live reaction delivered via both upsert and reaction event", () => {
    const d = deps(baseConfig);
    ingestMessage(d, msg({ message: { conversation: "react to me" } }));
    expect(countMessages(d.db)).toBe(1);

    // Same reaction from the counterparty via messages.upsert (reactionMessage)
    // and via the dedicated messages.reaction event → one deduped row.
    ingestMessage(
      d,
      msg({
        key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "RXMSG" },
        message: { reactionMessage: { text: "🎉", key: { id: "M1" } } },
      }),
    );
    ingestReaction(
      d,
      { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "M1" },
      { text: "🎉", key: { remoteJid: "c@s.whatsapp.net", fromMe: false } },
    );
    // 1 original message + 1 reaction row (not 2 reaction rows).
    expect(countMessages(d.db)).toBe(2);
    expect(
      getMessage(
        d.db,
        "personal",
        "c@s.whatsapp.net",
        "reaction:M1:c@s.whatsapp.net",
      )?.text,
    ).toBe("🎉");
    d.db.close();
  });

  it("no longer applies the sender filter to update-revokes (blocked participant)", () => {
    const d = deps(
      resolveConfig(
        {
          privacy: { include_groups: true },
          filters: { blocked_senders: ["49bad@s.whatsapp.net"] },
        },
        { dataDir: "/data" },
      ),
    );
    // Seed a group message, then a delete-for-everyone via messages.update
    // from a "blocked" participant — sender filters no longer gate storage
    // (ADR-0037 §1), so the tombstone is applied.
    ingestMessage(
      d,
      msg({
        key: {
          remoteJid: "g@g.us",
          fromMe: false,
          id: "GM",
          participant: "49ok@s.whatsapp.net",
        },
        message: { conversation: "hello group" },
      }),
    );
    ingestUpdate(d, {
      key: {
        remoteJid: "g@g.us",
        fromMe: false,
        id: "GM",
        participant: "49bad@s.whatsapp.net",
      },
      update: { messageStubType: proto.WebMessageInfo.StubType.REVOKE },
    });
    expect(
      getMessage(d.db, "personal", "g@g.us", "GM")?.deleted_at ?? null,
    ).not.toBeNull();
    d.db.close();
  });

  it("no longer applies the sender filter to edits (blocked sender can edit)", () => {
    const d = deps(
      resolveConfig(
        {
          privacy: { include_groups: true },
          filters: { blocked_senders: ["49bad@s.whatsapp.net"] },
        },
        { dataDir: "/data" },
      ),
    );
    // Edit from a "blocked" group participant now writes text — sender
    // filters no longer gate storage (ADR-0037 §1).
    ingestMessage(
      d,
      msg({
        key: {
          remoteJid: "g@g.us",
          fromMe: false,
          id: "EVT",
          participant: "49bad@s.whatsapp.net",
        },
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            key: { id: "ORIG" },
            editedMessage: { conversation: "sneaky edit" },
          },
        },
      }),
    );
    expect(getMessage(d.db, "personal", "g@g.us", "ORIG")?.text).toBe(
      "sneaky edit",
    );
    d.db.close();
  });

  it("applies an edit to the original message", () => {
    const d = deps(baseConfig);
    ingestMessage(d, msg({ message: { conversation: "original" } }));
    ingestMessage(
      d,
      msg({
        key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "EDIT_EVT" },
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            key: { id: "M1" },
            editedMessage: { conversation: "edited" },
          },
        },
      }),
    );
    const row = getMessage(d.db, "personal", "c@s.whatsapp.net", "M1");
    expect(row?.text).toBe("edited");
    expect(row?.edited_message_id).toBe("EDIT_EVT");
    d.db.close();
  });
});

/**
 * ADR-0037 §1: `ingestMessage`'s return value now only reflects whether the
 * event could be parsed and written — a blocked or out-of-scope chat is
 * stored like any other. The follow-up media-download gate lives separately
 * in `exposedForSideEffects` (below), so a chat the filters reject can be
 * stored while still never being downloaded or enqueued to the outbox.
 */
describe("ingestMessage return value reflects persistence, not scope", () => {
  const audio = () =>
    msg({
      key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "AUDIO1" },
      message: { audioMessage: { seconds: 3, mimetype: "audio/ogg" } },
    });

  it("returns the stored message for a persisted audio note", () => {
    const d = deps(baseConfig);
    const stored = ingestMessage(d, audio());
    expect(stored?.messageType).toBe("audio");
    expect(stored?.messageId).toBe("AUDIO1");
    d.db.close();
  });

  it("returns the stored message even for a blocked chat", () => {
    const d = deps(
      resolveConfig(
        { filters: { blocked_chats: ["c@s.whatsapp.net"] } },
        { dataDir: "/data" },
      ),
    );
    expect(ingestMessage(d, audio())?.messageId).toBe("AUDIO1");
    expect(countMessages(d.db)).toBe(1);
    d.db.close();
  });

  it("returns the stored message even for a chat blocked in the database", () => {
    const d = deps(baseConfig);
    ingestMessage(d, msg({ message: { conversation: "first" } }));
    setChatBlocked(d.db, "personal", "c@s.whatsapp.net", true);
    expect(ingestMessage(d, audio())?.messageId).toBe("AUDIO1");
    d.db.close();
  });

  // The gate is "was it persisted", not "is it audio".
  it("returns the stored message for a plain text message", () => {
    const d = deps(baseConfig);
    expect(
      ingestMessage(d, msg({ message: { conversation: "hi" } }))?.messageType,
    ).toBe("text");
    d.db.close();
  });

  it("returns null for an unparseable message", () => {
    const d = deps(baseConfig);
    expect(ingestMessage(d, msg({ message: null }))).toBeNull();
    d.db.close();
  });
});

/**
 * `exposedForSideEffects` is the interim guard (ADR-0037, S3a) that still
 * bounds the two effects that reach outside SQLite — media download and
 * outbox enqueue — until `chatExposureAllowed` (S3b, `src/db/directory.ts`)
 * covers the whole capture scope.
 */
describe("exposedForSideEffects", () => {
  it("is false for a chat excluded by category, true once enabled", () => {
    const off = deps(baseConfig);
    expect(
      exposedForSideEffects(off, {
        jid: "g@g.us",
        isGroup: true,
        isStatus: false,
      }),
    ).toBe(false);
    off.db.close();

    const on = deps(
      resolveConfig(
        { privacy: { include_groups: true } },
        { dataDir: "/data" },
      ),
    );
    // Newly discovered chats default to is_allowed=0 — exposure also
    // requires the DB flag `chats allow` sets.
    upsertChat(on.db, {
      accountId: "personal",
      jid: "g@g.us",
      isGroup: true,
      isStatus: false,
    });
    setChatAllowed(on.db, "personal", "g@g.us", true);
    expect(
      exposedForSideEffects(on, {
        jid: "g@g.us",
        isGroup: true,
        isStatus: false,
      }),
    ).toBe(true);
    on.db.close();
  });

  it("is false for a chat blocked in the database, even if the category is included", () => {
    const d = deps(
      resolveConfig(
        { privacy: { include_groups: true } },
        { dataDir: "/data" },
      ),
    );
    upsertChat(d.db, {
      accountId: "personal",
      jid: "g@g.us",
      isGroup: true,
      isStatus: false,
    });
    setChatAllowed(d.db, "personal", "g@g.us", true);
    setChatBlocked(d.db, "personal", "g@g.us", true);
    expect(
      exposedForSideEffects(d, {
        jid: "g@g.us",
        isGroup: true,
        isStatus: false,
      }),
    ).toBe(false);
    d.db.close();
  });
});

describe("audio download honors exposedForSideEffects", () => {
  const audio = (id: string, chatJid: string, participant?: string) =>
    msg({
      key: {
        remoteJid: chatJid,
        fromMe: false,
        id,
        ...(participant ? { participant } : {}),
      },
      message: { audioMessage: { seconds: 3, mimetype: "audio/ogg" } },
    });

  it("stores an out-of-scope group audio note but never attempts the download", () => {
    // include_groups defaults to false: the message is stored (ADR-0037 §1)
    // but the group is out of scope, so download must not be attempted.
    const d = deps(baseConfig);
    const socket = new FakeEventSocket();
    registerIngestion(socket as unknown as WASocket, d);

    socket.emit("messages.upsert", {
      type: "notify",
      messages: [audio("AUDIO_OOS", "g@g.us", "49a@s.whatsapp.net")],
    });

    expect(countMessages(d.db)).toBe(1);
    expect(baileysMock.downloadMediaMessage).not.toHaveBeenCalled();
    d.db.close();
  });

  it("attempts the download for an in-scope, allowed chat", async () => {
    const d = deps(
      resolveConfig({ privacy: { store_media: true } }, { dataDir: "/data" }),
    );
    upsertChat(d.db, {
      accountId: "personal",
      jid: "c@s.whatsapp.net",
      isGroup: false,
      isStatus: false,
    });
    setChatAllowed(d.db, "personal", "c@s.whatsapp.net", true);
    const socket = new FakeEventSocket();
    registerIngestion(socket as unknown as WASocket, d);

    socket.emit("messages.upsert", {
      type: "notify",
      messages: [audio("AUDIO_IN_SCOPE", "c@s.whatsapp.net")],
    });

    expect(countMessages(d.db)).toBe(1);
    await vi.waitFor(() =>
      expect(baileysMock.downloadMediaMessage).toHaveBeenCalled(),
    );
    d.db.close();
  });
});
