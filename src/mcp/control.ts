import { loadConfig } from "../config.js";
import {
  requestDaemonRestart,
  requestDirectoryResync,
  requestMediaBackfillStart,
  requestMediaBackfillStatus,
} from "../control/ipc.js";
import { applyPrivacySettings, privacyView } from "../dashboard/privacy.js";
import { applySttSettings, sttHealth } from "../dashboard/stt.js";
import { listInstalledModels, modelsDir } from "../stt/models.js";
import { readSttStatus, sttStatusPath } from "../stt/status.js";
import { nowSec } from "../util/time.js";
import { McpRequestError, type McpContext } from "./types.js";

function configurationPath(ctx: McpContext): string {
  if (!ctx.configPath) throw new McpRequestError("configuration control unavailable");
  return ctx.configPath;
}

export async function sttStatus(ctx: McpContext) {
  const config = loadConfig(configurationPath(ctx));
  const installed = listInstalledModels(modelsDir(config));
  const worker = await readSttStatus(sttStatusPath(config));
  return {
    enabled: config.stt.enabled,
    language: config.stt.language,
    modelId: installed.find((model) => model.path === config.stt.whisper.modelPath)?.id ?? null,
    modelInstalled: installed.some((model) => model.path === config.stt.whisper.modelPath),
    installedModels: installed.map(({ id, label, sizeBytes }) => ({ id, label, sizeBytes })),
    worker: {
      running: worker !== null && nowSec() - worker.lastPassAt <= 120,
      lastPassAt: worker?.lastPassAt ?? null,
    },
  };
}

export async function sttSettings(
  ctx: McpContext,
  input: { enabled?: boolean | undefined; language?: "fr" | "en" | "auto" | undefined; modelId?: string | undefined },
) {
  const path = configurationPath(ctx);
  const params = new URLSearchParams();
  if (input.enabled !== undefined) params.set("enabled", String(input.enabled));
  if (input.language !== undefined) params.set("language", input.language);
  if (input.modelId !== undefined) {
    const config = loadConfig(path);
    const model = listInstalledModels(modelsDir(config)).find((item) => item.id === input.modelId);
    if (!model) throw new McpRequestError("model is not installed");
    params.set("modelPath", model.path);
  }
  try {
    await requestMediaBackfillStatus(ctx.config.paths.controlSocket);
  } catch {
    throw new McpRequestError("ingestion daemon unavailable; settings were not saved");
  }
  try {
    applySttSettings(path, params);
  } catch {
    throw new McpRequestError("transcription settings could not be saved");
  }
  return sttStatus(ctx);
}

/** Checks this process's engine; the separate STT worker has its own heartbeat. */
export async function sttCheck(ctx: McpContext) {
  try {
    const result = await sttHealth(configurationPath(ctx));
    return { ok: result.ok, scope: "local_engine" };
  } catch {
    return { ok: false, scope: "local_engine" };
  }
}

export function privacyStatus(ctx: McpContext) {
  return privacyView(configurationPath(ctx));
}

export async function privacySettings(
  ctx: McpContext,
  input: { storeMedia?: boolean | undefined; includeGroups?: boolean | undefined; includeStatus?: boolean | undefined },
) {
  const path = configurationPath(ctx);
  const params = new URLSearchParams();
  if (input.storeMedia !== undefined) params.set("storeMedia", String(input.storeMedia));
  if (input.includeGroups !== undefined) params.set("includeGroups", String(input.includeGroups));
  if (input.includeStatus !== undefined) params.set("includeStatus", String(input.includeStatus));
  try {
    await requestMediaBackfillStatus(ctx.config.paths.controlSocket);
  } catch {
    throw new McpRequestError("ingestion daemon unavailable; settings were not saved");
  }
  try {
    applyPrivacySettings(path, params);
  } catch {
    throw new McpRequestError("capture settings could not be saved");
  }
  Object.assign(ctx.config, loadConfig(path));
  return { ...privacyView(path), restartRequired: true };
}

export async function mediaBackfillStart(
  ctx: McpContext,
  input: { chat?: string | undefined; allChats?: true | undefined },
) {
  if (input.chat) {
    const chat = await ctx.reader.getChat(input.chat);
    if (!chat || chat.is_allowed !== 1 || !(await ctx.reader.isChatExposed(input.chat))) {
      throw new McpRequestError("chat is not available");
    }
  }
  try {
    const result = await requestMediaBackfillStart(ctx.config.paths.controlSocket,
      input.chat ? { chat: input.chat } : {});
    return { jobId: result.jobId, status: result.status, reused: result.reused };
  } catch {
    throw new McpRequestError("media backfill could not be started");
  }
}

export async function mediaBackfillStatus(ctx: McpContext, jobId?: string) {
  try {
    const result = await requestMediaBackfillStatus(ctx.config.paths.controlSocket,
      jobId ? { jobId } : {});
    return result.mediaBackfill ?? null;
  } catch {
    throw new McpRequestError("media backfill status unavailable");
  }
}

export async function refreshDirectory(ctx: McpContext) {
  try {
    const result = await requestDirectoryResync(ctx.config.paths.controlSocket);
    return { status: "done", contacts: result.resynced?.contacts ?? 0,
      groups: result.resynced?.groups ?? 0 };
  } catch {
    throw new McpRequestError("directory refresh could not be started");
  }
}

export async function restartIngestion(ctx: McpContext) {
  try {
    const result = await requestDaemonRestart(ctx.config.paths.controlSocket);
    return { status: result.restarting?.status ?? "restarting" };
  } catch {
    throw new McpRequestError("ingestion restart unavailable");
  }
}
