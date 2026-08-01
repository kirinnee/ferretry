/**
 * The DAEMON engine — the default, and the recommendation.
 *
 * It is a batch engine and it says so. The honest measurement behind that: on
 * the fleet box this was built against, a genuine ONLINE Parakeet recogniser
 * produced its first partial after 48.35 s for a 7.43 s sample and its final at
 * around 325 s — roughly 44× slower than real time. There is no version of that
 * which can be rendered as "live". So there is no WebSocket here, no partial
 * frames, and no `streaming` flag to tempt anyone: the reader holds the button,
 * sees `Recording…`, lets go, sees `Transcribing…`, and gets text.
 *
 * It owns its `fetch` calls rather than routing through the typed client
 * because it posts BINARY with an audio content-type and needs an
 * `AbortSignal` per utterance.
 *
 * WHAT CHANGED — survey row #32. kteam bound status, install and transcribe to
 * the page's own origin and one module-level token captured at import time
 * (`ui/src/lib/stt/daemon-engine.ts:20-30,145-186,317-325,363-387`). It even
 * documented the consequence: a test that has to win a module-load race. A
 * static public bundle has neither an origin to inherit nor a token to capture,
 * and with several pairings alive there is no "the daemon" — so every entry
 * point here takes a `DaemonConnection` and builds its request with
 * `daemonRequest`, which pins the URL to that daemon's origin and carries that
 * daemon's device token. `daemonReachable` and `pageAuth` are gone with it: a
 * connection either exists or it does not.
 *
 * The session tag is a `DaemonSessionScope` rather than a bare id, and a scope
 * belonging to another daemon is REFUSED. Audio is the one thing in this app
 * that must never reach a daemon the reader did not choose.
 */

import type { DaemonConnection } from '../daemon-connection.ts';
import { daemonRequest } from '../daemon-transport.ts';
import type { DaemonSessionScope } from '../daemon-scope.ts';
import { encodeWav, floatToPcm16, TARGET_SAMPLE_RATE } from './pcm.ts';

export const STT_STATUS_PATH = '/v1/stt/status';
export const STT_TRANSCRIBE_PATH = '/v1/stt/transcribe';

/**
 * Start a box-side model download. Progress is then read from
 * `models.<kind>.install` on the next `GET /v1/stt/status`.
 *
 * A 404 or 405 from it is treated as "this box cannot install models from the
 * browser", which is also exactly the right behaviour against a daemon older
 * than this page.
 */
export const sttModelInstallPath = (modelId: string): string => `/v1/stt/models/${encodeURIComponent(modelId)}/install`;

/*
 * ── The daemon's status shape ─────────────────────────────────────────────
 *
 * MIRRORED, but NOT trusted: every field below is read defensively, because a
 * reader can pair a daemon older than this bundle. A daemon with no STT routes
 * at all answers 404, and that is a normal, expected state — the reader sees
 * "this box has no dictation support yet", not an error.
 */

export type DaemonWorkerPhase = 'cold' | 'loading' | 'ready' | 'busy' | 'error' | 'closed';
export type DaemonModelState = 'not-installed' | 'installing' | 'ready' | 'error';
export type DaemonInstallPhase = 'idle' | 'downloading' | 'extracting' | 'verifying' | 'ready' | 'failed';

export interface DaemonModelCosts {
  readonly downloadBytes: number;
  readonly diskBytes: number;
  readonly ramBytesApprox: number;
  /**
   * The daemon's own one-line summary. Rendered VERBATIM — the box knows the
   * real numbers for the model it pinned and the UI must not paraphrase.
   */
  readonly summary: string;
}

export interface DaemonModelInstall {
  readonly phase: DaemonInstallPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly message?: string;
  readonly code?: string;
}

export interface DaemonModelStatus {
  readonly id: string;
  readonly kind: 'daemon' | 'browser';
  readonly label: string;
  readonly state: DaemonModelState;
  readonly languages: readonly string[];
  readonly costs: DaemonModelCosts;
  readonly installedAt?: string;
  readonly install: DaemonModelInstall;
}

export interface DaemonSttStatus {
  /**
   * False when the route is missing, the subsystem is unwired, or no model is
   * installed. The control still renders — local mode may be available — but
   * daemon mode says why it cannot run.
   */
  readonly available: boolean;
  /**
   * The daemon's own promise that it never claims live text. Read so the UI
   * can assert it rather than assume it.
   */
  readonly streaming: boolean;
  readonly worker: {
    readonly phase: DaemonWorkerPhase;
    readonly modelId?: string;
    readonly lastError?: { readonly code?: string; readonly message?: string; readonly at?: string };
  };
  /** What the daemon can transcribe. English only today. */
  readonly languages: readonly string[];
  /** The model the daemon itself runs. */
  readonly daemonModel?: DaemonModelStatus;
  /**
   * The model the daemon HOSTS for browsers. Its `state` is the honest answer
   * to "can this device even download the browser model?" — if the box has not
   * fetched the weights, no browser can.
   */
  readonly browserModel?: DaemonModelStatus;
  readonly limits?: {
    readonly maxDurationSeconds?: number;
    readonly maxPcmBytes?: number;
    readonly sampleRate?: number;
  };
  /** Present when `available` is false and we know why. */
  readonly unavailableReason?: string;
}

export interface DaemonTranscript {
  readonly text: string;
  readonly audioMs?: number;
  readonly decodeMs?: number;
  readonly rtf?: number;
  readonly modelId?: string;
}

export type SttErrorCode =
  | 'unauthorized'
  | 'unavailable'
  | 'busy'
  | 'too-long'
  | 'bad-audio'
  | 'network'
  | 'aborted'
  | 'unknown';

export class SttRequestError extends Error {
  readonly code: SttErrorCode;
  readonly status: number;

  constructor(code: SttErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'SttRequestError';
    this.code = code;
    this.status = status;
  }
}

/**
 * HTTP status → the code the UI branches on. The daemon also returns its own
 * `code` in the body and that wins when present; this is the floor.
 */
export const sttErrorForStatus = (status: number, bodyCode?: string): SttErrorCode => {
  if (bodyCode === 'busy') return 'busy';
  if (bodyCode === 'too_long') return 'too-long';
  if (bodyCode === 'bad_audio') return 'bad-audio';
  if (bodyCode === 'model_missing' || bodyCode === 'worker_unavailable') return 'unavailable';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404 || status === 503) return 'unavailable';
  if (status === 409) return 'busy';
  if (status === 413) return 'too-long';
  if (status === 400) return 'bad-audio';
  return 'unknown';
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const browserFetch: FetchLike = (input, init) => fetch(input, init);

const unavailableStatus = (reason: string): DaemonSttStatus => ({
  available: false,
  streaming: false,
  worker: { phase: 'closed' },
  languages: [],
  unavailableReason: reason,
});

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
};

const num = (source: Record<string, unknown>, key: string, fallback: number): number => {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const optionalNum = (source: Record<string, unknown>, key: string): number | undefined => {
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
};

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const WORKER_PHASES: readonly DaemonWorkerPhase[] = ['cold', 'loading', 'ready', 'busy', 'error', 'closed'];
const MODEL_STATES: readonly DaemonModelState[] = ['not-installed', 'installing', 'ready', 'error'];
const INSTALL_PHASES: readonly DaemonInstallPhase[] = [
  'idle',
  'downloading',
  'extracting',
  'verifying',
  'ready',
  'failed',
];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const parseModelStatus = (value: unknown, kind: 'daemon' | 'browser'): DaemonModelStatus | undefined => {
  const source = record(value);
  if (source === undefined) return undefined;
  const costs = record(source.costs) ?? {};
  const install = record(source.install) ?? {};
  return {
    id: str(source, 'id') ?? '',
    kind: source.kind === 'daemon' || source.kind === 'browser' ? source.kind : kind,
    label: str(source, 'label') ?? '',
    state: oneOf(source.state, MODEL_STATES, 'not-installed'),
    languages: strings(source.languages),
    costs: {
      downloadBytes: num(costs, 'downloadBytes', 0),
      diskBytes: num(costs, 'diskBytes', 0),
      ramBytesApprox: num(costs, 'ramBytesApprox', 0),
      summary: str(costs, 'summary') ?? '',
    },
    installedAt: str(source, 'installedAt'),
    install: {
      phase: oneOf(install.phase, INSTALL_PHASES, 'idle'),
      receivedBytes: num(install, 'receivedBytes', 0),
      totalBytes: num(install, 'totalBytes', 0),
      message: str(install, 'message'),
      code: str(install, 'code'),
    },
  };
};

const parseLimits = (value: unknown): DaemonSttStatus['limits'] => {
  const limits = record(value);
  if (limits === undefined) return undefined;
  return {
    maxDurationSeconds: optionalNum(limits, 'maxDurationSeconds'),
    maxPcmBytes: optionalNum(limits, 'maxPcmBytes'),
    sampleRate: optionalNum(limits, 'sampleRate'),
  };
};

/**
 * Defensive shape read of the daemon's STT status. Exported so the parse has a
 * test that does not need a server.
 */
export const parseDaemonSttStatus = (body: unknown): DaemonSttStatus => {
  const source = record(body);
  if (source === undefined) return unavailableStatus('The daemon sent an unreadable status.');

  const worker = record(source.worker) ?? {};
  const lastError = record(worker.lastError);
  const models = record(source.models) ?? {};

  return {
    available: source.available === true,
    // Only a literal `false` counts as the daemon's no-live-text promise; a
    // missing field is read as "we do not know", which the UI treats the same
    // way it treats every other unknown — by saying nothing about it.
    streaming: source.streaming === true,
    worker: {
      phase: oneOf(worker.phase, WORKER_PHASES, 'closed'),
      modelId: str(worker, 'modelId'),
      lastError:
        lastError === undefined
          ? undefined
          : { code: str(lastError, 'code'), message: str(lastError, 'message'), at: str(lastError, 'at') },
    },
    languages: strings(source.languages),
    daemonModel: parseModelStatus(models.daemon, 'daemon'),
    browserModel: parseModelStatus(models.browser, 'browser'),
    limits: parseLimits(source.limits),
  };
};

export interface DaemonSttRequestOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
}

/** Read ONE paired daemon's dictation status. Never throws. */
export async function daemonSttStatus(
  daemon: DaemonConnection,
  options: DaemonSttRequestOptions = {},
): Promise<DaemonSttStatus> {
  const send = options.fetchImpl ?? browserFetch;
  const request = daemonRequest(daemon, STT_STATUS_PATH, { signal: options.signal });
  let response: Response;
  try {
    response = await send(request.url, request.init);
  } catch {
    return unavailableStatus('The daemon could not be reached.');
  }
  if (!response.ok) {
    // A 404 is the normal answer from a daemon built before this feature: the
    // route simply is not there. That is "unavailable", not "broken".
    return unavailableStatus(
      response.status === 404
        ? 'This box has no dictation support yet.'
        : `The daemon answered HTTP ${response.status}.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unavailableStatus('The daemon sent an unreadable status.');
  }
  return parseDaemonSttStatus(body);
}

export interface DaemonModelInstallOutcome {
  readonly started: boolean;
  readonly message?: string;
}

/**
 * Ask ONE paired box to download a model it does not have. Progress is then
 * read from `models.<kind>.install` on the next status poll.
 */
export async function requestDaemonModelInstall(
  daemon: DaemonConnection,
  modelId: string,
  options: DaemonSttRequestOptions = {},
): Promise<DaemonModelInstallOutcome> {
  const send = options.fetchImpl ?? browserFetch;
  const request = daemonRequest(daemon, sttModelInstallPath(modelId), {
    method: 'POST',
    signal: options.signal,
  });
  let response: Response;
  try {
    response = await send(request.url, request.init);
  } catch {
    return { started: false, message: 'The daemon could not be reached.' };
  }
  if (response.status === 404 || response.status === 405) {
    return {
      started: false,
      message: 'This box cannot start a model download from the browser. Install it on the box instead.',
    };
  }
  if (!response.ok) {
    let message: string | undefined;
    try {
      message = str(record(await response.json()) ?? {}, 'error');
    } catch {
      // A non-JSON error body is still an error.
    }
    return { started: false, message: message ?? `The daemon refused the install (HTTP ${response.status}).` };
  }
  return { started: true };
}

export interface DaemonTranscribeOptions extends DaemonSttRequestOptions {
  /** 16 kHz mono float samples, straight out of audio capture. */
  readonly samples: Float32Array;
  /**
   * Ignored by an English-only daemon, sent anyway so a future multilingual
   * model needs no client change.
   */
  readonly language?: string;
  /**
   * Which session the utterance belongs to. A scope from ANOTHER daemon is
   * refused rather than silently posted here.
   */
  readonly scope?: DaemonSessionScope;
  /**
   * WAV by default. `raw` posts `audio/L16`, which is 44 bytes smaller and
   * exactly as correct — kept because the daemon accepts both and a raw body
   * is easier to reason about at the boundary.
   */
  readonly encoding?: 'wav' | 'raw';
}

const transcribePath = (language: string, scope: DaemonSessionScope | undefined): string => {
  const query = new URLSearchParams({ language });
  if (scope !== undefined) query.set('sessionId', scope.sessionId);
  return `${STT_TRANSCRIBE_PATH}?${query.toString()}`;
};

export async function daemonTranscribe(
  daemon: DaemonConnection,
  options: DaemonTranscribeOptions,
): Promise<DaemonTranscript> {
  const { samples, language = 'en', scope } = options;
  if (scope !== undefined && scope.daemonId !== daemon.daemonId) {
    throw new SttRequestError('bad-audio', 'That session belongs to a different daemon.', 0);
  }
  if (samples.length === 0) throw new SttRequestError('bad-audio', 'No audio was captured.', 0);

  const pcm = floatToPcm16(samples);
  const raw = options.encoding === 'raw';
  const body = raw ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) : encodeWav(pcm, TARGET_SAMPLE_RATE);
  const contentType = raw ? `audio/L16; rate=${TARGET_SAMPLE_RATE}; channels=1` : 'audio/wav';

  const send = options.fetchImpl ?? browserFetch;
  const request = daemonRequest(daemon, transcribePath(language, scope), {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: body as unknown as BodyInit,
    signal: options.signal,
  });

  let response: Response;
  try {
    response = await send(request.url, request.init);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new SttRequestError('aborted', 'Transcription was cancelled.', 0);
    }
    throw new SttRequestError('network', 'The daemon could not be reached.', 0);
  }

  if (!response.ok) {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const parsed = record(await response.json()) ?? {};
      code = str(parsed, 'code');
      message = str(parsed, 'error');
    } catch {
      // A non-JSON error body is still an error.
    }
    throw new SttRequestError(
      sttErrorForStatus(response.status, code),
      message ?? `The daemon refused the recording (HTTP ${response.status}).`,
      response.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new SttRequestError('unknown', 'The daemon sent an unreadable transcript.', response.status);
  }
  return parseDaemonTranscript(parsed);
}

export const parseDaemonTranscript = (body: unknown): DaemonTranscript => {
  const source = record(body);
  if (source === undefined) return { text: '' };
  // ONLY the raw `text` is read. The daemon may also send an `enhanced` field;
  // this client deliberately ignores it and runs its OWN enhancer over `text`,
  // so daemon and browser modes produce identical output from identical audio
  // and there is exactly one place where a substitution can happen.
  return {
    text: str(source, 'text') ?? '',
    audioMs: optionalNum(source, 'audioMs'),
    decodeMs: optionalNum(source, 'decodeMs'),
    rtf: optionalNum(source, 'rtf'),
    modelId: str(source, 'modelId'),
  };
};
