import { describe, expect, it } from "vitest";
import { openDb, type Database } from "../src/db/index.js";
import {
  getDirectoryEntityByJid,
  upsertDirectoryContact,
  upsertDirectoryGroup,
} from "../src/db/directory.js";
import { upsertAccount } from "../src/db/queries.js";

function setup(): Database {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "acct" });
  return db;
}

/**
 * The regression this guards against is a lookup that cannot use an index. A
 * query plan is the stable observable: it does not depend on how much data the
 * test seeds, and it does not turn into a wall-clock flake in CI.
 */
function planFor(db: Database, sql: string, params: unknown): string {
  const steps = db.prepare(`explain query plan ${sql}`).all(params) as Array<{
    detail: string;
  }>;
  return steps.map((step) => step.detail).join("\n");
}

describe("getDirectoryEntityByJid query plans", () => {
  it("resolves a canonical JID without scanning", () => {
    const db = setup();
    const plan = planFor(
      db,
      `select * from directory_entities
       where account_id = @accountId and canonical_jid = @jid
         and entity_type = @type
       limit 1`,
      { accountId: "acct", jid: "491234@s.whatsapp.net", type: "contact" },
    );
    expect(plan).not.toMatch(/SCAN/);
    expect(plan).toMatch(/SEARCH/);
  });

  it("resolves an alias JID without scanning", () => {
    const db = setup();
    const plan = planFor(
      db,
      `select e.* from directory_aliases a
       join directory_entities e on e.id = a.entity_id
       where a.account_id = @accountId and a.alias_jid = @jid
         and e.entity_type = @type
       limit 1`,
      { accountId: "acct", jid: "9001@lid", type: "contact" },
    );
    expect(plan).not.toMatch(/SCAN/);
    expect(plan).toMatch(/SEARCH/);
  });

  it("would scan with the cross-table `or` this replaced", () => {
    const db = setup();
    // Pinned so the old shape cannot quietly come back: an `or` spanning the
    // join is exactly what defeated every index.
    const plan = planFor(
      db,
      `select e.* from directory_entities e
       left join directory_aliases a on a.entity_id = e.id
       where e.account_id = @accountId
         and (e.canonical_jid = @jid or a.alias_jid = @jid)
       limit 1`,
      { accountId: "acct", jid: "491234@s.whatsapp.net" },
    );
    expect(plan).toMatch(/SCAN/);
  });
});

describe("getDirectoryEntityByJid semantics", () => {
  it("returns undefined for an unknown JID", () => {
    const db = setup();
    expect(
      getDirectoryEntityByJid(db, "acct", "404@s.whatsapp.net"),
    ).toBeUndefined();
  });

  it("resolves a contact through its LID alias", () => {
    const db = setup();
    upsertDirectoryContact(db, {
      accountId: "acct",
      jid: "491234@s.whatsapp.net",
      lid: "9001@lid",
      displayName: "Amelie",
    });
    const viaLid = getDirectoryEntityByJid(db, "acct", "9001@lid");
    expect(viaLid?.canonical_jid).toBe("491234@s.whatsapp.net");
    expect(viaLid?.name).toBe("Amelie");
  });

  it("prefers the canonical row over an alias pointing elsewhere", () => {
    const db = setup();
    // "shared@s.whatsapp.net" is the canonical JID of one contact and, at the
    // same time, an alias of another. The canonical match must win.
    upsertDirectoryContact(db, {
      accountId: "acct",
      jid: "shared@s.whatsapp.net",
      displayName: "Canonical",
    });
    upsertDirectoryContact(db, {
      accountId: "acct",
      jid: "other@s.whatsapp.net",
      displayName: "ViaAlias",
    });
    const other = getDirectoryEntityByJid(db, "acct", "other@s.whatsapp.net");
    db.prepare(
      `insert into directory_aliases
         (account_id, alias_jid, entity_id, alias_type, first_seen_at, updated_at)
       values ('acct', 'shared@s.whatsapp.net', @id, 'lid', 1, 1)
       on conflict (account_id, alias_jid) do update set entity_id = excluded.entity_id`,
    ).run({ id: other?.id });

    const resolved = getDirectoryEntityByJid(
      db,
      "acct",
      "shared@s.whatsapp.net",
    );
    expect(resolved?.name).toBe("Canonical");
  });

  it("honors the type filter on both the canonical and the alias path", () => {
    const db = setup();
    upsertDirectoryGroup(db, {
      accountId: "acct",
      jid: "120@g.us",
      name: "Equipe",
    });
    expect(getDirectoryEntityByJid(db, "acct", "120@g.us", "group")?.name).toBe(
      "Equipe",
    );
    // Same JID, wrong type: the canonical row must not leak through.
    expect(
      getDirectoryEntityByJid(db, "acct", "120@g.us", "contact"),
    ).toBeUndefined();
  });

  it("falls back to the alias when the canonical row has the wrong type", () => {
    const db = setup();
    upsertDirectoryGroup(db, { accountId: "acct", jid: "dual@g.us" });
    upsertDirectoryContact(db, {
      accountId: "acct",
      jid: "person@s.whatsapp.net",
      displayName: "Person",
    });
    const person = getDirectoryEntityByJid(
      db,
      "acct",
      "person@s.whatsapp.net",
      "contact",
    );
    db.prepare(
      `insert into directory_aliases
         (account_id, alias_jid, entity_id, alias_type, first_seen_at, updated_at)
       values ('acct', 'dual@g.us', @id, 'lid', 1, 1)
       on conflict (account_id, alias_jid) do update set entity_id = excluded.entity_id`,
    ).run({ id: person?.id });

    // Asking for a contact skips the group canonical row and takes the alias.
    expect(
      getDirectoryEntityByJid(db, "acct", "dual@g.us", "contact")?.name,
    ).toBe("Person");
    expect(
      getDirectoryEntityByJid(db, "acct", "dual@g.us", "group")?.canonical_jid,
    ).toBe("dual@g.us");
  });
});
