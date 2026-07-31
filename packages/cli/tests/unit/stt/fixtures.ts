import {
  STT_BITS_PER_SAMPLE,
  STT_CHANNELS,
  STT_MAX_PCM_BYTES,
  STT_SAMPLE_RATE,
  type SttEnhancementRequest,
  type SttEnhancementResult,
  type SttModelListResponse,
  type SttModelStatus,
  type SttStatus,
  type SttTranscript,
  type SttWorkerStatus,
} from '@ferretry/protocol';
import type { IDelay } from '../../../src/lib/stt/controller';
import type { IAudioFileReader, ISttGateway, ISttOutput } from '../../../src/lib/stt/ports';

/** Captures what a controller printed, keeping stdout and warnings apart. */
export class CapturingOutput implements ISttOutput {
  readonly lines: string[] = [];
  readonly warnings: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

const costs = { downloadBytes: 512_000_000, diskBytes: 600_000_000, ramBytesApprox: 900_000_000, summary: '' };

export function readyModel(overrides: Partial<{ id: string; kind: 'daemon' | 'browser' }> = {}): SttModelStatus {
  return {
    id: overrides.id ?? 'parakeet-v3',
    kind: overrides.kind ?? 'daemon',
    label: 'Parakeet v3',
    languages: ['en'],
    costs,
    state: 'ready',
    installedAt: '2026-07-30T09:00:00.000Z',
    files: [{ name: 'encoder.onnx', bytes: 400_000_000, sha256: 'a'.repeat(64) }],
    install: {
      modelId: 'parakeet-v3',
      receivedBytes: 512_000_000,
      totalBytes: 512_000_000,
      phase: 'ready',
      finishedAt: '2026-07-30T09:00:00.000Z',
    },
  };
}

export function missingModel(id = 'parakeet-v3', kind: 'daemon' | 'browser' = 'daemon'): SttModelStatus {
  return {
    id,
    kind,
    label: 'Parakeet v3',
    languages: ['en'],
    costs,
    state: 'not-installed',
    install: { modelId: id, receivedBytes: 0, totalBytes: 0, phase: 'idle' },
  };
}

export function installingModel(received = 128_000_000, total = 512_000_000): SttModelStatus {
  return {
    id: 'parakeet-v3',
    kind: 'daemon',
    label: 'Parakeet v3',
    languages: ['en'],
    costs,
    state: 'installing',
    install: {
      modelId: 'parakeet-v3',
      receivedBytes: received,
      totalBytes: total,
      phase: 'downloading',
      startedAt: '2026-07-31T09:00:00.000Z',
    },
  };
}

export function failedModel(message = 'checksum mismatch'): SttModelStatus {
  return {
    id: 'parakeet-v3',
    kind: 'daemon',
    label: 'Parakeet v3',
    languages: ['en'],
    costs,
    state: 'error',
    install: {
      modelId: 'parakeet-v3',
      receivedBytes: 512_000_000,
      totalBytes: 512_000_000,
      phase: 'failed',
      finishedAt: '2026-07-31T09:10:00.000Z',
      message,
      code: 'install_failed',
    },
  };
}

export function modelList(
  daemon: SttModelStatus = readyModel(),
  browser: SttModelStatus = missingModel('whisper-tiny', 'browser'),
): SttModelListResponse {
  return { models: { daemon, browser } };
}

const readyWorker: SttWorkerStatus = {
  phase: 'ready',
  pid: 4321,
  modelId: 'parakeet-v3',
  loadedAt: '2026-07-31T09:00:00.000Z',
};

export function sttStatus(overrides: Partial<Pick<SttStatus, 'worker' | 'models' | 'available'>> = {}): SttStatus {
  const models = overrides.models ?? modelList().models;
  const worker = overrides.worker ?? readyWorker;
  return {
    available:
      overrides.available ?? (models.daemon.state === 'ready' && worker.phase !== 'closed' && worker.phase !== 'error'),
    streaming: false,
    mode: 'batch',
    language: 'en',
    languages: ['en'],
    worker,
    models,
    limits: {
      sampleRate: STT_SAMPLE_RATE,
      channels: STT_CHANNELS,
      bitsPerSample: STT_BITS_PER_SAMPLE,
      maxDurationSeconds: 120,
      maxPcmBytes: STT_MAX_PCM_BYTES,
    },
  };
}

export function transcript(overrides: Partial<SttTranscript> = {}): SttTranscript {
  return {
    text: 'never install at the repository root',
    audioMs: 4_000,
    decodeMs: 800,
    rtf: 0.2,
    modelId: 'parakeet-v3',
    language: 'en',
    mode: 'batch',
    streaming: false,
    ...overrides,
  };
}

export function enhancement(overrides: Partial<SttEnhancementResult> = {}): SttEnhancementResult {
  return {
    text: 'Never install at the repository root.',
    provider: 'groq',
    model: 'llama-3.3-70b',
    latencyMs: 320,
    ...overrides,
  };
}

/** A reader answering with fixed bytes, so no test touches a real audio file. */
export class StubAudioFileReader implements IAudioFileReader {
  readonly read_: string[] = [];

  constructor(private readonly bytes: Uint8Array = new Uint8Array(3_200)) {}

  read(path: string): Promise<Uint8Array> {
    this.read_.push(path);
    return Promise.resolve(this.bytes);
  }
}

/** A delay that records what it was asked to wait for and returns at once. */
export class RecordingDelay implements IDelay {
  readonly waited: number[] = [];

  wait(milliseconds: number): Promise<void> {
    this.waited.push(milliseconds);
    return Promise.resolve();
  }
}

/** What one transcription call carried. */
export interface TranscribeCall {
  readonly bytes: number;
  readonly contentType: string;
}

/** A gateway answering from fixed views and recording what was asked of it. */
export class RecordingSttGateway implements ISttGateway {
  readonly installed: string[] = [];
  readonly polled: string[] = [];
  readonly transcribed: TranscribeCall[] = [];
  readonly enhanced: SttEnhancementRequest[] = [];

  constructor(
    private readonly views: {
      status?: SttStatus;
      models?: SttModelListResponse;
      install?: SttModelStatus;
      /** Consumed one per poll; the last entry repeats once exhausted. */
      polls?: readonly SttModelStatus[];
      transcript?: SttTranscript;
      enhancement?: SttEnhancementResult;
    } = {},
  ) {}

  status(): Promise<SttStatus> {
    return Promise.resolve(this.views.status ?? sttStatus());
  }

  models(): Promise<SttModelListResponse> {
    return Promise.resolve(this.views.models ?? modelList());
  }

  modelStatus(modelId: string): Promise<SttModelStatus> {
    this.polled.push(modelId);
    const polls = this.views.polls ?? [readyModel()];
    const index = Math.min(this.polled.length - 1, polls.length - 1);
    return Promise.resolve(polls[index] ?? readyModel());
  }

  install(modelId: string): Promise<SttModelStatus> {
    this.installed.push(modelId);
    return Promise.resolve(this.views.install ?? installingModel());
  }

  transcribe(audio: Uint8Array, contentType: string): Promise<SttTranscript> {
    this.transcribed.push({ bytes: audio.byteLength, contentType });
    return Promise.resolve(this.views.transcript ?? transcript());
  }

  enhance(request: SttEnhancementRequest): Promise<SttEnhancementResult> {
    this.enhanced.push(request);
    return Promise.resolve(this.views.enhancement ?? enhancement());
  }
}
