import { loadConfig } from "../config.js";
import { setConfigValue } from "../commands/config.js";

/**
 * Capture-scope settings the dashboard may write (amends ADR-0017, which
 * limited this opening to stt.*). Deliberately excludes every other
 * privacy.* key: store_message_text/store_raw_json are foundational (raw_json
 * is also the only source the media backfill has to work with), and nothing
 * that touches invariant 6 (message text in logs) belongs behind a web
 * checkbox.
 */
const PARAM_TO_KEY: Record<string, string> = {
  storeMedia: "privacy.store_media",
  includeGroups: "privacy.include_groups",
  includeStatus: "privacy.include_status",
};

export interface PrivacyView {
  storeMedia: boolean;
  includeGroups: boolean;
  includeStatus: boolean;
}

export function privacyView(configPath: string): PrivacyView {
  const config = loadConfig(configPath);
  return {
    storeMedia: config.privacy.storeMedia,
    includeGroups: config.privacy.includeGroups,
    includeStatus: config.privacy.includeStatus,
  };
}

/**
 * The daemon reads config.yaml once at process start — unlike the STT
 * worker, it does not re-read it on a timer — so a change made here has no
 * effect until the ingestion service is restarted (dashboard exposes that
 * as a separate, explicit action).
 */
export function applyPrivacySettings(
  configPath: string,
  params: URLSearchParams,
): void {
  const known = new Set(Object.keys(PARAM_TO_KEY));
  for (const key of params.keys()) {
    if (!known.has(key)) {
      throw new Error(`cannot set unknown privacy setting "${key}"`);
    }
  }

  const writes: Array<[string, string]> = [];
  for (const [param, configKey] of Object.entries(PARAM_TO_KEY)) {
    const value = params.get(param);
    if (value === null) continue;
    if (value !== "true" && value !== "false") {
      throw new Error(`${param} must be true or false`);
    }
    writes.push([configKey, value]);
  }
  if (writes.length === 0) throw new Error("nothing to set");
  for (const [key, value] of writes) {
    setConfigValue(key, value, configPath);
  }
}
