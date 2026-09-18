import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { ensureTokenFile } from "../util/token-file.js";

const ACCESS_TTL_S = 60 * 60;
const CODE_TTL_S = 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

interface Client {
  redirectUris: string[];
  name: string;
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

interface Refresh {
  clientId: string;
  expiresAt: number;
}

interface Access {
  expiresAt: number;
}

interface State {
  clients: Record<string, Client>;
  codes: Record<string, Code>;
  refresh: Record<string, Refresh>;
  access: Record<string, Access>;
}

interface PasswordRecord {
  salt: string;
  hash: string;
}

export interface McpOAuthOptions {
  /** HTTPS public origin, without a path (for example https://host.example). */
  issuer: string;
  /** Private runtime directory; OAuth state is stored here, never in SQLite. */
  dataDir: string;
  /** Existing MCP bearer token file; OAuth secrets live next to it. */
  tokenFile: string;
  logger: Logger;
  /** Test-only clock; production callers omit it. */
  now?: () => number;
}

export interface McpOAuth {
  /** OAuth protected-resource metadata for `/.well-known/oauth-protected-resource`. */
  protectedResourceMetadata: Record<string, unknown>;
  /** Authorization-server metadata for `/.well-known/oauth-authorization-server`. */
  authorizationServerMetadata: Record<string, unknown>;
  /** Handles OAuth and discovery routes; `false` leaves the request to MCP. */
  handle: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<boolean>;
  /** Validates an OAuth bearer. Static bearer validation remains in `http.ts`. */
  validAccessToken: (authorization: string | undefined) => boolean;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function emptyState(): State {
  return { clients: {}, codes: {}, refresh: {}, access: {} };
}

function ownerFile(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("OAuth secret file must not be a symbolic link");
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

function writeOwnerJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let temporary: string | undefined;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = `${path}.${randomBytes(16).toString("hex")}.tmp`;
      try {
        writeFileSync(candidate, `${JSON.stringify(value)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        temporary = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!temporary) throw new Error("could not create OAuth state file");
    renameSync(temporary, path);
    temporary = undefined;
    ownerFile(path);
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

function readState(path: string): State {
  if (!existsSync(path)) return emptyState();
  ownerFile(path);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    if (
      !value.clients ||
      !value.codes ||
      !value.refresh ||
      !value.access ||
      typeof value.clients !== "object" ||
      typeof value.codes !== "object" ||
      typeof value.refresh !== "object" ||
      typeof value.access !== "object"
    )
      throw new Error("invalid");
    return value as State;
  } catch {
    throw new Error("OAuth state file is invalid");
  }
}

function parseForm(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) result[key] = value;
  return result;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("OAuth request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendOAuthError(
  response: ServerResponse,
  status: number,
  error: string,
): void {
  sendJson(response, status, { error });
}

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function isRedirectUri(value: string): boolean {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    return false;
  }
  if (uri.username || uri.password || uri.hash) return false;
  if (uri.protocol === "https:") return true;
  return (
    uri.protocol === "http:" &&
    (uri.hostname === "127.0.0.1" || uri.hostname === "localhost")
  );
}

function validIssuer(value: string): string {
  const issuer = new URL(value);
  if (
    issuer.protocol !== "https:" ||
    issuer.pathname !== "/" ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error("OAuth issuer must be an HTTPS origin without a path");
  }
  return issuer.origin;
}

/** Password file API for `mcp oauth set-password`; changing it revokes OAuth clients. */
export function setMcpOAuthPassword(
  tokenFile: string,
  password: string,
  dataDir: string,
): void {
  if (password.length === 0)
    throw new Error("OAuth password must not be empty");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  writeOwnerJson(join(dirname(tokenFile), "mcp-oauth-password"), {
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url"),
  } satisfies PasswordRecord);
  rmSync(join(dataDir, "mcp-oauth.json"), { force: true });
}

function passwordAccepted(path: string, password: string): boolean {
  if (!existsSync(path)) return false;
  try {
    ownerFile(path);
    const record = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<PasswordRecord>;
    if (typeof record.salt !== "string" || typeof record.hash !== "string")
      return false;
    return equal(
      scryptSync(password, Buffer.from(record.salt, "base64url"), 32).toString(
        "base64url",
      ),
      record.hash,
    );
  } catch {
    return false;
  }
}

/**
 * Local OAuth 2.1 authorization server. `handle` must run before `/mcp` in
 * http.ts. It owns only discovery and `/oauth/*`; it never logs credentials.
 */
export function createMcpOAuth(options: McpOAuthOptions): McpOAuth {
  const issuer = validIssuer(options.issuer);
  const statePath = join(options.dataDir, "mcp-oauth.json");
  const passwordPath = join(dirname(options.tokenFile), "mcp-oauth-password");
  const hmacKey = Buffer.from(
    ensureTokenFile(join(dirname(options.tokenFile), "mcp-oauth-key")),
    "utf8",
  );
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const protectedResourceMetadata = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
  };
  const authorizationServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
  };

  const save = (state: State): void => writeOwnerJson(statePath, state);
  const clean = (state: State): void => {
    const time = now();
    for (const [key, value] of Object.entries(state.codes))
      if (value.expiresAt <= time) delete state.codes[key];
    for (const [key, value] of Object.entries(state.refresh))
      if (value.expiresAt <= time) delete state.refresh[key];
    for (const [key, value] of Object.entries(state.access))
      if (value.expiresAt <= time) delete state.access[key];
  };
  const signed = (value: string): string =>
    `${value}.${createHmac("sha256", hmacKey).update(value).digest("base64url")}`;
  const validSigned = (value: string): boolean => {
    const dot = value.lastIndexOf(".");
    return (
      dot > 0 &&
      equal(
        value.slice(dot + 1),
        createHmac("sha256", hmacKey)
          .update(value.slice(0, dot))
          .digest("base64url"),
      )
    );
  };
  const issue = (
    state: State,
    clientId: string,
  ): { accessToken: string; refreshToken: string } => {
    const accessToken = signed(randomToken());
    const refreshToken = randomToken();
    const time = now();
    state.access[digest(accessToken)] = { expiresAt: time + ACCESS_TTL_S };
    state.refresh[digest(refreshToken)] = {
      clientId,
      expiresAt: time + REFRESH_TTL_S,
    };
    save(state);
    return { accessToken, refreshToken };
  };

  return {
    protectedResourceMetadata,
    authorizationServerMetadata,
    validAccessToken: (authorization): boolean => {
      if (!authorization?.startsWith("Bearer ")) return false;
      const token = authorization.slice(7);
      if (!validSigned(token)) return false;
      const state = readState(statePath);
      clean(state);
      const access = state.access[digest(token)];
      if (!access || access.expiresAt <= now()) return false;
      return true;
    },
    handle: async (request, response): Promise<boolean> => {
      const url = new URL(request.url ?? "/", issuer);
      const method = request.method ?? "GET";
      if (
        method === "GET" &&
        url.pathname === "/.well-known/oauth-protected-resource"
      ) {
        sendJson(response, 200, protectedResourceMetadata);
        return true;
      }
      if (
        method === "GET" &&
        url.pathname === "/.well-known/oauth-authorization-server"
      ) {
        sendJson(response, 200, authorizationServerMetadata);
        return true;
      }
      if (method === "POST" && url.pathname === "/oauth/register") {
        const raw = await readBody(request);
        let registration: { redirect_uris?: unknown; client_name?: unknown };
        try {
          registration = JSON.parse(raw) as typeof registration;
        } catch {
          sendOAuthError(response, 400, "invalid_client_metadata");
          return true;
        }
        const redirects = registration.redirect_uris;
        if (
          !Array.isArray(redirects) ||
          redirects.length === 0 ||
          !redirects.every(
            (value): value is string =>
              typeof value === "string" && isRedirectUri(value),
          )
        ) {
          sendOAuthError(response, 400, "invalid_redirect_uri");
          return true;
        }
        const state = readState(statePath);
        clean(state);
        const clientId = randomToken();
        state.clients[clientId] = {
          redirectUris: redirects,
          name:
            typeof registration.client_name === "string"
              ? registration.client_name.slice(0, 200)
              : "Client OAuth",
        };
        save(state);
        sendJson(response, 201, {
          client_id: clientId,
          redirect_uris: redirects,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        });
        return true;
      }
      if (url.pathname === "/oauth/authorize" && method === "GET") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const methodName = url.searchParams.get("code_challenge_method");
        const client = readState(statePath).clients[clientId];
        if (
          url.searchParams.get("response_type") !== "code" ||
          !client ||
          !client.redirectUris.includes(redirectUri) ||
          methodName !== "S256" ||
          !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)
        ) {
          sendOAuthError(response, 400, "invalid_authorization_request");
          return true;
        }
        const hidden = [
          "client_id",
          "response_type",
          "redirect_uri",
          "code_challenge",
          "code_challenge_method",
          "state",
        ]
          .map(
            (key) =>
              `<input type="hidden" name="${key}" value="${html(url.searchParams.get(key) ?? "")}">`,
          )
          .join("");
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(
          `<!doctype html><title>Autoriser ${html(client.name)}</title><form method="post" action="/oauth/authorize">${hidden}<p>Autoriser <strong>${html(client.name)}</strong> à accéder à WhatsApp Conduit&nbsp;?</p><label>Mot de passe opérateur <input required type="password" name="password" autocomplete="current-password"></label><p><button name="consent" value="allow">Autoriser</button><button name="consent" value="deny">Refuser</button></p></form>`,
        );
        return true;
      }
      if (url.pathname === "/oauth/authorize" && method === "POST") {
        const form = parseForm(await readBody(request));
        const client = readState(statePath).clients[form.client_id ?? ""];
        const redirectUri = form.redirect_uri ?? "";
        if (
          form.response_type !== "code" ||
          !client ||
          !client.redirectUris.includes(redirectUri) ||
          form.code_challenge_method !== "S256" ||
          !/^[A-Za-z0-9_-]{43,128}$/.test(form.code_challenge ?? "")
        ) {
          sendOAuthError(response, 400, "invalid_authorization_request");
          return true;
        }
        if (
          form.consent !== "allow" ||
          !passwordAccepted(passwordPath, form.password ?? "")
        ) {
          sendOAuthError(response, 403, "access_denied");
          return true;
        }
        const state = readState(statePath);
        clean(state);
        const code = randomToken();
        state.codes[digest(code)] = {
          clientId: form.client_id!,
          redirectUri,
          challenge: form.code_challenge!,
          expiresAt: now() + CODE_TTL_S,
        };
        save(state);
        const destination = new URL(redirectUri);
        destination.searchParams.set("code", code);
        if (form.state) destination.searchParams.set("state", form.state);
        response.writeHead(302, {
          Location: destination.toString(),
          "Cache-Control": "no-store",
        });
        response.end();
        return true;
      }
      if (url.pathname === "/oauth/token" && method === "POST") {
        const form = parseForm(await readBody(request));
        const state = readState(statePath);
        clean(state);
        if (form.grant_type === "authorization_code") {
          const code = state.codes[digest(form.code ?? "")];
          if (
            !code ||
            code.expiresAt <= now() ||
            code.clientId !== form.client_id ||
            code.redirectUri !== form.redirect_uri ||
            !form.code_verifier ||
            !equal(
              createHash("sha256")
                .update(form.code_verifier)
                .digest("base64url"),
              code.challenge,
            )
          ) {
            sendOAuthError(response, 400, "invalid_grant");
            return true;
          }
          delete state.codes[digest(form.code!)];
          const tokens = issue(state, code.clientId);
          sendJson(response, 200, {
            access_token: tokens.accessToken,
            token_type: "Bearer",
            expires_in: ACCESS_TTL_S,
            refresh_token: tokens.refreshToken,
          });
          return true;
        }
        if (form.grant_type === "refresh_token") {
          const refresh = state.refresh[digest(form.refresh_token ?? "")];
          if (
            !refresh ||
            refresh.expiresAt <= now() ||
            refresh.clientId !== form.client_id
          ) {
            sendOAuthError(response, 400, "invalid_grant");
            return true;
          }
          delete state.refresh[digest(form.refresh_token!)];
          const tokens = issue(state, refresh.clientId);
          sendJson(response, 200, {
            access_token: tokens.accessToken,
            token_type: "Bearer",
            expires_in: ACCESS_TTL_S,
            refresh_token: tokens.refreshToken,
          });
          return true;
        }
        sendOAuthError(response, 400, "unsupported_grant_type");
        return true;
      }
      return false;
    },
  };
}
