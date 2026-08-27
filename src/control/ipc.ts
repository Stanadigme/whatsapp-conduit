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

export interface HistoryControlRequest {
  op: "history.start";
  requestId: string;
  chat: string;
  since: number;
}

export interface HistoryControlResponse {
  ok: boolean;
  requestId: string;
  jobId?: string;
  status?: string;
  reused?: boolean;
  error?: string;
}

export interface HistoryControlHandler {
  (request: HistoryControlRequest): Promise<{
    jobId: string;
    status: string;
    reused: boolean;
  }>;
}

const MAX_FRAME_BYTES = 64 * 1024;

export class HistoryControlServer {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();

  constructor(
    private readonly path: string,
    private readonly handler: HistoryControlHandler,
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
      if (!isHistoryControlRequest(parsed)) throw new Error("invalid request");
      requestId = parsed.requestId;
      const result = await this.handler(parsed);
      socket.end(
        `${JSON.stringify({
          ok: true,
          requestId,
          jobId: result.jobId,
          status: result.status,
          reused: result.reused,
        } satisfies HistoryControlResponse)}\n`,
      );
    } catch {
      socket.end(
        `${JSON.stringify({
          ok: false,
          requestId,
          error: "history control request failed",
        } satisfies HistoryControlResponse)}\n`,
      );
    }
  }
}

export async function requestHistoryStart(
  path: string,
  input: Omit<HistoryControlRequest, "op" | "requestId">,
  timeoutMs = 5_000,
): Promise<HistoryControlResponse> {
  const request: HistoryControlRequest = {
    op: "history.start",
    requestId: randomUUID(),
    ...input,
  };
  return new Promise<HistoryControlResponse>((resolve, reject) => {
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
      finish(() => reject(new Error("history control unavailable"))),
    );
    socket.on("error", () =>
      finish(() => reject(new Error("history control unavailable"))),
    );
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        finish(() => reject(new Error("history control response too large")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed: unknown = JSON.parse(buffer.slice(0, newline));
        if (!isHistoryControlResponse(parsed))
          throw new Error("invalid response");
        finish(() =>
          parsed.ok ? resolve(parsed) : reject(new Error(parsed.error)),
        );
      } catch {
        finish(() => reject(new Error("history control response invalid")));
      }
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
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

function isHistoryControlRequest(
  value: unknown,
): value is HistoryControlRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.op === "history.start" &&
    typeof record.requestId === "string" &&
    typeof record.chat === "string" &&
    typeof record.since === "number" &&
    Number.isInteger(record.since)
  );
}

function isHistoryControlResponse(
  value: unknown,
): value is HistoryControlResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.ok === true || record.ok === false;
}
