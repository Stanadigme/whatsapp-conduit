import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpOAuth, setMcpOAuthPassword } from "../src/mcp/oauth.js";

const PASSWORD = "operator-password-not-a-token";
let root: string;
let baseUrl: string;
let close: () => Promise<void>;
let now = 1_700_000_000;
let logs = "";

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "wac-oauth-"));
  logs = "";
  const tokenFile = join(root, "mcp-http.token");
  setMcpOAuthPassword(tokenFile, PASSWORD, root);
  const logger = pino(
    { level: "trace" },
    {
      write: (line) => {
        logs += line;
      },
    },
  );
  const oauth = createMcpOAuth({
    issuer: "https://whatsapp.example.test",
    dataDir: root,
    tokenFile,
    logger,
    now: () => now,
  });
  const server = createServer((request, response) => {
    oauth
      .handle(request, response)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
});

async function register(
  redirectUri = "https://client.example/callback",
): Promise<string> {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "Test client",
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorizationCode(
  clientId: string,
  verifier = "v".repeat(43),
): Promise<string> {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.example/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-value",
  });
  const page = await fetch(`${baseUrl}/oauth/authorize?${parameters}`);
  expect(page.status).toBe(200);
  const response = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-value",
      password: PASSWORD,
      consent: "allow",
    }),
  });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  expect(new URL(location!).searchParams.get("state")).toBe("state-value");
  return new URL(location!).searchParams.get("code")!;
}

async function exchange(
  clientId: string,
  code: string,
  verifier = "v".repeat(43),
): Promise<{ access_token: string; refresh_token: string }> {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    access_token: string;
    refresh_token: string;
  };
}

describe("OAuth MCP local", () => {
  it("refuses an authorization request without S256 PKCE", async () => {
    const clientId = await register();
    const response = await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://client.example/callback" })}`,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual({
      error: "invalid_authorization_request",
    });
  });

  it("refuses public HTTP redirects during registration", async () => {
    const response = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["http://client.example/callback"],
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual({
      error: "invalid_redirect_uri",
    });
  });

  it("makes authorization codes single use", async () => {
    const clientId = await register();
    const code = await authorizationCode(clientId);
    await exchange(clientId, code);
    const repeat = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: "https://client.example/callback",
        code_verifier: "v".repeat(43),
      }),
    });
    expect(repeat.status).toBe(400);
    expect((await repeat.json()) as { error: string }).toEqual({
      error: "invalid_grant",
    });
  });

  it("refuses a forged consent POST without response_type=code", async () => {
    const clientId = await register();
    const challenge = createHash("sha256")
      .update("v".repeat(43))
      .digest("base64url");
    const response = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://client.example/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        password: PASSWORD,
        consent: "allow",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("does not follow a predictable temporary-file symlink", () => {
    const outside = join(root, "outside");
    writeFileSync(outside, "unchanged");
    symlinkSync(outside, join(root, "mcp-oauth-password.tmp"));
    setMcpOAuthPassword(join(root, "mcp-http.token"), "new-password", root);
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("rejects expired access tokens", async () => {
    const clientId = await register();
    const token = await exchange(clientId, await authorizationCode(clientId));
    now += 3601;
    const oauth = createMcpOAuth({
      issuer: "https://whatsapp.example.test",
      dataDir: root,
      tokenFile: join(root, "mcp-http.token"),
      logger: pino({ level: "silent" }),
      now: () => now,
    });
    expect(oauth.validAccessToken(`Bearer ${token.access_token}`)).toBe(false);
  });

  it("rotates refresh tokens", async () => {
    const clientId = await register();
    const token = await exchange(clientId, await authorizationCode(clientId));
    const response = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token.refresh_token,
      }),
    });
    expect(response.status).toBe(200);
    const rotated = (await response.json()) as { refresh_token: string };
    expect(rotated.refresh_token).not.toBe(token.refresh_token);
    const reused = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: token.refresh_token,
      }),
    });
    expect(reused.status).toBe(400);
  });

  it("does not log passwords, codes, or tokens", async () => {
    const clientId = await register();
    const code = await authorizationCode(clientId);
    const token = await exchange(clientId, code);
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(token.access_token);
    expect(logs).not.toContain(token.refresh_token);
  });
});
