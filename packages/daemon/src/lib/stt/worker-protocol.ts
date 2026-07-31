import {
  STT_MAX_SAMPLES,
  STT_SAMPLE_RATE,
  type SttErrorCode,
  type SttWorkerModel,
  type SttWorkerRequest,
  SttWorkerRequestSchema,
  type SttWorkerResponse,
  SttWorkerResponseSchema,
  type SttWorkerStatus,
} from '@ferretry/protocol';
import { SttError } from './errors.ts';

/** Worker errors are a narrow subset: the child never invents a wire code. */
export type SttWorkerErrorCode = Extract<
  SttErrorCode,
  'bad_request' | 'bad_audio' | 'too_long' | 'model_missing' | 'native_missing' | 'load_failed' | 'decode_failed'
>;

export const MIN_WORKER_THREADS = 1;
export const MAX_WORKER_THREADS = 32;
const MAX_WORKER_MESSAGE_CHARS = 1_000;

/** A message that never survives round-tripping is not a request. */
export function parseWorkerRequest(message: unknown): SttWorkerRequest | undefined {
  const parsed = SttWorkerRequestSchema.safeParse(message);
  return parsed.success ? parsed.data : undefined;
}

export function parseWorkerResponse(message: unknown): SttWorkerResponse | undefined {
  const parsed = SttWorkerResponseSchema.safeParse(message);
  return parsed.success ? parsed.data : undefined;
}

/** The request id of an unparsable message, so a caller can still be answered. */
export function requestIdOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = (message as { requestId?: unknown }).requestId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export function workerErrorResponse(code: SttWorkerErrorCode, message: string, requestId?: string): SttWorkerResponse {
  return { type: 'error', code, message, ...(requestId === undefined ? {} : { requestId }) };
}

/** Bounded so a provider or native message can never flood a log or a wire. */
export function boundedWorkerMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return (raw.trim().length === 0 ? fallback : raw).slice(0, MAX_WORKER_MESSAGE_CHARS);
}

/**
 * Separate "the weights are not there" from "the native runtime is not there"
 * from everything else: only the first two tell the operator what to install.
 */
export function classifyLoadFailure(
  error: unknown,
): Extract<SttWorkerErrorCode, 'model_missing' | 'native_missing' | 'load_failed'> {
  const message = boundedWorkerMessage(error, 'model load failed');
  if (/ENOENT|no such file|not a regular file|model.*missing/iu.test(message)) return 'model_missing';
  if (/libstdc\+\+|shared object|dlopen|cannot find module|native|sherpa/iu.test(message)) return 'native_missing';
  return 'load_failed';
}

export function isValidThreadCount(threads: number): boolean {
  return Number.isInteger(threads) && threads >= MIN_WORKER_THREADS && threads <= MAX_WORKER_THREADS;
}

/** Audio the recognizer would reject or choke on is refused before it is fed. */
export function audioRefusal(samples: Float32Array): { code: 'bad_audio' | 'too_long'; message: string } | undefined {
  if (samples.length === 0) return { code: 'bad_audio', message: 'audio is empty' };
  if (samples.length > STT_MAX_SAMPLES) {
    return { code: 'too_long', message: `audio exceeds the ${STT_MAX_SAMPLES / STT_SAMPLE_RATE} second limit` };
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return { code: 'bad_audio', message: 'audio samples must be finite' };
  }
  return undefined;
}

export function audioDurationMs(samples: Float32Array): number {
  return (samples.length / STT_SAMPLE_RATE) * 1_000;
}

export function sameWorkerModel(left: SttWorkerModel | undefined, right: SttWorkerModel): boolean {
  return left !== undefined && left.id === right.id && left.directory === right.directory;
}

export type WorkerFailure = { readonly code: SttErrorCode; readonly message: string; readonly at: string };

/**
 * Project the supervisor's facts into the wire status. The phase is derived, so
 * a worker cannot report `ready` while a load is still in flight, nor `busy`
 * after it has been closed.
 */
export function projectWorkerStatus(facts: {
  readonly closed: boolean;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly pid?: number;
  readonly modelId?: string;
  readonly loadedAt?: string;
  readonly lastError?: WorkerFailure;
}): SttWorkerStatus {
  if (facts.closed) return { phase: 'closed' };
  if (facts.lastError !== undefined) {
    return {
      phase: 'error',
      ...(facts.pid === undefined ? {} : { pid: facts.pid }),
      ...(facts.modelId === undefined ? {} : { modelId: facts.modelId }),
      lastError: facts.lastError,
    };
  }
  if (facts.loading) {
    return {
      phase: 'loading',
      ...(facts.pid === undefined ? {} : { pid: facts.pid }),
      ...(facts.modelId === undefined ? {} : { modelId: facts.modelId }),
    };
  }
  if (facts.pid === undefined || facts.modelId === undefined || facts.loadedAt === undefined) {
    return { phase: 'cold' };
  }
  return {
    phase: facts.busy ? 'busy' : 'ready',
    pid: facts.pid,
    modelId: facts.modelId,
    loadedAt: facts.loadedAt,
  };
}

/** The wire error a caller sees when the child fails, keyed by how it failed. */
export function workerRequestFailure(response: Extract<SttWorkerResponse, { type: 'error' }>): SttError {
  return new SttError(response.code, response.message);
}

/** An unexpected exit is a crash; a requested one is not. */
export function exitFailure(
  exitCode: number | null,
  signal: string | number | null,
  stderrTail: string,
  at: string,
): WorkerFailure {
  const how = signal === null ? `exit code ${exitCode ?? 'unknown'}` : `signal ${String(signal)}`;
  const tail = stderrTail.trim().slice(-MAX_WORKER_MESSAGE_CHARS);
  return {
    code: 'worker_crashed',
    message:
      tail.length === 0 ? `the batch transcriber stopped (${how})` : `the batch transcriber stopped (${how}): ${tail}`,
    at,
  };
}
