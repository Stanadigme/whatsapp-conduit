import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { createHash, randomUUID } from "node:crypto";

export interface HistoryStartRequest {
  op: "history.start";
  requestId: string;
  chat: string;
  since: number;
}

export interface DirectoryResyncRequest {
  op: "directory.resync";
  requestId: string;
}

export interface PairingStartRequest {
  op: "pairing.start";
  requestId: string;
}

/** Every request the daemon control socket accepts. */
export type ControlRequest =
  | HistoryStartRequest
  | DirectoryResyncRequest
  | PairingStartRequest;

/** @deprecated use {@link HistoryStartRequest} */
export type HistoryControlRequest = HistoryStartRequest;

export interface ControlResponse {
  ok: boolean;
  requestId: string;
  /** `history.start` */
  jobId?: string;
  status?: string;
  reused?: boolean;
  /** `directory.resync` */
  resynced?: { contacts: number; groups: number };
  /** `pairing.start` */
  pairing?: { status: "starting" };
  error?: string;
}

/** @deprecated use {@link ControlResponse} */
export type HistoryControlResponse = ControlResponse;

export type ControlResult =
  | { jobId: string; status: string; reused: boolean }
  | { resynced: { contacts: number; groups: number } }
  | { pairing: { status: "starting" } };

export interface ControlHandler {
  (request: ControlRequest): Promise<ControlResult>;
}

/** @deprecated use {@link ControlHandler} */
export type HistoryControlHandler = ControlHandler;

const MAX_FRAME_BYTES = 64 * 1024;

export class HistoryControlServer {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();

  constructor(
    private readonly path: string,
    private readonly handler: ControlHandler,
  ) {}

  async start(): Promise<void> {
    const address = controlAddress(this.path);
    // The fallback address lives outside the data directory, so create the
    // directory of the address we actually bind, not of the configured path.
    if (process.platform !== "win32") {
      await mkdir(dirname(address), { recursive: true });
    }
    if (process.platform !== "win32" && address !== this.path) {
      // EADDRINUSE on a file that does not exist sends the reader down the
      // wrong path; say plainly where the socket really is.
      process.stderr.write(
        `control socket path exceeds the ${MAX_UNIX_SOCKET_BYTES}-byte limit; ` +
          `using ${address} instead of ${this.path}\n`,
      );
    }
    await rm(address, { force: true }).catch(() => undefined);
    const server = createServer((socket) => this.handle(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(address);
    });
    if (process.platform !== "win32") {
      await chmod(address, 0o600).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.destroy();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(controlAddress(this.path), { force: true }).catch(() => undefined);
  }

  private handle(socket: Socket): void {
    this.clients.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = buffer.slice(0, newline);
      buffer = "";
      void this.respond(socket, frame);
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  private async respond(socket: Socket, frame: string): Promise<void> {
    let requestId = "unknown";
    try {
      const parsed: unknown = JSON.parse(frame);
      if (!isControlRequest(parsed)) throw new Error("invalid request");
      requestId = parsed.requestId;
      const result = await this.handler(parsed);
      socket.end(
        `${JSON.stringify({
          ok: true,
          requestId,
          ...result,
        } satisfies ControlResponse)}\n`,
      );
    } catch (error) {
      socket.end(
        `${JSON.stringify({
          ok: false,
          requestId,
          error:
            error instanceof Error ? error.message : "control request failed",
        } satisfies ControlResponse)}\n`,
      );
    }
  }
}

function sendControlRequest(
  path: string,
  request: ControlRequest,
  timeoutMs: number,
): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = createConnection(controlAddress(path));
    let buffer = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error("control socket unavailable"))),
    );
    socket.on("error", () =>
      finish(() => reject(new Error("control socket unavailable"))),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        finish(() => reject(new Error("control response too large")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed: unknown = JSON.parse(buffer.slice(0, newline));
        if (!isControlResponse(parsed)) throw new Error("invalid response");
        finish(() =>
          parsed.ok
            ? resolve(parsed)
            : reject(new Error(parsed.error ?? "control request failed")),
        );
      } catch {
        finish(() => reject(new Error("control response invalid")));
      }
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

export async function requestHistoryStart(
  path: string,
  input: Omit<HistoryStartRequest, "op" | "requestId">,
  timeoutMs = 5_000,
): Promise<ControlResponse> {
  return sendControlRequest(
    path,
    { op: "history.start", requestId: randomUUID(), ...input },
    timeoutMs,
  );
}

/** Ask the running daemon to re-fetch contact and group names from WhatsApp. */
export async function requestDirectoryResync(
  path: string,
  timeoutMs = 30_000,
): Promise<ControlResponse> {
  return sendControlRequest(
    path,
    { op: "directory.resync", requestId: randomUUID() },
    timeoutMs,
  );
}

/** Ask the Baileys ingestion daemon to begin its exclusive pairing flow. */
export async function requestBaileysPairingStart(
  path: string,
  timeoutMs = 5_000,
): Promise<ControlResponse> {
  return sendControlRequest(
    path,
    { op: "pairing.start", requestId: randomUUID() },
    timeoutMs,
  );
}

/**
 * Longest unix socket path we are willing to bind. `sun_path` holds 104 bytes
 * on macOS and 108 on Linux, and the kernel does not reject a longer path — it
 * truncates silently, creating the socket somewhere else entirely. The margin
 * below the smallest limit leaves room for the trailing NUL.
 */
const MAX_UNIX_SOCKET_BYTES = 100;

function fingerprint(configuredPath: string): string {
  return createHash("sha256")
    .update(configuredPath, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Resolve the address the server binds and the client dials. Both go through
 * this function, so they always agree.
 */
export function controlAddress(configuredPath: string): string {
  if (process.platform === "win32") {
    if (configuredPath.startsWith("\\\\.\\pipe\\")) return configuredPath;
    return `\\\\.\\pipe\\whatsapp-conduit-${fingerprint(configuredPath)}`;
  }
  // Measured in bytes, not characters: an accented path — the norm on a French
  // Mac — overruns sooner than its apparent length suggests.
  if (Buffer.byteLength(configuredPath, "utf8") <= MAX_UNIX_SOCKET_BYTES)
    return configuredPath;
  const short = join(tmpdir(), `wac-${fingerprint(configuredPath)}.sock`);
  // macOS tmpdir() is a long /var/folders/... path, so the fallback can itself
  // overrun. /tmp always fits.
  return Buffer.byteLength(short, "utf8") <= MAX_UNIX_SOCKET_BYTES
    ? short
    : `/tmp/wac-${fingerprint(configuredPath)}.sock`;
}

function isControlRequest(value: unknown): value is ControlRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string") return false;
  if (record.op === "directory.resync" || record.op === "pairing.start")
    return true;
  return (
    record.op === "history.start" &&
    typeof record.chat === "string" &&
    typeof record.since === "number" &&
    Number.isInteger(record.since)
  );
}

function isControlResponse(value: unknown): value is ControlResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.ok === true || record.ok === false;
}
