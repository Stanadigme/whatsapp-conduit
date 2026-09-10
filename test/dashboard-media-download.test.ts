import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  setChatAllowed,
  upsertAccount,
  upsertAttachment,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import { ModelDownloader } from "../src/dashboard/models.js";
import { createSqliteReader } from "../src/db/sqlite-reader.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { ensureDashboardToken } from "../src/dashboard/token.js";

describe("dashboard media download", () => {
  it("streams an allowed stored attachment without exposing its path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-media-"));
    const config = resolveConfig({}, { dataDir: dir });
    const db = openDb(":memory:", { migrate: true });
    const accountId = "personal";
    const chatJid = "33600000000@s.whatsapp.net";
    const messageId = "MEDIA-1";
    upsertAccount(db, { id: accountId });
    upsertChat(db, { accountId, jid: chatJid });
    setChatAllowed(db, accountId, chatJid, true);
    upsertMessage(db, { accountId, chatJid, messageId, hasMedia: true });
    mkdirSync(config.paths.mediaDir, { recursive: true });
    const path = join(config.paths.mediaDir, "photo.jpg");
    writeFileSync(path, "private bytes");
    upsertAttachment(db, {
      accountId,
      chatJid,
      messageId,
      mediaType: "image",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
      filePath: path,
      sizeBytes: 13,
      downloadedAt: 1_700_000_000,
    });
    const token = ensureDashboardToken(config.web.tokenFile);
    const dashboard = await createDashboardServer(config, {
      db,
      reader: createSqliteReader(db, config, accountId),
      config,
      configPath: join(dir, "config.yaml"),
      models: new ModelDownloader(join(dir, "models")),
      accountId,
      pairing: { status: "disabled", qr: null, error: null },
      startPairing: async () => undefined,
      stopPairing: async () => undefined,
    });
    await new Promise<void>((resolve) =>
      dashboard.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = dashboard.server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/chats/${encodeURIComponent(chatJid)}/messages/${messageId}/attachments/0/download`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain(
        "photo.jpg",
      );
      expect(response.headers.get("content-disposition")).not.toContain(path);
      expect(await response.text()).toBe("private bytes");
    } finally {
      await new Promise<void>((resolve) =>
        dashboard.server.close(() => resolve()),
      );
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
