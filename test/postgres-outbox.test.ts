import { describe, expect, it } from "vitest";
import {
  createPostgresOutboxDestination,
  PostgresOutboxDestination,
  type PostgresClient,
  type PostgresConnectionPool,
} from "../src/db/postgres-outbox.js";

class FakeClient implements PostgresClient {
  readonly queries: Array<{
    sql: string;
    values: readonly unknown[] | undefined;
  }> = [];
  released = false;

  async query(sql: string, values?: readonly unknown[]): Promise<void> {
    this.queries.push({ sql, values });
  }

  release(): void {
    this.released = true;
  }
}

class FakePool implements PostgresConnectionPool {
  readonly client = new FakeClient();
  ended = false;

  async connect(): Promise<PostgresClient> {
    return this.client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

const payload = {
  version: 1,
  chat: {
    account_id: "personal",
    jid: "c@s.whatsapp.net",
    name: null,
    push_name: "Alice",
    is_group: 0,
    is_status: 0,
    is_blocked: 0,
    is_allowed: 1,
    discovered_at: 1_700,
    updated_at: 1_700,
    last_message_ts: 1_700,
    raw_json: null,
  },
  message: {
    account_id: "personal",
    chat_jid: "c@s.whatsapp.net",
    message_id: "M1",
    sender_jid: "c@s.whatsapp.net",
    from_me: 0,
    timestamp: 1_700,
    received_at: 1_700,
    message_type: "text",
    text: "privé",
    normalized_text: null,
    has_media: 0,
    duration_s: null,
    ingestion_source: "live",
    quoted_message_id: null,
    quoted_sender_jid: null,
    edited_message_id: null,
    deleted_at: null,
    raw_json: null,
  },
};

describe("PostgreSQL outbox destination", () => {
  it("writes a message snapshot atomically without interpolating its payload", async () => {
    const pool = new FakePool();
    const destination = new PostgresOutboxDestination(pool);

    await destination.forward({
      operation: "message.upsert",
      payload,
      attempts: 1,
    });

    expect(pool.client.queries.map((query) => query.sql.toLowerCase())).toEqual(
      [
        "begin",
        expect.stringContaining("insert into accounts"),
        expect.stringContaining("insert into chats"),
        expect.stringContaining("insert into messages"),
        "commit",
      ],
    );
    expect(pool.client.queries[3]?.values).toContain("privé");
    expect(pool.client.released).toBe(true);
  });

  it("rejects a password-bearing URL and incomplete mTLS material before connection", () => {
    expect(() =>
      createPostgresOutboxDestination({
        connectionString: "postgresql://role:password@db.example/client",
        tls: { ca: "ca", cert: "cert", key: "key" },
      }),
    ).toThrow("PostgreSQL endpoint must use certificate authentication");
    expect(() =>
      createPostgresOutboxDestination({
        connectionString: "postgresql://role@db.example/client",
        tls: { ca: "", cert: "cert", key: "key" },
      }),
    ).toThrow("PostgreSQL mTLS material is required");
  });
});
