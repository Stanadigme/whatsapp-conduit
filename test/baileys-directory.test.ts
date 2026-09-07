import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/util/logging.js";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { getChat, upsertAccount, upsertChat } from "../src/db/queries.js";
import { resyncBaileysDirectory } from "../src/baileys/directory.js";
import type { IngestDeps } from "../src/baileys/ingest.js";

function deps() {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "personal" });
  return {
    db,
    accountId: "personal",
    config: resolveConfig({}, { dataDir: "/data" }),
    logger: createLogger({ level: "fatal" }),
  } satisfies IngestDeps;
}

describe("resyncBaileysDirectory", () => {
  it("re-fetches the app-state name collections and group subjects", async () => {
    const d = deps();
    upsertChat(d.db, {
      accountId: "personal",
      jid: "120@g.us",
      isGroup: true,
    });
    upsertChat(d.db, {
      accountId: "personal",
      jid: "121@g.us",
      isGroup: true,
    });

    const resyncAppState = vi.fn().mockResolvedValue(undefined);
    const groupMetadata = vi.fn(async (jid: string) => ({
      id: jid,
      subject: jid === "120@g.us" ? "Équipe produit" : "  ",
    }));

    const result = await resyncBaileysDirectory(
      { resyncAppState, groupMetadata } as never,
      d,
    );

    expect(resyncAppState).toHaveBeenCalledWith(
      [
        "critical_block",
        "critical_unblock_low",
        "regular_high",
        "regular_low",
        "regular",
      ],
      true,
    );
    expect(groupMetadata).toHaveBeenCalledTimes(2);
    expect(getChat(d.db, "personal", "120@g.us")?.name).toBe("Équipe produit");
    expect(getChat(d.db, "personal", "121@g.us")?.name ?? null).toBeNull();
    expect(result.groups).toBe(1);
    d.db.close();
  });

  it("survives an app-state resync failure and still refreshes groups", async () => {
    const d = deps();
    upsertChat(d.db, { accountId: "personal", jid: "120@g.us", isGroup: true });

    const result = await resyncBaileysDirectory(
      {
        resyncAppState: vi.fn().mockRejectedValue(new Error("no sync key")),
        groupMetadata: vi.fn(async () => ({
          id: "120@g.us",
          subject: "Support",
        })),
      } as never,
      d,
    );

    expect(getChat(d.db, "personal", "120@g.us")?.name).toBe("Support");
    expect(result.groups).toBe(1);
    d.db.close();
  });

  it("surfaces a group refresh failure during a strict rebuild", async () => {
    const d = deps();
    upsertChat(d.db, { accountId: "personal", jid: "120@g.us", isGroup: true });

    await expect(
      resyncBaileysDirectory(
        {
          resyncAppState: vi.fn().mockResolvedValue(undefined),
          groupMetadata: vi.fn().mockRejectedValue(new Error("not connected")),
        } as never,
        d,
        { strict: true },
      ),
    ).rejects.toThrow("not connected");
    d.db.close();
  });
});
