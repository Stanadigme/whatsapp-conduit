import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { resolveConfig } from "../src/config.js";
import { openDb, type Database } from "../src/db/index.js";
import {
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import {
  flushPostgresProjection,
  shutdownPostgresProjection,
  startPostgresProjection,
} from "../src/db/postgres-projection.js";
import { runPostgresMigrations } from "../src/db/postgres.js";
import { createMcpContext, createMcpServer } from "../src/mcp/server.js";
import { createLogger } from "../src/util/logging.js";

/**
 * Proves the one piece the parity suite (postgres-reader.test.ts) cannot: that
 * createMcpContext actually picks PostgresReader — over a real TLS
 * connection, matching phase 1's mandatory TLS — when persistence.postgres is
 * configured, end to end through the real MCP protocol.
 *
 * Needs a TLS-enabled PostgreSQL (phase 1 requires TLS; a plain
 * postgres:17-alpine container is not enough here, unlike
 * postgres-integration.test.ts / postgres-reader.test.ts):
 *
 *   dir=$(mktemp -d); cd $dir
 *   openssl req -x509 -new -nodes -newkey rsa:2048 -days 2 -subj "/CN=test-ca" \
 *     -keyout ca.key -out ca.pem
 *   openssl req -new -nodes -newkey rsa:2048 -subj "/CN=localhost" \
 *     -keyout server.key -out server.csr
 *   printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > server.ext
 *   openssl x509 -req -days 2 -in server.csr -CA ca.pem -CAkey ca.key \
 *     -CAcreateserial -extfile server.ext -out server.crt
 *   docker run --rm -d --name wac-pg-tls -e POSTGRES_PASSWORD=test \
 *     -v $dir/server.crt:/tmp/server.crt:ro -v $dir/server.key:/tmp/server.key:ro \
 *     -p 55433:5432 --entrypoint /bin/sh postgres:17-alpine -c '
 *       cp /tmp/server.crt /var/lib/postgresql/server.crt
 *       cp /tmp/server.key /var/lib/postgresql/server.key
 *       chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
 *       chmod 600 /var/lib/postgresql/server.key
 *       exec docker-entrypoint.sh postgres -c ssl=on \
 *         -c ssl_cert_file=/var/lib/postgresql/server.crt \
 *         -c ssl_key_file=/var/lib/postgresql/server.key'
 *   WA_TEST_POSTGRES_TLS_URL=postgresql://postgres:test@127.0.0.1:55433/postgres \
 *   WA_TEST_POSTGRES_CA_FILE=$dir/ca.pem \
 *     pnpm test mcp-postgres-integration
 */
const url = process.env.WA_TEST_POSTGRES_TLS_URL;
const caFile = process.env.WA_TEST_POSTGRES_CA_FILE;
const pool = url ? new Pool({ connectionString: url, max: 1 }) : undefined;
const logger = createLogger({ level: "error" });

afterAll(async () => {
  await shutdownPostgresProjection();
  await pool?.end();
});

const open: Database[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe.skipIf(!url || !caFile)("MCP server over PostgreSQL (TLS)", () => {
  it("picks PostgresReader and enforces the allowlist through the real MCP protocol", async () => {
    await pool!.query("drop schema public cascade; create schema public");
    const client = await pool!.connect();
    try {
      await runPostgresMigrations(client);
    } finally {
      client.release();
    }
    await shutdownPostgresProjection();

    const db = openDb(":memory:", { migrate: true });
    open.push(db);
    startPostgresProjection(
      { connect: () => pool!.connect(), end: async () => undefined },
      logger,
    );
    upsertAccount(db, { id: "personal" });
    upsertChat(db, {
      accountId: "personal",
      jid: "33600000000@s.whatsapp.net",
      name: "Allowed",
    });
    setChatAllowed(db, "personal", "33600000000@s.whatsapp.net", true);
    upsertChat(db, {
      accountId: "personal",
      jid: "33600000001@s.whatsapp.net",
      name: "Hidden",
    });
    upsertMessage(db, {
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "M1",
      timestamp: 1_700_000_000,
      messageType: "text",
      text: "hello from allowed chat",
    });
    upsertMessage(db, {
      accountId: "personal",
      chatJid: "33600000001@s.whatsapp.net",
      messageId: "M2",
      timestamp: 1_700_000_001,
      messageType: "text",
      text: "secret hidden chat",
    });
    await flushPostgresProjection();

    const secretsDir = mkdtempSync(join(tmpdir(), "wac-mcp-pg-"));
    const passwordFile = join(secretsDir, "postgres.password");
    const caFileCopy = join(secretsDir, "ca.pem");
    writeFileSync(passwordFile, "test", { mode: 0o600 });
    writeFileSync(caFileCopy, readFileSync(caFile!), { mode: 0o600 });

    const parsed = new URL(url!);
    const config = resolveConfig(
      {
        persistence: {
          postgres: {
            url: `postgresql://${parsed.username}@${parsed.hostname}:${parsed.port}${parsed.pathname}`,
            password_file: passwordFile,
            ca_file: caFileCopy,
          },
        },
      },
      { dataDir: "/data" },
    );

    const handle = await createMcpContext(config);
    try {
      const server = createMcpServer(handle.context);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: "pg-e2e", version: "0.1.0" });
      await server.connect(serverTransport);
      await mcpClient.connect(clientTransport);
      try {
        const chats = await mcpClient.callTool({
          name: "wa_chats_list",
          arguments: {},
        });
        expect(JSON.stringify(chats)).toContain("Allowed");
        expect(JSON.stringify(chats)).not.toContain("Hidden");

        const messages = await mcpClient.callTool({
          name: "wa_messages_list",
          arguments: {},
        });
        expect(JSON.stringify(messages)).toContain("hello from allowed chat");
        expect(JSON.stringify(messages)).not.toContain("secret hidden chat");

        const health = (await mcpClient.callTool({
          name: "wa_health",
          arguments: {},
        })) as unknown as { content: [{ text: string }] };
        const healthBody = JSON.parse(health.content[0].text) as {
          chats: number;
          allowedChats: number;
          schema: string | null;
        };
        expect(healthBody.chats).toBe(2);
        expect(healthBody.allowedChats).toBe(1);
        // Proves PostgresReader, not SqliteReader, actually answered: the
        // latest-migration name only exists in the Postgres history.
        expect(healthBody.schema).toBe("0005_message_surrogate_id.sql");
      } finally {
        await mcpClient.close();
        await server.close();
      }
    } finally {
      await handle.close();
    }
  });
});
