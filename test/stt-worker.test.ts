import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DestinationStream } from "pino";

// The worker shells out to ffmpeg; the conversion itself is not under test.
vi.mock("../src/util/exec.js", () => ({
  execCapture: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
}));

import { resolveConfig, type Config } from "../src/config.js";
import { openDb, type Database } from "../src/db/index.js";
import {
  getTranscriptionJob,
  insertTranscription,
  setChatAllowed,
  upsertAccount,
  upsertAttachment,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import type { SttAdapter } from "../src/stt/types.js";
import { createWhisperAdapter } from "../src/stt/whisper.js";
import { readSttStatus, writeSttStatus } from "../src/stt/status.js";
import { transcribeOnce } from "../src/stt/worker.js";
import { createLogger } from "../src/util/logging.js";

const ACCOUNT = "personal";
const CHAT = "33600000000@s.whatsapp.net";

function fakeAdapter(
  behavior: { text: string } | { error: string },
  healthy = true,
): SttAdapter {
  return {
    name: "fake",
    capabilities: {
      soundsLike: false,
      maxLexiconTerms: 0,
      maxDurationS: 3600,
      languages: ["fr"],
      diarization: false,
    },
    async transcribe() {
      if ("error" in behavior) throw new Error(behavior.error);
      return {
        textRaw: behavior.text,
        language: "fr",
        engine: "fake",
        engineModel: "fake-1",
        raw: { ok: true },
      };
    },
    async healthCheck() {
      return healthy
        ? { ok: true }
        : { ok: false, detail: "whisper model not readable" };
    },
  };
}

interface Fixture {
  db: Database;
  config: Config;
}

function fixture(
  options: { durationS?: number | null; allowed?: boolean } = {},
): Fixture {
  const { durationS = 12, allowed = true } = options;
  const config = resolveConfig({}, { dataDir: "/data" });
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: ACCOUNT });
  upsertChat(db, { accountId: ACCOUNT, jid: CHAT, name: "Contact" });
  setChatAllowed(db, ACCOUNT, CHAT, allowed);
  upsertMessage(db, {
    accountId: ACCOUNT,
    chatJid: CHAT,
    messageId: "A1",
    senderJid: CHAT,
    timestamp: 1_700_000_000,
    messageType: "audio",
    hasMedia: true,
    durationS,
  });
  upsertAttachment(db, {
    accountId: ACCOUNT,
    chatJid: CHAT,
    messageId: "A1",
    mediaType: "audio",
    mimeType: "audio/ogg; codecs=opus",
    filePath: "/data/media/abc.opus",
    sha256: "abc",
    sizeBytes: 1024,
    downloadedAt: 1_700_000_001,
  });
  return { db, config };
}

function deps(db: Database, config: Config, adapter: SttAdapter) {
  return {
    db,
    config,
    accountId: ACCOUNT,
    adapter,
    logger: createLogger({ level: "fatal" }),
  };
}

function transcriptionRow(db: Database): Record<string, unknown> | undefined {
  return db
    .prepare("select * from transcriptions where message_id = 'A1'")
    .get() as Record<string, unknown> | undefined;
}

describe("transcription worker", () => {
  it("transcribes a downloaded voice note and marks the job done", async () => {
    const { db, config } = fixture();
    const pass = await transcribeOnce(
      deps(db, config, fakeAdapter({ text: "bonjour au doux" })),
    );

    expect(pass).toEqual({ done: 1, failed: 0, skipped: 0 });
    const row = transcriptionRow(db);
    expect(row?.text_raw).toBe("bonjour au doux");
    expect(row?.engine).toBe("fake");
    expect(row?.audio_sha256).toBe("abc");
    // No lexicon layer yet: the corrected column stays empty on purpose.
    expect(row?.text_corrected).toBeNull();
    expect(getTranscriptionJob(db, ACCOUNT, CHAT, "A1")?.status).toBe("done");
    db.close();
  });

  it("does not re-transcribe an already transcribed message", async () => {
    const { db, config } = fixture();
    await transcribeOnce(deps(db, config, fakeAdapter({ text: "premier" })));
    const pass = await transcribeOnce(
      deps(db, config, fakeAdapter({ text: "second" })),
    );

    expect(pass.done).toBe(0);
    expect(transcriptionRow(db)?.text_raw).toBe("premier");
    db.close();
  });

  it("never overwrites text_raw", () => {
    const { db } = fixture();
    insertTranscription(db, {
      accountId: ACCOUNT,
      chatJid: CHAT,
      messageId: "A1",
      textRaw: "original",
      engine: "fake",
    });
    const written = insertTranscription(db, {
      accountId: ACCOUNT,
      chatJid: CHAT,
      messageId: "A1",
      textRaw: "clobbered",
      engine: "fake",
    });

    expect(written).toBe(false);
    expect(transcriptionRow(db)?.text_raw).toBe("original");
    db.close();
  });

  it("counts attempts and gives up after max_attempts", async () => {
    const { db, config } = fixture();
    const failing = fakeAdapter({ error: "engine exploded" });

    for (let i = 0; i < config.stt.maxAttempts; i += 1) {
      const pass = await transcribeOnce(deps(db, config, failing));
      expect(pass.failed).toBe(1);
    }
    const job = getTranscriptionJob(db, ACCOUNT, CHAT, "A1");
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(config.stt.maxAttempts);
    expect(job?.reason).toBe("engine exploded");

    // Exhausted: no longer a candidate.
    const after = await transcribeOnce(deps(db, config, failing));
    expect(after).toEqual({ done: 0, failed: 0, skipped: 0 });
    db.close();
  });

  it("skips audio longer than the configured maximum", async () => {
    const { db, config } = fixture({ durationS: 4000 });
    const pass = await transcribeOnce(
      deps(db, config, fakeAdapter({ text: "never" })),
    );

    expect(pass).toEqual({ done: 0, failed: 0, skipped: 1 });
    expect(getTranscriptionJob(db, ACCOUNT, CHAT, "A1")?.reason).toBe(
      "audio too long",
    );
    expect(transcriptionRow(db)).toBeUndefined();
    db.close();
  });

  it("skips sub-second audio, where Whisper hallucinates", async () => {
    const { db, config } = fixture({ durationS: 0 });
    const pass = await transcribeOnce(
      deps(db, config, fakeAdapter({ text: "never" })),
    );

    expect(pass.skipped).toBe(1);
    expect(getTranscriptionJob(db, ACCOUNT, CHAT, "A1")?.reason).toBe(
      "audio too short",
    );
    db.close();
  });

  it("ignores voice notes from chats that are not allowed", async () => {
    const { db, config } = fixture({ allowed: false });
    const pass = await transcribeOnce(
      deps(db, config, fakeAdapter({ text: "never" })),
    );

    expect(pass).toEqual({ done: 0, failed: 0, skipped: 0 });
    expect(transcriptionRow(db)).toBeUndefined();
    db.close();
  });

  it("keeps transcript text out of the logs", async () => {
    const { db, config } = fixture();
    const records: string[] = [];
    const stream: DestinationStream = {
      write(chunk: string) {
        records.push(chunk);
      },
    };
    const logger = createLogger({ level: "debug" }, stream);
    const secret = "code confidentiel trente-sept";

    await transcribeOnce({
      db,
      config,
      accountId: ACCOUNT,
      adapter: fakeAdapter({ text: secret }),
      logger,
    });
    // And once more with a failing engine, the noisier path.
    await transcribeOnce({
      db,
      config,
      accountId: ACCOUNT,
      adapter: fakeAdapter({ error: "boom" }),
      logger,
    });

    expect(records.join("")).not.toContain(secret);
    db.close();
  });
});

describe("whisper adapter", () => {
  const whisper = {
    binaryPath: "whisper-cli",
    modelPath: "/models/ggml-large-v3-turbo.bin",
  };

  it("calls whisper-cli with an explicit language and returns its output", async () => {
    const { execCapture } = await import("../src/util/exec.js");
    vi.mocked(execCapture).mockResolvedValueOnce({
      code: 0,
      stdout: "  bonjour au doux  \n",
      stderr: "",
    });
    const adapter = createWhisperAdapter(whisper);

    const result = await adapter.transcribe({
      audioPath: "/tmp/audio.wav",
      durationS: 12,
      language: "fr",
      lexicon: [],
      lexiconVersion: 0,
    });

    expect(result.textRaw).toBe("bonjour au doux");
    expect(result.engineModel).toBe("large-v3-turbo");
    const call = vi.mocked(execCapture).mock.calls.at(-1);
    const args = call?.[1] ?? [];
    expect(call?.[0]).toBe("whisper-cli");
    // The language is forced: auto-detection is unreliable on short clips.
    expect(args[args.indexOf("-l") + 1]).toBe("fr");
    expect(args).toContain("-nt");
  });

  it("fails loudly on a non-zero exit without echoing stderr", async () => {
    const { execCapture } = await import("../src/util/exec.js");
    vi.mocked(execCapture).mockResolvedValueOnce({
      code: 3,
      stdout: "",
      stderr: "fragment de transcription",
    });
    const adapter = createWhisperAdapter(whisper);

    await expect(
      adapter.transcribe({
        audioPath: "/tmp/audio.wav",
        durationS: 12,
        lexicon: [],
        lexiconVersion: 0,
      }),
    ).rejects.toThrow(/exited with code 3$/);
  });

  it("reports a missing model rather than failing at the first job", async () => {
    const adapter = createWhisperAdapter({
      ...whisper,
      modelPath: "/models/absent.bin",
    });

    await expect(adapter.healthCheck()).resolves.toEqual({
      ok: false,
      detail: "whisper model not readable at /models/absent.bin",
    });
  });
});

describe("engine availability", () => {
  it("leaves pending voice notes alone when the engine is unusable", async () => {
    const { db, config } = fixture();
    const pass = await transcribeOnce(
      deps(db, config, fakeAdapter({ text: "never" }, false)),
    );

    expect(pass.blocked).toContain("whisper model not readable");
    expect(pass).toMatchObject({ done: 0, failed: 0, skipped: 0 });
    // No job row at all: burning attempts against a missing model would mark
    // the message failed for good, and installing the model later would not
    // bring it back.
    expect(getTranscriptionJob(db, ACCOUNT, CHAT, "A1")).toBeUndefined();
    expect(transcriptionRow(db)).toBeUndefined();
    db.close();
  });

  it("does not check the engine when there is nothing to do", async () => {
    const { db, config } = fixture({ allowed: false });
    const pass = await transcribeOnce(
      deps(db, config, fakeAdapter({ text: "never" }, false)),
    );

    expect(pass.blocked).toBeUndefined();
    db.close();
  });
});

describe("worker heartbeat", () => {
  it("round-trips a status stamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wac-stt-status-"));
    try {
      const path = join(dir, "stt-status.json");
      expect(await readSttStatus(path)).toBeNull();

      await writeSttStatus(path, {
        enabled: true,
        engine: "whisper-local",
        lastError: null,
      });
      const status = await readSttStatus(path);

      expect(status).toMatchObject({ enabled: true, engine: "whisper-local" });
      expect(status?.lastPassAt).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a corrupt stamp as no stamp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wac-stt-status-"));
    try {
      const path = join(dir, "stt-status.json");
      await writeFile(path, "not json");
      expect(await readSttStatus(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
