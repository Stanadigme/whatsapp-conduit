import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  createPostgresPool,
  loadPostgresSecrets,
  readSecretFile,
} from "../src/db/postgres.js";

function secretsDir(): string {
  return mkdtempSync(join(tmpdir(), "wac-pg-"));
}

function writeSecret(dir: string, name: string, mode: number): string {
  const path = join(dir, name);
  writeFileSync(path, "value\n", { mode });
  chmodSync(path, mode);
  return path;
}

function persistence(dir: string): Record<string, unknown> {
  return {
    persistence: {
      postgres: {
        url: "postgresql://conduit@db.example.net:5432/conduit",
        password_file: join(dir, "postgres.password"),
        ca_file: join(dir, "postgres-ca.pem"),
      },
    },
  };
}

const pools: Array<{ end: () => Promise<void> }> = [];

afterEach(async () => {
  while (pools.length > 0) await pools.pop()?.end();
});

describe("persistence.postgres configuration", () => {
  it("stays disabled when the operator did not configure a destination", () => {
    expect(resolveConfig({}, { dataDir: "/data" }).persistence.postgres).toBe(
      null,
    );
    expect(
      resolveConfig(
        { persistence: { postgres: { url: "" } } },
        { dataDir: "/data" },
      ).persistence.postgres,
    ).toBe(null);
  });

  it("resolves an explicit destination with local secret paths", () => {
    const resolved = resolveConfig(persistence("/secrets"), {
      dataDir: "/data",
    }).persistence.postgres;
    expect(resolved).toEqual({
      url: "postgresql://conduit@db.example.net:5432/conduit",
      passwordFile: "/secrets/postgres.password",
      caFile: "/secrets/postgres-ca.pem",
    });
  });

  it("refuses a password or an sslmode carried by the URL", () => {
    expect(() =>
      resolveConfig(
        {
          persistence: {
            postgres: {
              url: "postgresql://conduit:hunter2@db.example.net/conduit",
              password_file: "/secrets/p",
              ca_file: "/secrets/ca",
            },
          },
        },
        { dataDir: "/data" },
      ),
    ).toThrow(/password_file/);

    expect(() =>
      resolveConfig(
        {
          persistence: {
            postgres: {
              url: "postgresql://conduit@db.example.net/conduit?sslmode=disable",
              password_file: "/secrets/p",
              ca_file: "/secrets/ca",
            },
          },
        },
        { dataDir: "/data" },
      ),
    ).toThrow(/sslmode/);
  });

  it("refuses a non-PostgreSQL endpoint and a destination without secret files", () => {
    expect(() =>
      resolveConfig(
        { persistence: { postgres: { url: "https://db.example.net" } } },
        { dataDir: "/data" },
      ),
    ).toThrow(/expected postgresql/);

    expect(() =>
      resolveConfig(
        {
          persistence: {
            postgres: { url: "postgresql://conduit@db.example.net/conduit" },
          },
        },
        { dataDir: "/data" },
      ),
    ).toThrow(/password_file: expected a path/);
  });
});

describe("PostgreSQL secret files", () => {
  it("refuses a secret readable by group or others", () => {
    const dir = secretsDir();
    const path = writeSecret(dir, "postgres.password", 0o644);
    expect(() => readSecretFile(path, "password_file")).toThrow(
      /must not be readable/,
    );
  });

  it("refuses an empty secret and accepts an owner-only one", () => {
    const dir = secretsDir();
    const empty = join(dir, "empty");
    writeFileSync(empty, "  \n", { mode: 0o600 });
    expect(() => readSecretFile(empty, "ca_file")).toThrow(/is empty/);

    writeSecret(dir, "postgres.password", 0o600);
    writeSecret(dir, "postgres-ca.pem", 0o600);
    const config = resolveConfig(persistence(dir), { dataDir: dir }).persistence
      .postgres;
    expect(config).not.toBe(null);
    expect(loadPostgresSecrets(config!)).toEqual({
      password: "value",
      ca: "value",
    });
  });
});

describe("PostgreSQL pool", () => {
  it("verifies the server certificate and never carries the password in the URL", () => {
    const dir = secretsDir();
    writeSecret(dir, "postgres.password", 0o600);
    writeSecret(dir, "postgres-ca.pem", 0o600);
    const config = resolveConfig(persistence(dir), { dataDir: dir }).persistence
      .postgres;

    const pool = createPostgresPool(config!);
    pools.push(pool);
    const options = pool.options as unknown as {
      ssl: { ca: string; rejectUnauthorized: boolean };
      password: string;
      connectionString: string;
      connectionTimeoutMillis: number;
    };
    expect(options.ssl).toMatchObject({
      ca: "value",
      rejectUnauthorized: true,
    });
    expect(options.password).toBe("value");
    expect(options.connectionString).not.toContain("value");
    expect(options.connectionTimeoutMillis).toBe(5_000);
  });
});
