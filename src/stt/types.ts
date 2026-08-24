/**
 * STT adapter contract (`specs/stt-adapter.md`).
 *
 * The worker knows this interface and no provider. Each adapter translates the
 * request into its provider's native shape and normalizes the response. An
 * adapter never post-corrects: it returns `textRaw` and nothing else touches it.
 */

/** A business-vocabulary entry as stored in the (future) `lexicon` table. */
export interface LexiconEntry {
  /** Wanted output, e.g. "Odoo". */
  term: string;
  /** Misheard forms, e.g. ["au doux"]. */
  soundsLike: string[];
  domain?: string;
  caseSensitive?: boolean;
}

export interface TranscriptionRequest {
  /** Local file, already decoded to a format the adapter accepts. */
  audioPath: string;
  /** Known before the call; drives the worker's guardrails. */
  durationS: number | null;
  language?: string;
  /**
   * ponytail: always empty until the lexicon layer lands (Jalon 6). Kept in the
   * contract so adding a provider adapter does not change the worker.
   */
  lexicon: LexiconEntry[];
  lexiconVersion: number;
}

export interface TranscriptionResult {
  /** Raw engine output. Never post-corrected here. */
  textRaw: string;
  language: string;
  confidence?: number;
  engine: string;
  engineModel: string;
  costUsd?: number;
  /** Full provider response, kept so a normalization gap costs no re-call. */
  raw: unknown;
}

export interface SttCapabilities {
  /** Phonetic variants supported natively. */
  soundsLike: boolean;
  /** 0 = no structured vocabulary at all. */
  maxLexiconTerms: number;
  maxDurationS: number;
  languages: string[];
  diarization: boolean;
}

export interface SttAdapter {
  readonly name: string;
  readonly capabilities: SttCapabilities;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
  /** Verify credentials and reachability. Called before the first job. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
