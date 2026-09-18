import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { loadMigrations, runMigrations } from "../src/db/migrations.js";
import { directoryDisplayName } from "../src/db/directory.js";
import {
  listGroupMembers,
  upsertAccount,
  upsertParticipant,
} from "../src/db/queries.js";
import { DirectorySync } from "../src/whatsmeow/directory.js";
import { createLogger } from "../src/util/logging.js";
import type { DirectoryReadTransport } from "../src/transport/types.js";

class FakeDirectoryTransport extends EventEmitter {
  readonly users: string[][] = [];
  joinedGroupsCalls = 0;
  groupInfoCalls = 0;
  userInfoCalls = 0;
  readonly groups = [
    {
      jid: "120@g.us",
      name: "Equipe",
      announce: false,
      locked: false,
      ephemeral: false,
      participants: [
        { jid: "9001@lid", isAdmin: false, isSuperAdmin: false },
        { jid: "491234@s.whatsapp.net", isAdmin: true, isSuperAdmin: false },
      ],
    },
  ];

  async getJoinedGroups() {
    this.joinedGroupsCalls += 1;
    return this.groups;
  }

  async getGroupInfo(jid: string) {
    this.groupInfoCalls += 1;
    return this.groups.find((group) => group.jid === jid) ?? this.groups[0];
  }

  async getUserInfo(jids: string[]) {
    this.userInfoCalls += 1;
    this.users.push(jids);
    return Object.fromEntries(
      jids.map((jid) => [
        jid,
        { status: "", pictureID: "", verifiedName: `V:${jid}` },
      ]),
    );
  }
}

function setup() {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "acct" });
  const transport = new FakeDirectoryTransport();
  const directory = new DirectorySync({
    db,
    accountId: "acct",
    logger: createLogger({ level: "fatal" }),
    transport: transport as unknown as DirectoryReadTransport,
  });
  return { db, transport, directory };
}

describe("DirectorySync", () => {
  it("merges legacy JID/LID rows while applying the additive migration", () => {
    const db = openDb(":memory:", { migrate: false });
    const migrations = loadMigrations();
    db.exec(
      "create table if not exists schema_migrations (name text primary key, applied_at integer not null)",
    );
    for (const migration of migrations.slice(0, 3)) {
      db.exec(migration.sql);
      db.prepare(
        "insert into schema_migrations (name, applied_at) values (?, ?)",
      ).run(migration.name, 1);
    }
    db.prepare(
      "insert into accounts (id, created_at, updated_at) values ('acct', 1, 1)",
    ).run();
    db.prepare(
      `insert into chats (account_id, jid, discovered_at, updated_at)
       values ('acct', '120@g.us', 1, 1)`,
    ).run();
    db.prepare(
      `insert into participants
       (account_id, jid, lid, phone, display_name, first_seen_at, updated_at)
       values ('acct', '491234@s.whatsapp.net', '9001@lid', '491234', 'Phone', 1, 1),
              ('acct', '9001@lid', null, null, null, 2, 2)`,
    ).run();
    db.prepare(
      `insert into messages
       (account_id, chat_jid, message_id, sender_jid, received_at)
       values ('acct', '120@g.us', 'M1', '9001@lid', 1)`,
    ).run();

    runMigrations(db);

    expect(
      db.prepare("select jid, lid, display_name from participants").all(),
    ).toEqual([
      { jid: "491234@s.whatsapp.net", lid: "9001@lid", display_name: "Phone" },
    ]);
    expect(
      db
        .prepare("select sender_jid from messages where message_id = 'M1'")
        .get(),
    ).toEqual({ sender_jid: "491234@s.whatsapp.net" });
    db.close();
  });

  it("repairs a chat policy already split across aliases (migration 0014)", () => {
    // Same shape as the ST1 constat: a LID chat already authorized, a phone
    // JID chat left at its discovered default, and the directory already
    // knowing both aliases belong to the same entity — the state a database
    // could be in before this migration existed.
    const db = openDb(":memory:", { migrate: false });
    const migrations = loadMigrations();
    db.exec(
      "create table if not exists schema_migrations (name text primary key, applied_at integer not null)",
    );
    for (const migration of migrations.slice(0, 6)) {
      db.exec(migration.sql);
      db.prepare(
        "insert into schema_migrations (name, applied_at) values (?, ?)",
      ).run(migration.name, 1);
    }
    db.prepare(
      "insert into accounts (id, created_at, updated_at) values ('acct', 1, 1)",
    ).run();
    db.prepare(
      `insert into chats
         (account_id, jid, is_allowed, is_blocked, discovered_at, updated_at)
       values ('acct', '9001@lid', 1, 0, 1, 1),
              ('acct', '491234@s.whatsapp.net', 0, 0, 1, 1)`,
    ).run();
    db.prepare(
      `insert into directory_entities
         (account_id, entity_type, canonical_jid, first_seen_at, updated_at)
       values ('acct', 'contact', '491234@s.whatsapp.net', 1, 1)`,
    ).run();
    const entity = db
      .prepare<[string], { id: number }>(
        "select id from directory_entities where canonical_jid = ?",
      )
      .get("491234@s.whatsapp.net");
    if (!entity) throw new Error("fixture entity is missing");
    db.prepare(
      `insert into directory_aliases
         (account_id, alias_jid, entity_id, alias_type, first_seen_at, updated_at)
       values ('acct', '491234@s.whatsapp.net', @id, 'canonical', 1, 1),
              ('acct', '9001@lid', @id, 'lid', 1, 1)`,
    ).run({ id: entity.id });

    runMigrations(db);

    expect(
      db
        .prepare("select jid, is_allowed, is_blocked from chats order by jid")
        .all(),
    ).toEqual([
      { jid: "491234@s.whatsapp.net", is_allowed: 1, is_blocked: 0 },
      { jid: "9001@lid", is_allowed: 1, is_blocked: 0 },
    ]);
    db.close();
  });

  it("persists group names, members, roles, and known contact metadata", async () => {
    const { db, transport, directory } = setup();
    const report = await directory.syncJoinedGroups();

    expect(report).toMatchObject({ groups: 1, members: 2, contacts: 2 });
    expect(
      db.prepare("select name from chats where jid = '120@g.us'").get(),
    ).toEqual({ name: "Equipe" });
    expect(listGroupMembers(db, "acct", "120@g.us")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jid: "9001@lid", role: "member" }),
        expect.objectContaining({
          jid: "491234@s.whatsapp.net",
          role: "admin",
        }),
      ]),
    );
    expect(transport.users).toEqual([["491234@s.whatsapp.net", "9001@lid"]]);
    db.close();
  });

  it("refreshes a renamed group in both directory and chat projections", async () => {
    const { db, transport, directory } = setup();
    await directory.syncJoinedGroups();

    const group = transport.groups[0];
    if (!group) throw new Error("fake group is missing");
    group.name = "Equipe renommée";
    await directory.sync({ groups: true, contacts: false });

    expect(
      db
        .prepare(
          "select name, name_source from directory_entities where canonical_jid = '120@g.us'",
        )
        .get(),
    ).toEqual({ name: "Equipe renommée", name_source: "group_info" });
    expect(
      db.prepare("select name from chats where jid = '120@g.us'").get(),
    ).toEqual({ name: "Equipe renommée" });
    db.close();
  });

  it("merges an LID-first contact into its phone JID without duplicates", () => {
    const { db } = setup();
    upsertParticipant(db, {
      accountId: "acct",
      jid: "9001@lid",
      pushName: "Contact",
    });
    upsertParticipant(db, {
      accountId: "acct",
      jid: "491234@s.whatsapp.net",
      lid: "9001@lid",
      displayName: "Nom fiable",
    });

    expect(
      db
        .prepare("select jid, lid, display_name, push_name from participants")
        .all(),
    ).toEqual([
      {
        jid: "491234@s.whatsapp.net",
        lid: "9001@lid",
        display_name: "Nom fiable",
        push_name: "Contact",
      },
    ]);
    expect(
      db
        .prepare(
          "select canonical_jid from participant_aliases where alias_jid = '9001@lid'",
        )
        .get(),
    ).toEqual({ canonical_jid: "491234@s.whatsapp.net" });
    expect(
      db
        .prepare(
          "select canonical_jid from directory_entities where entity_type = 'contact'",
        )
        .all(),
    ).toEqual([{ canonical_jid: "491234@s.whatsapp.net" }]);
    db.close();
  });

  it("does not replace known names with empty metadata", () => {
    const { db } = setup();
    upsertParticipant(db, {
      accountId: "acct",
      jid: "491234@s.whatsapp.net",
      displayName: "Nom fiable",
      pushName: "Push connu",
    });
    upsertParticipant(db, {
      accountId: "acct",
      jid: "491234@s.whatsapp.net",
      displayName: "   ",
      pushName: "",
    });
    expect(
      db.prepare("select display_name, push_name from participants").get(),
    ).toEqual({ display_name: "Nom fiable", push_name: "Push connu" });
    db.close();
  });

  it("resolves contact names local, verified, public, then JID", () => {
    const { db } = setup();
    const local = upsertParticipantAndGetEntity(db, {
      jid: "491235@s.whatsapp.net",
      displayName: "Nom local",
      verifiedName: "Entreprise vérifiée",
      pushName: "Nom public",
    });
    expect(directoryDisplayName(local)).toBe("Nom local");

    const verified = upsertParticipantAndGetEntity(db, {
      jid: "491236@s.whatsapp.net",
      verifiedName: "Entreprise vérifiée",
      pushName: "Nom public",
    });
    expect(directoryDisplayName(verified)).toBe("Entreprise vérifiée");

    const publicName = upsertParticipantAndGetEntity(db, {
      jid: "491237@s.whatsapp.net",
      pushName: "Nom public",
    });
    expect(directoryDisplayName(publicName)).toBe("Nom public");

    const jid = upsertParticipantAndGetEntity(db, {
      jid: "491238@s.whatsapp.net",
    });
    expect(directoryDisplayName(jid)).toBe("491238@s.whatsapp.net");
    db.close();
  });

  it("applies group deltas immediately and preserves a role on partial joins", async () => {
    const { db, transport, directory } = setup();
    directory.register();
    await directory.syncJoinedGroups();
    transport.joinedGroupsCalls = 0;
    transport.groupInfoCalls = 0;
    transport.userInfoCalls = 0;
    transport.emit("group:info", {
      jid: "120@g.us",
      join: ["491234@s.whatsapp.net"],
      leave: ["9001@lid"],
    });

    const member = db
      .prepare(
        `select role, is_active from group_members
         where group_jid = '120@g.us' and participant_jid = '491234@s.whatsapp.net'`,
      )
      .get();
    const left = db
      .prepare(
        `select role, is_active from group_members
         where group_jid = '120@g.us' and participant_jid = '9001@lid'`,
      )
      .get();
    expect(member).toEqual({ role: "admin", is_active: 1 });
    expect(left).toEqual({ role: "member", is_active: 0 });
    expect(transport.joinedGroupsCalls).toBe(0);
    expect(transport.groupInfoCalls).toBe(0);
    expect(transport.userInfoCalls).toBe(0);
    db.close();
  });
});

function upsertParticipantAndGetEntity(
  db: ReturnType<typeof setup>["db"],
  input: {
    jid: string;
    displayName?: string;
    verifiedName?: string;
    pushName?: string;
  },
) {
  upsertParticipant(db, { accountId: "acct", ...input });
  return db
    .prepare(
      "select * from directory_entities where account_id = 'acct' and canonical_jid = ?",
    )
    .get(input.jid) as Parameters<typeof directoryDisplayName>[0];
}
