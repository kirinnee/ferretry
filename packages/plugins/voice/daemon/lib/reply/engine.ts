import type { Clock } from '@ferretry/kernel/contract';
import { minutes, seconds } from '@ferretry/std';
import {
  REPLY_SPEAKER_ID,
  type ReplySpeech,
  type ReplyVoiceApi,
  type ReplyVoiceSelfTest,
  type ReplyVoiceView,
  type VoiceEngineFailureCode,
  VoiceEngineError,
  type VoiceRuntime,
} from '../../../contract/index.ts';
import type { EngineFile } from '../engine/catalog.ts';
import { ensureRoom, installFiles, missingOf } from '../engine/installer.ts';
import type { EnginePathsPort, HttpPort, ReplyThread } from '../engine/ports.ts';
import { NATIVE_ADDON_ROLE, type NativeParts } from '../native/catalog.ts';
import { asUnavailable, installNativeFirst, NativeUnavailable, reasonOf, type RuntimeKind } from '../native/install.ts';
import { unverified } from '../native/verify.ts';
import { REPLY_FILES, REPLY_LABEL, REPLY_NATIVE_MODEL, REPLY_SHARED_ROLES, type ReplyFile } from './catalog.ts';

/** The voice leaves memory this long after the last use. */
export const REPLY_IDLE_UNLOAD = minutes(10);

/**
 * What loading needs free beyond the files: the model's graph, the runtime's heap and its working memory. Measured: the
 * native engine peaks at about 780 MB for the whole process (bun's own 90 MB included) and the WebAssembly one at about
 * 600 MB, so one figure covers both.
 */
export const REPLY_LOAD_HEADROOM_BYTES = 800_000_000;

/** How long the native engine is given to let go of its models before its thread is ended regardless. */
const RELEASE_WAIT = seconds(8);

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
  /** The WebAssembly engine's files (the whole install when there is no native engine). */
  readonly catalog?: readonly ReplyFile[];
  /** The fp32 model the native engine reads. */
  readonly nativeModel?: ReplyFile;
  /** The native engine: this machine's pinned library and its thread budget. Absent: WebAssembly only. */
  readonly native?: NativeParts;
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
  readonly kind: RuntimeKind;
  readonly loadMs: number;
  readonly memoryMb: number;
}

/**
 * The reply voice (owner decision O2, and what it was measured to need): Kokoro through sherpa-onnx in a worker thread of
 * its own, NATIVE where the machine can run sherpa-onnx's compiled library and WebAssembly where it cannot. It owns what is
 * installed (read from disk, so a restart forgets nothing), the background install, and the thread, started on first use
 * and ended after {@link REPLY_IDLE_UNLOAD} without a call so its memory is freed.
 *
 * WHICH ENGINE is decided by the files on disk and one thing it learned this run: the native files are complete and have
 * not failed here (native), else the WebAssembly files are complete (WebAssembly). Install tries native first and falls
 * to WebAssembly only when the library would not START (`../native/install.ts`).
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
  /** Why the native library is not what runs, once this process saw it fail; forgotten at a restart (the files are then gone or tried again). */
  private nativeFailure: string | undefined;
  /** What an install in flight is fetching, so the progress bar's total follows a fall to WebAssembly. */
  private installKind: RuntimeKind | undefined;

  constructor(private readonly parts: ReplyEngineParts) {}

  private get catalog(): readonly ReplyFile[] {
    return this.parts.catalog ?? REPLY_FILES;
  }

  /** What only the native engine reads: the fp32 model and the library. Empty when this machine has no native build. */
  private get nativeOnly(): readonly EngineFile[] {
    const target = this.parts.native?.target;
    return target === undefined ? [] : [this.parts.nativeModel ?? REPLY_NATIVE_MODEL, ...target.files];
  }

  private get nativeAddonFiles(): readonly EngineFile[] {
    return this.parts.native?.target?.files ?? [];
  }

  private get shared(): readonly EngineFile[] {
    return this.catalog.filter(file => (REPLY_SHARED_ROLES as readonly string[]).includes(file.role));
  }

  /** The WebAssembly engine's files that the native engine does not read: its int8 model and its runtime. */
  private get wasmOnly(): readonly EngineFile[] {
    return this.catalog.filter(file => !(REPLY_SHARED_ROLES as readonly string[]).includes(file.role));
  }

  /** Empty when this machine has no native build: then there is no native set to be ready. */
  private get nativeSet(): readonly EngineFile[] {
    return this.nativeOnly.length === 0 ? [] : [...this.shared, ...this.nativeOnly];
  }

  private async has(files: readonly EngineFile[]): Promise<boolean> {
    return files.length > 0 && (await missingOf(this.parts.files, files)).length === 0;
  }

  /** The engine the files on disk make ready, or `undefined` when neither set is complete. */
  private async installedKind(): Promise<RuntimeKind | undefined> {
    if (this.nativeFailure === undefined && (await this.has(this.nativeSet))) return 'native';
    if (await this.has(this.catalog)) return 'wasm';
    return undefined;
  }

  private planOf(kind: RuntimeKind): readonly EngineFile[] {
    return kind === 'native' ? this.nativeSet : this.catalog;
  }

  private async bytesPresent(files: readonly EngineFile[]): Promise<number> {
    let total = 0;
    for (const file of files) if ((await this.parts.files.size(file)) === file.bytes) total += file.bytes;
    return total;
  }

  private runtimeOf(kind: RuntimeKind, upgradeBytes: number | undefined): VoiceRuntime {
    const machine = this.parts.machine();
    if (kind === 'native') {
      const threads = this.parts.native?.threads() ?? 1;
      return {
        kind,
        threads,
        sentence: `The fast native engine is running it on ${machine}, on up to ${threads} ${threads === 1 ? 'thread' : 'threads'}.`,
      };
    }
    const native = this.parts.native;
    const why =
      native === undefined
        ? 'The built-in engine is running it.'
        : native.target === undefined
          ? `There is no native engine for ${native.platform}, so ${machine} runs it on the slower built-in engine.`
          : this.nativeFailure !== undefined
            ? `The fast native engine could not start on ${machine} (${this.nativeFailure}), so it runs on the slower built-in engine.`
            : `${machine} runs it on the slower built-in engine. The fast native engine can be installed in its place.`;
    return {
      kind,
      threads: 1,
      sentence: why,
      ...(upgradeBytes === undefined ? {} : { upgradeBytes }),
    };
  }

  async view(): Promise<ReplyVoiceView> {
    const installed = await this.installedKind();
    const kind = this.installing === undefined ? installed : undefined;
    // The plan whose size the person sees: the one running, the one being fetched, else the one Install would fetch.
    const plan = this.planOf(
      this.installing !== undefined && this.installKind !== undefined
        ? this.installKind
        : (installed ?? (this.parts.native?.target === undefined ? 'wasm' : 'native')),
    );
    const sizeBytes = plan.reduce((sum, file) => sum + file.bytes, 0);
    const present = await this.bytesPresent(plan);
    const state =
      this.installing !== undefined
        ? 'installing'
        : this.failure !== undefined
          ? 'failed'
          : kind !== undefined
            ? 'ready'
            : 'not_installed';
    const upgradable =
      kind === 'wasm' && this.parts.native?.target !== undefined && this.nativeFailure === undefined
        ? (await missingOf(this.parts.files, this.nativeSet)).reduce((sum, file) => sum + file.bytes, 0) || undefined
        : undefined;
    return {
      state,
      machine: this.parts.machine(),
      label: REPLY_LABEL,
      sizeBytes,
      doneBytes: state === 'installing' ? Math.max(this.doneBytes, present) : present,
      loaded: this.loaded !== undefined && this.loading === undefined,
      ...(this.failure !== undefined && state === 'failed' ? { failure: this.failure } : {}),
      ...(this.selfTest !== undefined && state === 'ready' ? { selfTest: this.selfTest } : {}),
      ...(kind !== undefined && state === 'ready' ? { runtime: this.runtimeOf(kind, upgradable) } : {}),
    };
  }

  async install(): Promise<ReplyVoiceView> {
    if (this.installing === undefined) {
      this.failure = undefined;
      this.doneBytes = 0;
      this.installKind = this.parts.native?.target === undefined ? 'wasm' : 'native';
      const run = this.runInstall()
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
          this.installKind = undefined;
        });
      this.installing = run;
    }
    return await this.view();
  }

  private async runInstall(): Promise<void> {
    const { files, http } = this.parts;
    const count = (received: number): void => {
      this.doneBytes += received;
    };
    const fetchSet = async (set: readonly EngineFile[]): Promise<void> => await installFiles(http, files, count, set);
    if (this.parts.native?.target === undefined) {
      await fetchSet(this.catalog);
      await this.proveItSpeaks('wasm');
      return;
    }
    // A voice that is loaded (the normal case: the WebAssembly one) is ended first, so the proof below loads the NATIVE engine
    // rather than finding the running WebAssembly thread and mistaking that for a native engine that would not start.
    await this.unload();
    // The room for the whole native plan is asked for before anything is downloaded, not file by file as it goes.
    await ensureRoom(files, await missingOf(files, this.nativeSet));
    this.nativeFailure = undefined;
    const result = await installNativeFirst({
      fetchAddon: async () => {
        // The library (and the unrelated bytes already there) count toward the bar; the model follows.
        await fetchSet(this.nativeAddonFiles);
      },
      probe: async () => await this.probeNative(),
      fetchRest: async kind => {
        this.installKind = kind;
        if (kind === 'native') await fetchSet(this.nativeSet);
        else {
          // The bar restarts on the smaller plan; the files the native one fetched do not count toward it.
          this.doneBytes = 0;
          await fetchSet(this.catalog);
        }
      },
      prove: async kind => await this.proveItSpeaks(kind),
      dropNative: async () => {
        await this.unload();
        for (const file of this.nativeOnly) await files.remove(file);
      },
      dropWasm: async () => {
        for (const file of this.wasmOnly) await files.remove(file);
      },
    });
    if (result.reason !== undefined) {
      this.nativeFailure = result.reason;
      this.parts.log.warn('voice.reply.native_unavailable', { reason: result.reason });
    }
  }

  /** Resolves when the running install has ended (a test and the route's own follow-up wait on it). */
  async settled(): Promise<void> {
    await this.installing;
  }

  /** Loads the native library alone in a worker of its own: whether this machine can run it, before the model is fetched. */
  private async probeNative(): Promise<void> {
    const bad = await unverified(this.parts.files, this.nativeAddonFiles);
    if (bad.length > 0) {
      for (const file of bad) await this.parts.files.remove(file);
      throw new VoiceEngineError('hash_mismatch', SENTENCES.hash_mismatch);
    }
    const thread = this.parts.start();
    try {
      const addon = this.nativeAddonFiles.find(file => file.role === NATIVE_ADDON_ROLE);
      if (addon === undefined) throw new Error('this machine has no native engine');
      const reply = await thread.call({ kind: 'probe', addon: this.parts.files.pathOf(addon) });
      if (reply.kind !== 'probe') throw new Error('unexpected reply');
      this.parts.log.info('voice.reply.native_probe', { version: reply.version });
    } catch (error) {
      asUnavailable(error);
    } finally {
      await thread.terminate();
    }
  }

  /**
   * Install ends by loading once and speaking one short line to nobody: "Ready" means it ran, and the numbers it measured
   * are what the settings page shows. The voice is then UNLOADED again, pass or fail: the proof is not a use. A NATIVE proof
   * that could not load or speak says so as {@link NativeUnavailable}, which sends the install to WebAssembly.
   */
  private async proveItSpeaks(kind: RuntimeKind): Promise<void> {
    try {
      // A native proof starts from nothing loaded: a voice woken meanwhile (it would be WebAssembly) is not the engine on trial.
      if (kind === 'native') await this.unload();
      const loaded = await this.ensureLoaded();
      if (kind === 'native' && loaded.kind !== 'native')
        throw new NativeUnavailable(this.nativeFailure ?? 'the native engine did not start');
      const spoken = await this.speakOn(loaded, TEST_LINE);
      const audioMs = (spoken.samples.length / 16_000) * 1000;
      this.selfTest = {
        loadMs: loaded.loadMs,
        speakMs: spoken.speakMs,
        audioMs,
        realTimeFactor: audioMs === 0 ? 0 : spoken.speakMs / audioMs,
        memoryMb: loaded.memoryMb,
      };
      this.parts.log.info('voice.reply.ready', { ...this.selfTest, engine: loaded.kind });
    } catch (error) {
      if (kind === 'native') asUnavailable(error);
      throw error;
    } finally {
      await this.unload();
    }
  }

  async remove(): Promise<ReplyVoiceView> {
    if (this.installing !== undefined) throw new VoiceEngineError('not_ready', 'Wait for the install to finish first.');
    await this.unload();
    for (const file of new Set([...this.catalog, ...this.nativeOnly])) await this.parts.files.remove(file);
    this.selfTest = undefined;
    this.failure = undefined;
    this.nativeFailure = undefined;
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
    // A native engine is asked to free its models first: a thread that is only ended keeps them (see `collectNative`).
    if (loaded?.kind === 'native') await this.release(loaded.thread);
    await loaded?.thread.terminate();
  }

  /** Asks the thread to let go of the native handles, and waits for that (or the clock) before the thread is ended. */
  private async release(thread: ReplyThread): Promise<void> {
    let cancel: (() => void) | undefined;
    const late = new Promise<void>(resolve => {
      cancel = this.parts.clock.after(RELEASE_WAIT, resolve);
    });
    await Promise.race([
      thread.call({ kind: 'release' }).then(
        () => undefined,
        () => undefined,
      ),
      late,
    ]);
    cancel?.();
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
    const notInstalled = (): VoiceEngineError =>
      new VoiceEngineError('not_ready', 'The reply voice is not installed on this machine yet.');
    const native = this.nativeFailure === undefined && (await this.has(this.nativeSet));
    if (native) {
      try {
        return await this.loadWith('native', generation);
      } catch (error) {
        // The native library failed to start here: the WebAssembly files, when they are there, carry on.
        if (error instanceof VoiceEngineError && error.code === 'not_ready') throw error;
        this.nativeFailure = reasonFor(error);
        this.parts.log.warn('voice.reply.native_failed', { reason: this.nativeFailure });
        if (!(await this.has(this.catalog))) throw error;
      }
    }
    if (!(await this.has(this.catalog))) throw notInstalled();
    return await this.loadWith('wasm', generation);
  }

  private async loadWith(kind: RuntimeKind, generation: number): Promise<Loaded> {
    const files = this.parts.files;
    const role = (name: string): EngineFile => {
      const found = (kind === 'native' ? this.nativeSet : this.catalog).find(candidate => candidate.role === name);
      if (found === undefined)
        throw new VoiceEngineError('not_ready', 'The reply voice is not installed on this machine yet.');
      return found;
    };
    const model = kind === 'native' ? (this.parts.nativeModel ?? REPLY_NATIVE_MODEL) : role('model');
    const paths = {
      model: files.pathOf(model),
      voices: files.pathOf(role('voices')),
      tokens: files.pathOf(role('tokens')),
      lexicon: files.pathOf(role('lexicon')),
    };
    let call: Parameters<ReplyThread['call']>;
    if (kind === 'native') {
      // EVERY native load re-hashes the addon and both shared libraries (about 0.1 s next to the model load): the files sit
      // in a folder other programs of this user can write, and what is hashed here is what is loaded next.
      const bad = await unverified(files, this.nativeAddonFiles);
      if (bad.length > 0) {
        // Not the pinned bytes: not loaded, and deleted, so the next Install fetches them again.
        for (const file of bad) await files.remove(file);
        throw new VoiceEngineError('hash_mismatch', SENTENCES.hash_mismatch);
      }
      const addon = role(NATIVE_ADDON_ROLE);
      call = [
        {
          kind: 'load',
          engine: 'native',
          addon: files.pathOf(addon),
          threads: this.parts.native?.threads() ?? 1,
          paths,
        },
      ];
    } else {
      const runtime = await files.read(role('runtime'));
      if (runtime === undefined)
        throw new VoiceEngineError('not_ready', 'The reply voice is not installed on this machine yet.');
      const bytes =
        runtime.byteOffset === 0 && runtime.byteLength === runtime.buffer.byteLength
          ? (runtime.buffer as ArrayBuffer)
          : (runtime.buffer.slice(runtime.byteOffset, runtime.byteOffset + runtime.byteLength) as ArrayBuffer);
      call = [{ kind: 'load', engine: 'wasm', runtime: bytes, paths }, [bytes]];
    }
    if (generation !== this.generation) throw new VoiceEngineError('not_ready', SUPERSEDED);
    const thread = this.parts.start();
    thread.onEnd(() => {
      if (this.loaded?.thread === thread) {
        this.loaded = undefined;
        this.loading = undefined;
      }
    });
    try {
      const reply = await thread.call(...call);
      if (reply.kind !== 'load') throw new Error('unexpected reply');
      if (generation !== this.generation) {
        await thread.terminate();
        throw new VoiceEngineError('not_ready', SUPERSEDED);
      }
      this.loaded = { thread, kind, loadMs: reply.loadMs, memoryMb: reply.memoryMb };
      this.parts.log.info('voice.reply.loaded', {
        loadMs: Math.round(reply.loadMs),
        memoryMb: reply.memoryMb,
        engine: kind,
      });
      return this.loaded;
    } catch (error) {
      if (error instanceof VoiceEngineError && error.code === 'not_ready') throw error;
      await thread.terminate();
      this.parts.log.warn('voice.reply.load_error', {
        reason: String((error as Error)?.message ?? error).slice(0, 400),
        engine: kind,
      });
      throw new VoiceEngineError('load_failed', SENTENCES.load_failed, { cause: error });
    }
  }
}

/** The one line that says why a native start failed (a refused hash or the loader's own words). */
const reasonFor = (error: unknown): string =>
  error instanceof VoiceEngineError && error.code === 'hash_mismatch'
    ? 'its saved files were not the pinned ones, so they were deleted'
    : reasonOf(error);
