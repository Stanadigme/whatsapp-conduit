import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";

/**
 * Curated whisper.cpp model catalogue.
 *
 * Digests and sizes were read from the HuggingFace API for
 * `ggerganov/whisper.cpp` on 2026-08-24. They are pinned on purpose: a model
 * file is fed to a local binary, so a download is only installed once its
 * SHA-256 matches. Verifying against whatever the server reports would only
 * prove the server agrees with itself.
 *
 * `tiny` is absent (unusable for French business vocabulary) and so is
 * `large-v3` (3.1 GB for a marginal gain over `turbo`).
 */
export interface CatalogueModel {
  id: string;
  file: string;
  /** Plain-language quality label shown in the dashboard. */
  label: string;
  note: string;
  sizeBytes: number;
  sha256: string;
}

/** Single pinned host. Nothing else is ever fetched. */
export const MODEL_HOST = "https://huggingface.co";
const MODEL_PATH_PREFIX = "/ggerganov/whisper.cpp/resolve/main/";

export const MODEL_CATALOGUE: readonly CatalogueModel[] = [
  {
    id: "base",
    file: "ggml-base.bin",
    label: "Rapide",
    note: "Le plus léger utilisable. Suffit pour un vocal clair et court.",
    sizeBytes: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  },
  {
    id: "small",
    file: "ggml-small.bin",
    label: "Correct",
    note: "Bon compromis sur une machine sans carte graphique.",
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  },
  {
    id: "medium",
    file: "ggml-medium.bin",
    label: "Bon",
    note: "Nettement meilleur en français, sensiblement plus lent.",
    sizeBytes: 1_533_763_059,
    sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
  },
  {
    id: "large-v3-turbo",
    file: "ggml-large-v3-turbo.bin",
    label: "Précis",
    note: "Recommandé. Qualité du grand modèle, vitesse presque intacte.",
    sizeBytes: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
  },
] as const;

export function findCatalogueModel(id: string): CatalogueModel | undefined {
  return MODEL_CATALOGUE.find((model) => model.id === id);
}

/** Download URL for a catalogue entry. The host is never taken from input. */
export function modelUrl(model: CatalogueModel): string {
  return `${MODEL_HOST}${MODEL_PATH_PREFIX}${model.file}`;
}

/** Where models live. Derived from the data directory, not a config key. */
export function modelsDir(config: Config): string {
  return join(config.paths.dataDir, "models");
}

export interface InstalledModel {
  /** Catalogue id when recognized, otherwise the bare file name. */
  id: string;
  file: string;
  path: string;
  label: string;
  sizeBytes: number;
}

/**
 * List the model files present on disk. This is the allowlist the dashboard
 * validates `stt.whisper.model_path` against: a model path always comes from a
 * scan, never from browser input, because it ends up as a `-m` argument.
 */
export function listInstalledModels(directory: string): InstalledModel[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const models: InstalledModel[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".bin")) continue;
    const path = join(directory, entry);
    let sizeBytes: number;
    try {
      const details = statSync(path);
      if (!details.isFile()) continue;
      sizeBytes = details.size;
    } catch {
      continue;
    }
    const known = MODEL_CATALOGUE.find((model) => model.file === entry);
    models.push({
      id: known?.id ?? entry,
      file: entry,
      path,
      label: known?.label ?? "Personnalisé",
      sizeBytes,
    });
  }
  return models;
}
