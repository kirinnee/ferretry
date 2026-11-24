import type { Clock } from '@ferretry/kernel/contract';
import { minutes } from '@ferretry/std';
import {
  type VoiceEngineApi,
  VoiceEngineError,
  type VoiceEngineFailureCode,
  type VoiceEngineSelfTest,
  type VoiceEngineView,
  type VoiceSpan,
  type VoiceTranscription,
} from '../../../contract/index.ts';
import { ENGINE_FILES, ENGINE_LABEL, type EngineFile } from './catalog.ts';
import { installFiles } from './installer.ts';
import type { EngineFilesPort, HttpPort, SpeechThread } from './ports.ts';
import { LOAD_ROLES, type LoadRole, SPEECH_SAMPLE_RATE } from './protocol.ts';

/** The models leave memory this long after the last use. */
export const IDLE_UNLOAD = minutes(10);

/** What loading needs free beyond the files themselves: the graphs' own copies and the worker's working memory. */
export const LOAD_HEADROOM_BYTES = 1_500_000_000;

export interface EngineParts {
  readonly http: HttpPort;
  readonly files: EngineFilesPort;
  readonly clock: Pick<Clock, 'after'>;
  /** What this machine is called, read at each use (the owner can rename it while the daemon runs). */
  readonly machine: () => string;
  /** Starts one speech thread. */
  readonly start: () => SpeechThread;
  /** Memory the machine could give a new process, in bytes. `undefined` when it cannot say (no check is made). */
  readonly availableMemory: () => number | undefined;
  readonly log: {
    info(message: string, fields?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
    warn(message: string, fields?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
  };
  readonly catalog?: readonly EngineFile[];
}

const SENTENCES: Record<VoiceEngineFailureCode, string> = {
  download_failed: 'The speech files could not be downloaded. Check this machine’s internet and try again.',
  hash_mismatch: 'A downloaded speech file was not the file this version expects, so nothing was kept. Try again.',
  write_failed: 'The speech files could not be saved on this machine. Check its free disk space and try again.',
  no_memory: 'This machine does not have enough free memory to load speech right now.',
  load_failed: 'The speech files are saved but the engine could not start with them.',
};

/**
 * The machine speech engine (owner decision O2: sherpa-onnx WebAssembly in a worker thread first). It owns three
 * things: what is installed (read from disk, so a restart forgets nothing), the background install, and the one
 * worker thread, started on first use and ended after {@link IDLE_UNLOAD} without a call so its memory is freed.
 */
export class SpeechEngine implements VoiceEngineApi {
  private installing: Promise<void> | undefined;
  private doneBytes = 0;
  private failure: { code: VoiceEngineFailureCode; sentence: string } | undefined;
  private selfTest: VoiceEngineSelfTest | undefined;
  private thread: SpeechThread | undefined;
  private loading: Promise<SpeechThread> | undefined;
  private cancelIdle: (() => void) | undefined;

  constructor(private readonly parts: EngineParts) {}

  private get catalog(): readonly EngineFile[] {
    return this.parts.catalog ?? ENGINE_FILES;
  }

  private async installedBytes(): Promise<number> {
    let total = 0;
    for (const file of this.catalog) if ((await this.parts.files.size(file)) === file.bytes) total += file.bytes;
    return total;
  }

  async view(): Promise<VoiceEngineView> {
    const sizeBytes = this.catalog.reduce((sum, file) => sum + file.bytes, 0);
    const installed = await this.installedBytes();
    // Saved is not ready: a failure after the download (the models would not load) keeps it `failed` until a retry.
    const state =
      this.installing !== undefined
        ? 'installing'
        : this.failure !== undefined
          ? 'failed'
          : installed === sizeBytes
            ? 'ready'
            : 'not_installed';
    return {
      state,
      machine: this.parts.machine(),
      label: ENGINE_LABEL,
      sizeBytes,
      doneBytes: state === 'installing' ? Math.max(this.doneBytes, installed) : installed,
      loaded: this.thread !== undefined && this.loading === undefined,
      ...(this.failure !== undefined && state === 'failed' ? { failure: this.failure } : {}),
      ...(this.selfTest !== undefined && state === 'ready' ? { selfTest: this.selfTest } : {}),
    };
  }

  async install(): Promise<VoiceEngineView> {
    if (this.installing === undefined) {
      this.failure = undefined;
      this.doneBytes = 0;
      const run = installFiles(
        this.parts.http,
        this.parts.files,
        received => {
          this.doneBytes += received;
        },
        this.catalog,
      )
        .then(async () => await this.proveItLoads())
        .catch((error: unknown) => {
          const code = error instanceof VoiceEngineError && error.code !== 'not_ready' ? error.code : 'download_failed';
          this.failure = { code, sentence: SENTENCES[code] };
          this.parts.log.warn('voice.engine.install_failed', { code });
        })
        .finally(() => {
          this.installing = undefined;
        });
      this.installing = run;
    }
    return await this.view();
  }

  /** Resolves when the running install has ended (a test and the route's own follow-up wait on it). */
  async settled(): Promise<void> {
    await this.installing;
  }

  /** Install ends by loading once and decoding a second of silence: "Ready" means it ran, not only that it is saved. */
  private async proveItLoads(): Promise<void> {
    const loadedAt = await this.ensureLoaded();
    const silence = new Float32Array(SPEECH_SAMPLE_RATE);
    const reply = await loadedAt.thread.call({ kind: 'transcribe', samples: silence }, [silence.buffer]);
    if (reply.kind !== 'transcribe') throw new VoiceEngineError('load_failed', SENTENCES.load_failed);
    this.selfTest = { loadMs: loadedAt.loadMs, decodeMs: reply.decodeMs, memoryMb: loadedAt.memoryMb };
    this.parts.log.info('voice.engine.ready', { ...this.selfTest });
  }

  async remove(): Promise<VoiceEngineView> {
    if (this.installing !== undefined) throw new VoiceEngineError('not_ready', 'Wait for the install to finish first.');
    await this.unload();
    for (const file of this.catalog) await this.parts.files.remove(file);
    this.selfTest = undefined;
    this.failure = undefined;
    return await this.view();
  }

  async transcribe(samples: Float32Array): Promise<VoiceTranscription> {
    const { thread } = await this.ensureLoaded();
    const audioSeconds = samples.length / SPEECH_SAMPLE_RATE;
    const copy = samples.slice();
    try {
      const reply = await thread.call({ kind: 'transcribe', samples: copy }, [copy.buffer]);
      if (reply.kind !== 'transcribe') throw new VoiceEngineError('load_failed', SENTENCES.load_failed);
      return {
        text: reply.text,
        decodeMs: reply.decodeMs,
        realTimeFactor: audioSeconds === 0 ? 0 : reply.decodeMs / 1000 / audioSeconds,
      };
    } finally {
      this.touch();
    }
  }

  async detectSpeech(samples: Float32Array): Promise<readonly VoiceSpan[]> {
    const { thread } = await this.ensureLoaded();
    const copy = samples.slice();
    try {
      const reply = await thread.call({ kind: 'detect', samples: copy }, [copy.buffer]);
      if (reply.kind !== 'detect') throw new VoiceEngineError('load_failed', SENTENCES.load_failed);
      return reply.spans;
    } finally {
      this.touch();
    }
  }

  /** Ends the worker now, freeing its memory. A later call loads again. */
  async unload(): Promise<void> {
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    const thread = this.thread;
    this.thread = undefined;
    this.loading = undefined;
    await thread?.terminate();
  }

  private touch(): void {
    this.cancelIdle?.();
    this.cancelIdle = this.parts.clock.after(IDLE_UNLOAD, () => {
      this.cancelIdle = undefined;
      this.parts.log.info('voice.engine.idle_unload');
      void this.unload();
    });
  }

  private loadedAt: { thread: SpeechThread; loadMs: number; memoryMb: number } | undefined;

  private async ensureLoaded(): Promise<{ thread: SpeechThread; loadMs: number; memoryMb: number }> {
    if (this.thread !== undefined && this.loadedAt?.thread === this.thread) {
      this.touch();
      return this.loadedAt;
    }
    if (this.loading === undefined)
      this.loading = this.load().finally(() => {
        this.loading = undefined;
      });
    await this.loading;
    this.touch();
    if (this.loadedAt === undefined) throw new VoiceEngineError('load_failed', SENTENCES.load_failed);
    return this.loadedAt;
  }

  private async load(): Promise<SpeechThread> {
    const available = this.parts.availableMemory();
    if (
      available !== undefined &&
      available < LOAD_HEADROOM_BYTES + this.catalog.reduce((sum, file) => sum + file.bytes, 0)
    )
      throw new VoiceEngineError('no_memory', SENTENCES.no_memory);
    const files = {} as Record<LoadRole, ArrayBuffer>;
    for (const role of LOAD_ROLES) {
      const file = this.catalog.find(candidate => candidate.role === role);
      const bytes = file === undefined ? undefined : await this.parts.files.read(file);
      if (bytes === undefined) throw new VoiceEngineError('not_ready', 'Speech is not installed on this machine yet.');
      // The state read hands over a whole buffer: transfer it as it is, never a second 650 MB copy.
      files[role] =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    }
    const thread = this.parts.start();
    thread.onEnd(() => {
      if (this.thread === thread) {
        this.thread = undefined;
        this.loadedAt = undefined;
        this.loading = undefined;
      }
    });
    try {
      const reply = await thread.call({ kind: 'load', files }, Object.values(files));
      if (reply.kind !== 'load') throw new Error('unexpected reply');
      this.thread = thread;
      this.loadedAt = { thread, loadMs: reply.loadMs, memoryMb: reply.memoryMb };
      this.parts.log.info('voice.engine.loaded', { loadMs: Math.round(reply.loadMs), memoryMb: reply.memoryMb });
      return thread;
    } catch (error) {
      await thread.terminate();
      this.parts.log.warn('voice.engine.load_error', {
        reason: String((error as Error)?.message ?? error).slice(0, 400),
      });
      throw new VoiceEngineError('load_failed', SENTENCES.load_failed, { cause: error });
    }
  }
}
