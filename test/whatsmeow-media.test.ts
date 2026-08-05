import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig, type Config } from "../src/config.js";
import {
  ingestNormalizedResult,
  type IngestDeps,
} from "../src/baileys/ingest.js";
import { openDb } from "../src/db/index.js";
import { getAttachment, upsertAccount } from "../src/db/queries.js";
import { downloadAudioIfEnabled } from "../src/whatsmeow/media.js";
import { normalizeWhatsmeowMessage } from "../src/whatsmeow/normalize.js";
import { createLogger } from "../src/util/logging.js";
import type { WhatsmeowTransport } from "../src/whatsmeow/transport.js";

function event() {
  return {
    info: {
      id: "AUDIO1",
      chat: "25954537754701@lid",
      sender: "25954537754701@lid",
      isFromMe: false,
      isGroup: false,
      timestamp: 1_700_000_000,
      pushName: "Contact",
    },
    message: {
      audioMessage: {
        seconds: 3,
        mimetype: "audio/ogg; codecs=opus",
      },
    },
  } as never;
}

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

describe("whatsmeow audio media worker", () => {
  it("stores metadata first and downloads an enabled audio attachment once", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-conduit-media-"));
    const source = join(root, "source.opus");
    await writeFile(source, Buffer.from("audio payload"));
    const config = resolveConfig(
      { privacy: { store_media: true }, paths: { data_dir: root } },
      { dataDir: root },
    );
    const depsForTest = deps(config);
    const inbound = event();
    const normalized = normalizeWhatsmeowMessage(inbound);
    if (normalized.action !== "store") throw new Error("expected audio");
    expect(ingestNormalizedResult(depsForTest, normalized, null)).toBe(true);

    let downloads = 0;
    const transport = {
      downloadAny: async () => {
        downloads += 1;
        return source;
      },
    } as unknown as WhatsmeowTransport;

    await downloadAudioIfEnabled(
      transport,
      inbound,
      normalized.message,
      depsForTest,
    );
    await downloadAudioIfEnabled(
      transport,
      inbound,
      normalized.message,
      depsForTest,
    );

    const attachment = getAttachment(
      depsForTest.db,
      "personal",
      "25954537754701@lid",
      "AUDIO1",
    );
    expect(downloads).toBe(1);
    expect(attachment?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attachment?.file_path).toBeTruthy();
    await expect(readFile(attachment?.file_path ?? "", "utf8")).resolves.toBe(
      "audio payload",
    );
    depsForTest.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("does not call the transport when media storage is disabled", async () => {
    const config = resolveConfig({}, { dataDir: "/data" });
    const depsForTest = deps(config);
    const inbound = event();
    const normalized = normalizeWhatsmeowMessage(inbound);
    if (normalized.action !== "store") throw new Error("expected audio");
    ingestNormalizedResult(depsForTest, normalized, null);
    let downloads = 0;
    const transport = {
      downloadAny: async () => {
        downloads += 1;
        return "never";
      },
    } as unknown as WhatsmeowTransport;

    await downloadAudioIfEnabled(
      transport,
      inbound,
      normalized.message,
      depsForTest,
    );

    expect(downloads).toBe(0);
    depsForTest.db.close();
  });
});
