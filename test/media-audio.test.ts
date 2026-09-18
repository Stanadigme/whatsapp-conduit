import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WASocket, WAMessage } from "baileys";
import type * as BaileysNS from "baileys";
import { ingestMessage, type IngestDeps } from "../src/baileys/ingest.js";
import { downloadAudioIfEnabled } from "../src/baileys/media.js";
import { resolveConfig, type Config } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  getAttachment,
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
} from "../src/db/queries.js";
import type { NormalizedMessage } from "../src/ingest/types.js";
import { persistAudioIfEnabled } from "../src/ingest/audio.js";
import { createLogger } from "../src/util/logging.js";

const gcsMock = vi.hoisted(() => ({
  getOrCreateGcsBucket: vi.fn(() => ({ marker: "fake-bucket" })),
  uploadMediaToGcs: vi.fn(async () => undefined),
  gcsObjectKey: vi.fn(
    (accountId: string, sha256: string) => `${accountId}/${sha256}`,
  ),
}));
vi.mock("../src/db/gcs.js", () => gcsMock);

const baileysMock = vi.hoisted(() => ({ downloadMediaMessage: vi.fn() }));
vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof BaileysNS>();
  return { ...actual, downloadMediaMessage: baileysMock.downloadMediaMessage };
});

const CHAT = "c@s.whatsapp.net";

function audioMessage(seconds: number): WAMessage {
  return {
    key: { remoteJid: CHAT, fromMe: false, id: "AUDIO1" },
    messageTimestamp: 1700,
    pushName: "Alice",
    message: {
      audioMessage: { seconds, mimetype: "audio/ogg; codecs=opus" },
    },
  } as WAMessage;
}

/**
 * Ingest a real audio message so the `messages` row exists — `attachments`
 * carries a foreign key onto it, which is why downloads only ever start after
 * persistence.
 */
function setup(
  root: string,
  overrides: Record<string, unknown> = {},
  seconds = 3,
): { deps: IngestDeps; stored: NormalizedMessage } {
  const config: Config = resolveConfig(
    { paths: { data_dir: root }, ...overrides },
    { dataDir: root },
  );
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "personal" });
  const deps: IngestDeps = {
    db,
    accountId: "personal",
    config,
    logger: createLogger({ level: "error" }),
  };
  const stored = ingestMessage(deps, audioMessage(seconds));
  // Media is only fetched for authorised chats, so the fixture has to be one.
  setChatAllowed(db, "personal", CHAT, true);
  if (!stored) throw new Error("expected the audio message to be stored");
  return { deps, stored };
}

/** A source backed by a real scratch file, counting how often it is fetched. */
function source(root: string, payload = "audio payload") {
  let fetches = 0;
  return {
    get fetches() {
      return fetches;
    },
    source: {
      mimeType: "audio/ogg; codecs=opus",
      fileName: null,
      expectedBytes: null,
      fetch: async (): Promise<string> => {
        fetches += 1;
        const path = join(root, `scratch-${String(fetches)}.opus`);
        await writeFile(path, Buffer.from(payload));
        return path;
      },
    },
  };
}

beforeEach(() => {
  baileysMock.downloadMediaMessage.mockReset();
});

describe("shared audio persistence", () => {
  it("downloads once, content-addresses the file, and records the row", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);
    await persistAudioIfEnabled(fake.source, stored, deps);

    const attachment = getAttachment(deps.db, "personal", CHAT, "AUDIO1");
    expect(fake.fetches).toBe(1);
    expect(attachment?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attachment?.file_path).toContain(attachment?.sha256 ?? "never");
    expect(attachment?.size_bytes).toBe(13);
    await expect(readFile(attachment?.file_path ?? "", "utf8")).resolves.toBe(
      "audio payload",
    );
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("does nothing when store_media is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root);
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);

    expect(fake.fetches).toBe(0);
    expect(getAttachment(deps.db, "personal", CHAT, "AUDIO1")).toBeUndefined();
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("skips a declared size over the cap without spending bandwidth", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, {
      privacy: { store_media: true },
      media: { max_audio_bytes: 4 },
    });
    const fake = source(root);

    await persistAudioIfEnabled(
      { ...fake.source, expectedBytes: 5_000 },
      stored,
      deps,
    );

    expect(fake.fetches).toBe(0);
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a payload that exceeds the cap once measured", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, {
      privacy: { store_media: true },
      media: { max_audio_bytes: 4, max_attempts: 1 },
    });
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);

    // Metadata is kept, but nothing is stored and no scratch file survives.
    const attachment = getAttachment(deps.db, "personal", CHAT, "AUDIO1");
    expect(attachment?.file_path).toBeNull();
    expect(await readdir(join(root, "media")).catch(() => [])).toEqual([]);
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("skips a voice note longer than the duration cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(
      root,
      { privacy: { store_media: true }, media: { max_audio_duration_s: 10 } },
      60,
    );
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);

    expect(fake.fetches).toBe(0);
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("persists a non-audio attachment through the same bounded path", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-media-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    const fake = source(root, "image payload");

    await persistAudioIfEnabled(
      {
        ...fake.source,
        mediaType: "image",
        mimeType: "image/jpeg",
        fileName: "photo.jpg",
      },
      { ...stored, messageType: "image", durationS: null },
      deps,
    );

    expect(getAttachment(deps.db, "personal", CHAT, "AUDIO1")).toMatchObject({
      media_type: "image",
      mime_type: "image/jpeg",
      file_name: "photo.jpg",
    });
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("collapses a concurrent duplicate delivery into one download", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    const fake = source(root);

    // Baileys delivers the same message as `notify` then `append`; both land
    // before either has written `downloaded_at`.
    await Promise.all([
      persistAudioIfEnabled(fake.source, stored, deps),
      persistAudioIfEnabled(fake.source, stored, deps),
    ]);

    expect(fake.fetches).toBe(1);
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("never downloads media for a chat that is not allowed", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    // Discovery keeps a chat's messages before anyone reviews it. Its media is
    // another matter: it is never exposed, never transcribed, and nothing
    // evicts it, so it must not reach the disk at all.
    setChatAllowed(deps.db, "personal", CHAT, false);
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);

    expect(fake.fetches).toBe(0);
    expect(
      getAttachment(deps.db, "personal", stored.chatJid, stored.messageId),
    ).toBeUndefined();
    expect(await readdir(join(root, "media")).catch(() => [])).toEqual([]);
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("never downloads media for a blocked chat, even when allowed", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    // Blocking wins over allowing, exactly as it does on the read path.
    setChatBlocked(deps.db, "personal", CHAT, true);
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);

    expect(fake.fetches).toBe(0);
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });
});

describe("GCS upload (phase 3, ADR-0033)", () => {
  it("uploads and records gcs_uploaded_at once persistence.gcs is configured", async () => {
    gcsMock.uploadMediaToGcs.mockClear();
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, {
      privacy: { store_media: true },
      persistence: {
        gcs: { bucket: "test-bucket", credentials_file: join(root, "creds.json") },
      },
    });
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);

    expect(gcsMock.uploadMediaToGcs).toHaveBeenCalledTimes(1);
    const attachment = getAttachment(deps.db, "personal", CHAT, "AUDIO1");
    expect(attachment?.gcs_uploaded_at).toEqual(expect.any(Number));
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("does not attempt an upload without persistence.gcs configured", async () => {
    gcsMock.uploadMediaToGcs.mockClear();
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);

    expect(gcsMock.uploadMediaToGcs).not.toHaveBeenCalled();
    const attachment = getAttachment(deps.db, "personal", CHAT, "AUDIO1");
    expect(attachment?.gcs_uploaded_at).toBeNull();
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the local file and does not throw when the upload fails", async () => {
    gcsMock.uploadMediaToGcs.mockRejectedValueOnce(new Error("bucket unreachable"));
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, {
      privacy: { store_media: true },
      persistence: {
        gcs: { bucket: "test-bucket", credentials_file: join(root, "creds.json") },
      },
    });
    const fake = source(root);

    await persistAudioIfEnabled(fake.source, stored, deps);

    const attachment = getAttachment(deps.db, "personal", CHAT, "AUDIO1");
    expect(attachment?.gcs_uploaded_at).toBeNull();
    // The local, already-downloaded copy is unaffected by a failed upload.
    expect(attachment?.downloaded_at).toEqual(expect.any(Number));
    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });
});

describe("downloadAudioIfEnabled reuploadRequest (ADR-0039)", () => {
  function fakeSocket(): WASocket {
    return {
      updateMediaMessage: vi.fn(async (message: WAMessage) => message),
    } as unknown as WASocket;
  }

  it("passes a reuploadRequest bound to sock.updateMediaMessage when a socket is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    const sock = fakeSocket();
    baileysMock.downloadMediaMessage.mockResolvedValue(
      Readable.from([Buffer.from("audio bytes")]),
    );

    await downloadAudioIfEnabled(
      { key: { remoteJid: CHAT, fromMe: false, id: "AUDIO1" }, message: { audioMessage: { seconds: 3 } } } as WAMessage,
      stored,
      deps,
      sock,
    );

    expect(baileysMock.downloadMediaMessage).toHaveBeenCalledTimes(1);
    const ctx = baileysMock.downloadMediaMessage.mock.calls[0]?.[3] as
      | { reuploadRequest: (m: WAMessage) => unknown; logger: unknown }
      | undefined;
    expect(ctx).toBeDefined();
    const dummy = { key: { id: "X" } } as unknown as WAMessage;
    await ctx?.reuploadRequest(dummy);
    expect(sock.updateMediaMessage).toHaveBeenCalledWith(dummy);

    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("asks the phone to reupload on a 404/410 Boom and downloads again (ADR-0039)", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    const refreshed = {
      key: { remoteJid: CHAT, fromMe: false, id: "AUDIO1" },
      message: { audioMessage: { seconds: 3, url: "refreshed" } },
    } as unknown as WAMessage;
    const sock = {
      updateMediaMessage: vi.fn(async () => refreshed),
    } as unknown as WASocket;
    // Baileys throws a Boom whose status lives in `output.statusCode`; its
    // own retry reads `error.status` and therefore never fires.
    const expired = Object.assign(
      new Error("Failed to fetch stream from https://mmg.whatsapp.net/v/x?oh=SECRET"),
      { output: { statusCode: 404 } },
    );
    baileysMock.downloadMediaMessage
      .mockRejectedValueOnce(expired)
      .mockResolvedValueOnce(Readable.from([Buffer.from("audio bytes")]));

    await downloadAudioIfEnabled(
      { key: { remoteJid: CHAT, fromMe: false, id: "AUDIO1" }, message: { audioMessage: { seconds: 3 } } } as WAMessage,
      stored,
      deps,
      sock,
    );

    expect(sock.updateMediaMessage).toHaveBeenCalledTimes(1);
    expect(baileysMock.downloadMediaMessage).toHaveBeenCalledTimes(2);
    expect(baileysMock.downloadMediaMessage.mock.calls[1]?.[0]).toBe(refreshed);
    const attachment = getAttachment(deps.db, "personal", CHAT, "AUDIO1");
    expect(attachment?.downloaded_at).not.toBeNull();

    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("omits the reupload context entirely when no socket is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, { privacy: { store_media: true } });
    baileysMock.downloadMediaMessage.mockResolvedValue(
      Readable.from([Buffer.from("audio bytes")]),
    );

    await downloadAudioIfEnabled(
      { key: { remoteJid: CHAT, fromMe: false, id: "AUDIO1" }, message: { audioMessage: { seconds: 3 } } } as WAMessage,
      stored,
      deps,
    );

    expect(baileysMock.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(baileysMock.downloadMediaMessage.mock.calls[0]?.[3]).toBeUndefined();

    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it("strips the mmg.whatsapp.net access token from a failed download before it is stored", async () => {
    const root = await mkdtemp(join(tmpdir(), "conduit-audio-"));
    const { deps, stored } = setup(root, {
      privacy: { store_media: true },
      media: { max_attempts: 1 },
    });
    baileysMock.downloadMediaMessage.mockRejectedValue(
      new Error(
        "Failed to fetch stream from https://mmg.whatsapp.net/v/t62/abc?ccb=9-4&oh=SECRET_TOKEN&oe=6720",
      ),
    );

    await downloadAudioIfEnabled(
      { key: { remoteJid: CHAT, fromMe: false, id: "AUDIO1" }, message: { audioMessage: { seconds: 3 } } } as WAMessage,
      stored,
      deps,
    );

    const attachment = getAttachment(deps.db, "personal", CHAT, "AUDIO1");
    expect(attachment?.download_last_error).toBe(
      "Failed to fetch stream from https://mmg.whatsapp.net/v/t62/abc",
    );
    expect(attachment?.download_last_error).not.toContain("SECRET_TOKEN");

    deps.db.close();
    await rm(root, { recursive: true, force: true });
  });
});
