import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
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
    await mkdir(dirname(this.path), { recursive: true });
    const address = controlAddress(this.path);
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

function controlAddress(configuredPath: string): string {
  if (process.platform !== "win32") return configuredPath;
  if (configuredPath.startsWith("\\\\.\\pipe\\")) return configuredPath;
  const digest = createHash("sha256")
    .update(configuredPath, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `\\\\.\\pipe\\whatsapp-conduit-${digest}`;
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
