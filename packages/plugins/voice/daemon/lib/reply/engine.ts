import type { Clock } from '@ferretry/kernel/contract';
import { minutes } from '@ferretry/std';
import {
  REPLY_SPEAKER_ID,
  type ReplySpeech,
  type ReplyVoiceApi,
  type ReplyVoiceSelfTest,
  type ReplyVoiceView,
  VoiceEngineError,
  type VoiceEngineFailureCode,
} from '../../../contract/index.ts';
import { installFiles } from '../engine/installer.ts';
import type { EnginePathsPort, HttpPort, ReplyThread } from '../engine/ports.ts';
import { REPLY_FILES, REPLY_LABEL, type ReplyFile } from './catalog.ts';

/** The voice leaves memory this long after the last use. */
export const REPLY_IDLE_UNLOAD = minutes(10);

/** What loading needs free beyond the files: the model's graph, the runtime's heap and its working memory. */
export const REPLY_LOAD_HEADROOM_BYTES = 800_000_000;

/** The line the install proves the voice with. It is spoken to nobody and measured, never stored. */
const TEST_LINE = 'Let me check the failing test.';

export interface ReplyEngineParts {
  readonly http: HttpPort;
  readonly files: EnginePathsPort;
  readonly clock: Pick<Clock, 'after'>;
  /** What this machine is called, read at each use (the owner can rename it while the daemon runs). */
  readonly machine: () => string;
  /** Starts one reply thread. */
  readonly start: () => ReplyThread;
  /** Memory the machine could give a new process, in bytes. `undefined` when it cannot say (no check is made). */
  readonly availableMemory: () => number | undefined;
  readonly log: {
    info(message: string, fields?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
    warn(message: string, fields?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
  };
  readonly catalog?: readonly ReplyFile[];
}

const SUPERSEDED = 'The reply voice was stopped while it was loading.';

const SENTENCES: Record<VoiceEngineFailureCode, string> = {
  download_failed: 'The reply voice could not be downloaded. Check this machine’s internet and try again.',
  hash_mismatch: 'A downloaded voice file was not the file this version expects, so nothing was kept. Try again.',
  write_failed: 'The reply voice could not be saved on this machine. Check its free disk space and try again.',
  no_disk: 'This machine does not have enough free disk space for the reply voice.',
  no_memory: 'This machine does not have enough free memory to load the reply voice right now.',
  load_failed: 'The reply voice is saved but could not start with these files.',
};

interface Loaded {
  readonly thread: ReplyThread;
  readonly loadMs: number;
  readonly memoryMb: number;
}

/**
 * The reply voice (owner decision O2): Kokoro through sherpa-onnx's WebAssembly runtime in a worker thread of its own. It
 * owns what is installed (read from disk, so a restart forgets nothing), the background install, and the thread, started on
 * first use and ended after {@link REPLY_IDLE_UNLOAD} without a call so its memory is freed.
 */
export class ReplyVoiceEngine implements ReplyVoiceApi {
  private installing: Promise<void> | undefined;
  private doneBytes = 0;
  private failure: { code: VoiceEngineFailureCode; sentence: string } | undefined;
  private selfTest: ReplyVoiceSelfTest | undefined;
  private loaded: Loaded | undefined;
  private loading: Promise<Loaded> | undefined;
  private cancelIdle: (() => void) | undefined;
  /** Bumped by every {@link unload}: a load that began before it is superseded and ends its own thread. */
  private generation = 0;

  constructor(private readonly parts: ReplyEngineParts) {}

  private get catalog(): readonly ReplyFile[] {
    return this.parts.catalog ?? REPLY_FILES;
  }

  private async installedBytes(): Promise<number> {
    let total = 0;
    for (const file of this.catalog) if ((await this.parts.files.size(file)) === file.bytes) total += file.bytes;
    return total;
  }

  async view(): Promise<ReplyVoiceView> {
    const sizeBytes = this.catalog.reduce((sum, file) => sum + file.bytes, 0);
    const installed = await this.installedBytes();
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
      label: REPLY_LABEL,
      sizeBytes,
      doneBytes: state === 'installing' ? Math.max(this.doneBytes, installed) : installed,
      loaded: this.loaded !== undefined && this.loading === undefined,
      ...(this.failure !== undefined && state === 'failed' ? { failure: this.failure } : {}),
      ...(this.selfTest !== undefined && state === 'ready' ? { selfTest: this.selfTest } : {}),
    };
  }

  async install(): Promise<ReplyVoiceView> {
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
        .then(async () => await this.proveItSpeaks())
        .catch((error: unknown) => {
          const code = error instanceof VoiceEngineError && error.code !== 'not_ready' ? error.code : 'download_failed';
          this.failure = {
            code,
            sentence: code === 'no_disk' && error instanceof Error ? error.message : SENTENCES[code],
          };
          this.parts.log.warn('voice.reply.install_failed', { code });
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

  /**
   * Install ends by loading once and speaking one short line to nobody: "Ready" means it ran, and the numbers it measured
   * are what the settings page shows. The voice is then UNLOADED again, pass or fail: the proof is not a use.
   */
  private async proveItSpeaks(): Promise<void> {
    try {
      const loaded = await this.ensureLoaded();
      const spoken = await this.speakOn(loaded, TEST_LINE);
      const audioMs = (spoken.samples.length / 16_000) * 1000;
      this.selfTest = {
        loadMs: loaded.loadMs,
        speakMs: spoken.speakMs,
        audioMs,
        realTimeFactor: audioMs === 0 ? 0 : spoken.speakMs / audioMs,
        memoryMb: loaded.memoryMb,
      };
      this.parts.log.info('voice.reply.ready', { ...this.selfTest });
    } finally {
      await this.unload();
    }
  }

  async remove(): Promise<ReplyVoiceView> {
    if (this.installing !== undefined) throw new VoiceEngineError('not_ready', 'Wait for the install to finish first.');
    await this.unload();
    for (const file of this.catalog) await this.parts.files.remove(file);
    this.selfTest = undefined;
    this.failure = undefined;
    return await this.view();
  }

  async warm(): Promise<void> {
    await this.ensureLoaded();
  }

  async speak(text: string): Promise<ReplySpeech> {
    const loaded = await this.ensureLoaded();
    try {
      return await this.speakOn(loaded, text);
    } finally {
      this.touch();
    }
  }

  private async speakOn(loaded: Loaded, text: string): Promise<ReplySpeech> {
    const reply = await loaded.thread.call({ kind: 'speak', text, speaker: REPLY_SPEAKER_ID });
    if (reply.kind !== 'speak') throw new VoiceEngineError('load_failed', SENTENCES.load_failed);
    return { samples: reply.samples, speakMs: reply.speakMs };
  }

  /** Ends the thread now, freeing its memory. A load still in flight is SUPERSEDED: it ends its own thread when it lands. */
  async unload(): Promise<void> {
    this.generation += 1;
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    const loaded = this.loaded;
    this.loaded = undefined;
    this.loading = undefined;
    await loaded?.thread.terminate();
  }

  private touch(): void {
    this.cancelIdle?.();
    this.cancelIdle = this.parts.clock.after(REPLY_IDLE_UNLOAD, () => {
      this.cancelIdle = undefined;
      this.parts.log.info('voice.reply.idle_unload');
      void this.unload();
    });
  }

  private async ensureLoaded(): Promise<Loaded> {
    if (this.loaded !== undefined) {
      this.touch();
      return this.loaded;
    }
    if (this.loading === undefined) {
      const run: Promise<Loaded> = this.load().finally(() => {
        // Only the load that is still current clears it: a superseded one finishing must not hide a newer one.
        if (this.loading === run) this.loading = undefined;
      });
      this.loading = run;
    }
    const loaded = await this.loading;
    this.touch();
    return loaded;
  }

  private async load(): Promise<Loaded> {
    const generation = this.generation;
    const available = this.parts.availableMemory();
    if (
      available !== undefined &&
      available < REPLY_LOAD_HEADROOM_BYTES + this.catalog.reduce((n, f) => n + f.bytes, 0)
    )
      throw new VoiceEngineError('no_memory', SENTENCES.no_memory);
    const file = (role: ReplyFile['role']): ReplyFile => {
      const found = this.catalog.find(candidate => candidate.role === role);
      if (found === undefined)
        throw new VoiceEngineError('not_ready', 'The reply voice is not installed on this machine yet.');
      return found;
    };
    for (const entry of this.catalog)
      if ((await this.parts.files.size(entry)) !== entry.bytes)
        throw new VoiceEngineError('not_ready', 'The reply voice is not installed on this machine yet.');
    const runtime = await this.parts.files.read(file('runtime'));
    if (runtime === undefined)
      throw new VoiceEngineError('not_ready', 'The reply voice is not installed on this machine yet.');
    const bytes =
      runtime.byteOffset === 0 && runtime.byteLength === runtime.buffer.byteLength
        ? (runtime.buffer as ArrayBuffer)
        : (runtime.buffer.slice(runtime.byteOffset, runtime.byteOffset + runtime.byteLength) as ArrayBuffer);
    if (generation !== this.generation) throw new VoiceEngineError('not_ready', SUPERSEDED);
    const thread = this.parts.start();
    thread.onEnd(() => {
      if (this.loaded?.thread === thread) {
        this.loaded = undefined;
        this.loading = undefined;
      }
    });
    try {
      const reply = await thread.call(
        {
          kind: 'load',
          runtime: bytes,
          paths: {
            model: this.parts.files.pathOf(file('model')),
            voices: this.parts.files.pathOf(file('voices')),
            tokens: this.parts.files.pathOf(file('tokens')),
            lexicon: this.parts.files.pathOf(file('lexicon')),
          },
        },
        [bytes],
      );
      if (reply.kind !== 'load') throw new Error('unexpected reply');
      if (generation !== this.generation) {
        await thread.terminate();
        throw new VoiceEngineError('not_ready', SUPERSEDED);
      }
      this.loaded = { thread, loadMs: reply.loadMs, memoryMb: reply.memoryMb };
      this.parts.log.info('voice.reply.loaded', { loadMs: Math.round(reply.loadMs), memoryMb: reply.memoryMb });
      return this.loaded;
    } catch (error) {
      if (error instanceof VoiceEngineError && error.code === 'not_ready') throw error;
      await thread.terminate();
      this.parts.log.warn('voice.reply.load_error', {
        reason: String((error as Error)?.message ?? error).slice(0, 400),
      });
      throw new VoiceEngineError('load_failed', SENTENCES.load_failed, { cause: error });
    }
  }
}
