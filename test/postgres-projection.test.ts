import { afterEach, describe, expect, it } from "vitest";
import type { WAMessage } from "baileys";
import type { DestinationStream } from "pino";
import { ingestMessage } from "../src/baileys/ingest.js";
import { resolveConfig } from "../src/config.js";
import { openDb, type Database } from "../src/db/index.js";
import { upsertDirectoryGroupMember } from "../src/db/directory.js";
import { countOutbox } from "../src/db/outbox.js";
import {
  countMessages,
  insertTranscription,
  setChatAllowed,
  upsertAccount,
  upsertAttachment,
} from "../src/db/queries.js";
import {
  flushPostgresProjection,
  shutdownPostgresProjection,
  startPostgresProjection,
  type PostgresProjectionClient,
  type PostgresProjectionPool,
} from "../src/db/postgres-projection.js";
import { createLogger } from "../src/util/logging.js";

interface Statement {
  sql: string;
  values: readonly unknown[] | undefined;
}

class FakeClient implements PostgresClientShape {
  released: Error | undefined | "clean";

  constructor(
    readonly statements: Statement[],
    private readonly failOn?: (sql: string) => Error | undefined,
  ) {}

  async query(sql: string, values?: readonly unknown[]): Promise<void> {
    this.statements.push({ sql, values });
    const failure = this.failOn?.(sql);
    if (failure) throw failure;
  }

  release(destroy?: Error): void {
    this.released = destroy ?? "clean";
  }
}

type PostgresClientShape = PostgresProjectionClient;

class FakePool implements PostgresProjectionPool {
  readonly statements: Statement[] = [];
  readonly clients: FakeClient[] = [];
  ended = false;

  constructor(private readonly failOn?: (sql: string) => Error | undefined) {}

  async connect(): Promise<PostgresProjectionClient> {
    const client = new FakeClient(this.statements, this.failOn);
    this.clients.push(client);
    return client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  tables(): string[] {
    return this.statements
      .map((statement) => /^insert into (\w+)/.exec(statement.sql)?.[1])
      .filter((table): table is string => table !== undefined);
  }

  rowFor(table: string): readonly unknown[] | undefined {
    return this.statements.find((statement) =>
      statement.sql.startsWith(`insert into ${table} `),
    )?.values;
  }
}

function captureLogger(): {
  logger: ReturnType<typeof createLogger>;
  records: Array<Record<string, unknown>>;
} {
  const records: Array<Record<string, unknown>> = [];
  const stream: DestinationStream = {
    write(chunk: string) {
      records.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  return { logger: createLogger({ level: "warn" }, stream), records };
}

function seededDb(): Database {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "personal" });
  return db;
}

function message(text: string, id = "M1"): WAMessage {
  return {
    key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id },
    messageTimestamp: 1_700,
    pushName: "Alice",
    message: { conversation: text },
  } as WAMessage;
}

function ingestDeps(db: Database, withOutboxKey: boolean) {
  return {
    db,
    accountId: "personal",
    config: resolveConfig({}, { dataDir: "/data" }),
    logger: createLogger({ level: "error" }),
    ...(withOutboxKey ? { outboxKey: Buffer.alloc(32, 7) } : {}),
  };
}

const open: Database[] = [];

afterEach(async () => {
  await shutdownPostgresProjection();
  while (open.length > 0) open.pop()?.close();
});

describe("direct PostgreSQL projection", () => {
  it("projects a whole message without interpolating its text into SQL", async () => {
    const pool = new FakePool();
    startPostgresProjection(pool, captureLogger().logger);
    const db = seededDb();
    open.push(db);

    ingestMessage(ingestDeps(db, false), message("bonjour"));
    upsertAttachment(db, {
      accountId: "personal",
      chatJid: "c@s.whatsapp.net",
      messageId: "M1",
      mediaType: "audio",
      filePath: "/data/media/voice.ogg",
    });
    insertTranscription(db, {
      accountId: "personal",
      chatJid: "c@s.whatsapp.net",
      messageId: "M1",
      textRaw: "bonjour",
      engine: "whisper-local",
    });
    await flushPostgresProjection();

    expect(pool.tables()).toEqual(
      expect.arrayContaining([
        "accounts",
        "chats",
        "chat_message_stats",
        "messages",
        "attachments",
        "transcriptions",
      ]),
    );
    for (const statement of pool.statements) {
      expect(statement.sql).not.toContain("bonjour");
      expect(statement.sql).not.toContain("c@s.whatsapp.net");
    }
    expect(pool.rowFor("messages")).toContain("bonjour");
    // Local media paths stay local: the bytes belong in the client bucket.
    expect(pool.rowFor("attachments")).not.toContain("/data/media/voice.ogg");
    expect(pool.statements.at(0)?.sql).toBe("begin");
    expect(pool.statements.at(-1)?.sql).toBe("commit");
  });

  it("upserts on natural keys and coalesces repeated events into one write", async () => {
    const pool = new FakePool();
    startPostgresProjection(pool, captureLogger().logger);
    const db = seededDb();
    open.push(db);

    const deps = ingestDeps(db, false);
    ingestMessage(deps, message("un"));
    ingestMessage(deps, message("un"));
    ingestMessage(deps, message("deux", "M2"));
    await flushPostgresProjection();

    const messageWrites = pool.statements.filter((statement) =>
      statement.sql.startsWith("insert into messages "),
    );
    expect(messageWrites).toHaveLength(2);
    expect(messageWrites[0]?.sql).toContain(
      "on conflict (account_id, chat_jid, message_id) do update set",
    );
    expect(messageWrites[0]?.sql).toMatch(/values \(\$1(, \$\d+)+\)/);

    // A replay of the same key produces the same statement again, not a second
    // row: idempotence is the destination's, not the queue's.
    ingestMessage(deps, message("un"));
    await flushPostgresProjection();
    expect(
      pool.statements.filter((statement) =>
        statement.sql.startsWith("insert into messages "),
      ),
    ).toHaveLength(3);
  });

  it("projects a policy change on its own", async () => {
    const pool = new FakePool();
    startPostgresProjection(pool, captureLogger().logger);
    const db = seededDb();
    open.push(db);

    ingestMessage(ingestDeps(db, false), message("bonjour"));
    await flushPostgresProjection();
    pool.statements.length = 0;

    setChatAllowed(db, "personal", "c@s.whatsapp.net", true);
    await flushPostgresProjection();

    expect(pool.tables()).toEqual(["accounts", "chats", "chat_message_stats"]);
    expect(pool.rowFor("chats")).toContain(true);
  });

  it("carries directory aliases and members as canonical JIDs", async () => {
    const pool = new FakePool();
    startPostgresProjection(pool, captureLogger().logger);
    const db = seededDb();
    open.push(db);

    upsertDirectoryGroupMember(db, {
      accountId: "personal",
      groupJid: "g@g.us",
      participantJid: "33600000000@s.whatsapp.net",
      role: "admin",
    });
    await flushPostgresProjection();

    const member = pool.statements.find((statement) =>
      statement.sql.startsWith("insert into directory_group_members "),
    );
    expect(member?.values).toContain("g@g.us");
    expect(member?.values).toContain("33600000000@s.whatsapp.net");
    expect(member?.sql).not.toContain("entity_id");

    const alias = pool.statements.find((statement) =>
      statement.sql.startsWith("insert into directory_aliases "),
    );
    expect(alias?.sql).toContain("canonical_jid");
    expect(alias?.sql).not.toContain("entity_id");
  });

  it("keeps SQLite usable when the destination refuses the write, without retrying", async () => {
    const refusal = Object.assign(new Error('duplicate key value: "bonjour"'), {
      code: "23505",
      detail: "Key (text)=(bonjour) already exists.",
    });
    const pool = new FakePool((sql) =>
      sql.startsWith("insert into messages ") ? refusal : undefined,
    );
    const { logger, records } = captureLogger();
    startPostgresProjection(pool, logger);
    const db = seededDb();
    open.push(db);

    ingestMessage(ingestDeps(db, false), message("bonjour"));
    await flushPostgresProjection();

    expect(countMessages(db)).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ projection: "message", code: "23505" });
    expect(JSON.stringify(records[0])).not.toContain("bonjour");
    expect(JSON.stringify(records[0])).not.toContain("s.whatsapp.net");

    // No replay, no queue, no second attempt.
    expect(
      pool.statements.filter((statement) =>
        statement.sql.startsWith("insert into messages "),
      ),
    ).toHaveLength(1);
    expect(pool.statements.at(-1)?.sql).toBe("rollback");
    expect(pool.clients.at(-1)?.released).toBe("clean");
  });

  it("does not queue an outbox snapshot when the alpha profile is active", async () => {
    const pool = new FakePool();
    startPostgresProjection(pool, captureLogger().logger);
    const db = seededDb();
    open.push(db);

    // The daemon withholds the outbox key under `persistence.postgres`; this is
    // what ingestion then sees.
    ingestMessage(ingestDeps(db, false), message("bonjour"));
    await flushPostgresProjection();

    expect(countOutbox(db).pending).toBe(0);
    expect(pool.tables()).toContain("messages");
  });
});
