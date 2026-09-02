import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { listDashboardChats } from "../src/dashboard/chats.js";
import { upsertAccount, upsertChat } from "../src/db/queries.js";
import { DirectorySync } from "../src/whatsmeow/directory.js";
import { createLogger } from "../src/util/logging.js";
import type { DirectoryReadTransport } from "../src/transport/types.js";

interface Participant {
  jid: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

class BigGroupTransport extends EventEmitter {
  constructor(private readonly participants: Participant[]) {
    super();
  }

  private group() {
    return {
      jid: "120@g.us",
      name: "Grand groupe",
      announce: false,
      locked: false,
      ephemeral: false,
      participants: this.participants,
    };
  }

  async getJoinedGroups() {
    return [this.group()];
  }

  async getGroupInfo() {
    return this.group();
  }

  async getUserInfo(jids: string[]) {
    return Object.fromEntries(
      jids.map((jid) => [
        jid,
        { status: "", pictureID: "", verifiedName: `V:${jid}` },
      ]),
    );
  }
}

/**
 * The alpha was only ever exercised against ~34 chats, which is why three
 * unindexed loops reached a real account before anyone noticed.
 *
 * Correctness is asserted on counters rather than on the clock. A wall-clock
 * budget would be the obvious guard, but the failure mode it guards against is
 * a starved event loop: on the pre-fix code this workload does not finish in
 * ten minutes, so a regression would hang CI instead of failing it. The
 * indexed-lookup shape is pinned in directory-lookup.test.ts, where a query
 * plan answers the same question instantly.
 */
describe("directory at realistic volume", () => {
  it("lists a dashboard page over ~1000 chats quickly", () => {
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: "acct" });
    const seed = db.transaction(() => {
      for (let i = 0; i < 1_000; i += 1) {
        upsertChat(db, {
          accountId: "acct",
          jid: `chat${i}@s.whatsapp.net`,
          name: `Contact ${i}`,
          lastMessageTs: i,
        });
      }
    });
    seed();

    const started = Date.now();
    const page = listDashboardChats(db, "acct", { query: "contact 4" });
    const elapsed = Date.now() - started;

    expect(page.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2_000);
    db.close();
  });

  it("persists a 200-member group without rewriting the group per member", async () => {
    const participants: Participant[] = Array.from(
      { length: 200 },
      (_, index) => ({
        jid: `member${index}@s.whatsapp.net`,
        isAdmin: false,
        isSuperAdmin: false,
      }),
    );
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: "acct" });
    // A real account already holds thousands of directory entries by the time
    // groups are synced. Without them the unindexed lookup has nothing to scan
    // and the regression stays invisible — exactly why the 34-chat fixture
    // missed it.
    const seed = db.transaction(() => {
      const insert = db.prepare(
        `insert into directory_entities
           (account_id, entity_type, canonical_jid, name, first_seen_at, updated_at)
         values ('acct', 'contact', @jid, @name, 1, 1)`,
      );
      const alias = db.prepare(
        `insert into directory_aliases
           (account_id, alias_jid, entity_id, alias_type, first_seen_at, updated_at)
         values ('acct', @jid, last_insert_rowid(), 'canonical', 1, 1)`,
      );
      for (let i = 0; i < 1_000; i += 1) {
        const jid = `seed${i}@s.whatsapp.net`;
        insert.run({ jid, name: `Seed ${i}` });
        alias.run({ jid });
      }
    });
    seed();

    // Count writes to the group row directly: the redundant upsert rewrote it
    // once per participant, which no timing or row-count assertion pins down.
    db.exec(`
      create table _group_writes (n integer);
      insert into _group_writes values (0);
      create trigger _count_group_updates after update on directory_entities
      when new.entity_type = 'group'
      begin update _group_writes set n = n + 1; end;
    `);

    const directory = new DirectorySync({
      db,
      accountId: "acct",
      logger: createLogger({ level: "fatal" }),
      transport: new BigGroupTransport(
        participants,
      ) as unknown as DirectoryReadTransport,
    });

    await directory.syncJoinedGroups();

    const writes = db.prepare("select n from _group_writes").get() as {
      n: number;
    };
    expect(writes.n).toBeLessThanOrEqual(3);

    const members = db
      .prepare(
        `select count(*) as n from directory_group_members
         where account_id = 'acct' and is_active = 1`,
      )
      .get() as { n: number };
    expect(members.n).toBe(200);

    const group = db
      .prepare(
        `select name, entity_type from directory_entities
         where account_id = 'acct' and canonical_jid = '120@g.us'`,
      )
      .get() as { name: string; entity_type: string };
    expect(group).toEqual({ name: "Grand groupe", entity_type: "group" });
    db.close();
  });
});
