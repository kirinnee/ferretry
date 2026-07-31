import {
  STT_BITS_PER_SAMPLE,
  STT_CHANNELS,
  STT_MAX_DURATION_SECONDS,
  STT_SAMPLE_RATE,
  type SttModelStatus,
  type SttStatus,
  type SttTranscript,
  type SttWorkerStatus,
} from '@ferretry/protocol';
import { SttError } from './errors.ts';

/** Headroom for a WAV container's header and any unknown chunks it carries. */
export const WAV_CONTAINER_OVERHEAD_BYTES = 4_096;

/** The default ceiling on one dictation, in seconds. */
export const STT_MAX_DURATION_SECONDS_DEFAULT = STT_MAX_DURATION_SECONDS;

export interface SttLimits {
  readonly sampleRate: typeof STT_SAMPLE_RATE;
  readonly channels: typeof STT_CHANNELS;
  readonly bitsPerSample: typeof STT_BITS_PER_SAMPLE;
  readonly maxDurationSeconds: number;
  readonly maxPcmBytes: number;
}

export function sttLimits(maxDurationSeconds: number): SttLimits {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new RangeError('maxDurationSeconds must be a positive finite number');
  }
  const seconds = Math.floor(maxDurationSeconds);
  return {
    sampleRate: STT_SAMPLE_RATE,
    channels: STT_CHANNELS,
    bitsPerSample: STT_BITS_PER_SAMPLE,
    maxDurationSeconds: seconds,
    maxPcmBytes: seconds * STT_SAMPLE_RATE * (STT_BITS_PER_SAMPLE / 8),
  };
}

/** The largest body worth reading for a given container. */
export function maxRequestBytes(limits: SttLimits, container: 'wav' | 'pcm16le'): number {
  return container === 'wav' ? limits.maxPcmBytes + WAV_CONTAINER_OVERHEAD_BYTES : limits.maxPcmBytes;
}

export interface SttStatusFacts {
  readonly worker: SttWorkerStatus;
  readonly models: { readonly daemon: SttModelStatus; readonly browser: SttModelStatus };
  readonly closed: boolean;
  readonly maxDurationSeconds: number;
}

/**
 * Project the subsystem status.
 *
 * `available` is derived, never supplied: the wire schema requires it to equal
 * "daemon model ready and the worker neither closed nor failed". The source
 * folded a separate `closed` flag into `available` while still reporting the
 * last live worker phase, which produced a status that failed its own schema.
 * A closed service reports a closed worker instead, so the two agree.
 */
export function projectSttStatus(facts: SttStatusFacts): SttStatus {
  const worker: SttWorkerStatus = facts.closed ? { phase: 'closed' } : facts.worker;
  return {
    available: facts.models.daemon.state === 'ready' && worker.phase !== 'closed' && worker.phase !== 'error',
    streaming: false,
    mode: 'batch',
    language: 'en',
    languages: ['en'],
    worker,
    models: facts.models,
    limits: sttLimits(facts.maxDurationSeconds),
  };
}

export interface WorkerTranscription {
  readonly text: string;
  readonly modelId: string;
  readonly audioMs: number;
  readonly decodeMs: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The real-time factor is only meaningful when there was audio to decode. */
export function projectTranscript(result: WorkerTranscription): SttTranscript {
  const audioMs = nonNegative(result.audioMs);
  const decodeMs = nonNegative(result.decodeMs);
  return {
    text: result.text,
    audioMs,
    decodeMs,
    rtf: audioMs > 0 ? decodeMs / audioMs : 0,
    modelId: result.modelId,
    language: 'en',
    mode: 'batch',
    streaming: false,
  };
}

/**
 * Decide whether a transcription may proceed. Each refusal is the one code the
 * client can act on: install the model, wait for the install, retry later, or
 * stop asking because the daemon is shutting down.
 */
export function assertCanTranscribe(facts: {
  readonly closed: boolean;
  readonly daemon: SttModelStatus;
  readonly worker: SttWorkerStatus;
}): void {
  if (facts.closed) throw new SttError('service_closed', 'speech-to-text is shutting down');
  if (facts.daemon.state === 'installing') {
    throw new SttError('model_installing', 'the daemon model is still installing');
  }
  if (facts.daemon.state !== 'ready') throw new SttError('model_missing', 'the daemon model is not installed');
  if (facts.worker.phase === 'busy') throw new SttError('busy', 'the batch transcriber is busy');
  if (facts.worker.phase === 'closed') throw new SttError('worker_unavailable', 'the batch transcriber is not running');
}
