import { describe, expect, it } from "vitest";
import { openDb, type Database } from "../src/db/index.js";
import { listDashboardChats } from "../src/dashboard/chats.js";
import { upsertDirectoryContact } from "../src/db/directory.js";
import {
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
  upsertChat,
} from "../src/db/queries.js";

function setup(): Database {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "acct" });
  return db;
}

describe("listDashboardChats", () => {
  it("matches on the resolved directory name, not just the chat row", () => {
    const db = setup();
    // The chat row carries no usable name; only the directory knows it.
    upsertChat(db, {
      accountId: "acct",
      jid: "491234@s.whatsapp.net",
      lastMessageTs: 100,
    });
    upsertDirectoryContact(db, {
      accountId: "acct",
      jid: "491234@s.whatsapp.net",
      displayName: "Amelie Dupont",
    });

    const found = listDashboardChats(db, "acct", { query: "amelie" });
    expect(found.map((chat) => chat.jid)).toEqual(["491234@s.whatsapp.net"]);
    expect(found[0]?.name).toBe("Amelie Dupont");
  });

  it("resolves the directory name through an alias JID", () => {
    const db = setup();
    upsertChat(db, { accountId: "acct", jid: "9001@lid", lastMessageTs: 100 });
    upsertDirectoryContact(db, {
      accountId: "acct",
      jid: "491234@s.whatsapp.net",
      lid: "9001@lid",
      displayName: "Bruno",
    });

    const found = listDashboardChats(db, "acct", { query: "bruno" });
    expect(found.map((chat) => chat.jid)).toEqual(["9001@lid"]);
  });

  it("folds case beyond ASCII when searching", () => {
    const db = setup();
    upsertChat(db, {
      accountId: "acct",
      jid: "ecole@s.whatsapp.net",
      name: "École Primaire",
      lastMessageTs: 100,
    });
    // SQLite's built-in lower() only folds ASCII, so this is the case that
    // regresses if the search stops going through lower_u.
    expect(
      listDashboardChats(db, "acct", { query: "école" }).map((c) => c.jid),
    ).toEqual(["ecole@s.whatsapp.net"]);
  });

  it("reaches a chat far past the former 500-row cap", () => {
    const db = setup();
    // 600 more-recent chats used to push this one out of the candidate window,
    // making it unreachable by search whatever the term.
    upsertChat(db, {
      accountId: "acct",
      jid: "needle@s.whatsapp.net",
      name: "Needle",
      lastMessageTs: 1,
    });
    for (let i = 0; i < 600; i += 1) {
      upsertChat(db, {
        accountId: "acct",
        jid: `filler${i}@s.whatsapp.net`,
        name: `Filler ${i}`,
        lastMessageTs: 1_000 + i,
      });
    }

    const found = listDashboardChats(db, "acct", { query: "needle" });
    expect(found.map((chat) => chat.jid)).toEqual(["needle@s.whatsapp.net"]);
  });

  it("filters by kind", () => {
    const db = setup();
    upsertChat(db, { accountId: "acct", jid: "a@s.whatsapp.net" });
    upsertChat(db, { accountId: "acct", jid: "120@g.us", isGroup: true });
    upsertChat(db, {
      accountId: "acct",
      jid: "status@broadcast",
      isStatus: true,
    });

    expect(
      listDashboardChats(db, "acct", { kind: "group" }).map((c) => c.jid),
    ).toEqual(["120@g.us"]);
    expect(
      listDashboardChats(db, "acct", { kind: "contact" }).map((c) => c.jid),
    ).toEqual(["a@s.whatsapp.net"]);
    expect(
      listDashboardChats(db, "acct", { kind: "status" }).map((c) => c.jid),
    ).toEqual(["status@broadcast"]);
  });

  it("filters by policy", () => {
    const db = setup();
    for (const jid of [
      "ok@s.whatsapp.net",
      "no@s.whatsapp.net",
      "new@s.whatsapp.net",
    ])
      upsertChat(db, { accountId: "acct", jid });
    setChatAllowed(db, "acct", "ok@s.whatsapp.net", true);
    setChatBlocked(db, "acct", "no@s.whatsapp.net", true);

    expect(
      listDashboardChats(db, "acct", { policy: "allowed" }).map((c) => c.jid),
    ).toEqual(["ok@s.whatsapp.net"]);
    expect(
      listDashboardChats(db, "acct", { policy: "blocked" }).map((c) => c.jid),
    ).toEqual(["no@s.whatsapp.net"]);
    expect(
      listDashboardChats(db, "acct", { policy: "discovered" }).map(
        (c) => c.jid,
      ),
    ).toEqual(["new@s.whatsapp.net"]);
  });

  it("orders by recent activity and caps the page at 200", () => {
    const db = setup();
    for (let i = 0; i < 250; i += 1) {
      upsertChat(db, {
        accountId: "acct",
        jid: `c${i}@s.whatsapp.net`,
        lastMessageTs: i,
      });
    }
    const page = listDashboardChats(db, "acct", { limit: 500 });
    expect(page).toHaveLength(200);
    expect(page[0]?.jid).toBe("c249@s.whatsapp.net");
  });
});
