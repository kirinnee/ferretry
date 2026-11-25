import type { Clock } from '@ferretry/kernel/contract';
import { minutes, seconds } from '@ferretry/std';
import {
  type VoiceEngineApi,
  VoiceEngineError,
  type VoiceEngineFailureCode,
  type VoiceEngineSelfTest,
  type VoiceEngineView,
  type VoiceRuntime,
  type VoiceSpan,
  type VoiceTranscription,
} from '../../../contract/index.ts';
import { NATIVE_ADDON_ROLE, type NativeParts } from '../native/catalog.ts';
import { asUnavailable, installNativeFirst, NativeUnavailable, reasonOf, type RuntimeKind } from '../native/install.ts';
import { unverified } from '../native/verify.ts';
import { MAX_CONSECUTIVE_STOPS, StopLedger, wasStopped } from '../native/stopped.ts';
import { ENGINE_FILES, ENGINE_LABEL, type EngineFile } from './catalog.ts';
import { ensureRoom, installFiles, missingOf } from './installer.ts';
import type { EnginePathsPort, HttpPort, SpeechThread } from './ports.ts';
import { LOAD_ROLES, type LoadRole, NATIVE_LOAD_ROLES, type NativeLoadRole, SPEECH_SAMPLE_RATE } from './protocol.ts';

/** The models leave memory this long after the last use. */
export const IDLE_UNLOAD = minutes(10);

/** How long the native engine is given to let go of its models before its thread is ended regardless. */
const RELEASE_WAIT = seconds(8);

/** What loading needs free beyond the files themselves: the graphs' own copies and the worker's working memory. */
export const LOAD_HEADROOM_BYTES = 1_500_000_000;

export interface EngineParts {
  readonly http: HttpPort;
  readonly files: EnginePathsPort;
  readonly clock: Pick<Clock, 'after'>;
  /** What this machine is called, read at each use (the owner can rename it while the daemon runs). */
  readonly machine: () => string;
  /** Starts one speech thread: a worker thread for WebAssembly, a child process for the native engine (so its library cannot end the daemon). */
  readonly start: (kind: RuntimeKind) => SpeechThread;
  /** Memory the machine could give a new process, in bytes. `undefined` when it cannot say (no check is made). */
  readonly availableMemory: () => number | undefined;
  readonly log: {
    info(message: string, fields?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
    warn(message: string, fields?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
  };
  /** The WebAssembly engine's files, which are all of them on a machine with no native build. */
  readonly catalog?: readonly EngineFile[];
  /** The native engine: this machine's pinned library and its thread budget. Absent: WebAssembly only. */
  readonly native?: NativeParts;
}

const SUPERSEDED = 'Speech was stopped while it was loading.';

const SENTENCES: Record<VoiceEngineFailureCode, string> = {
  download_failed: 'The speech files could not be downloaded. Check this machine’s internet and try again.',
  hash_mismatch: 'A downloaded speech file was not the file this version expects, so nothing was kept. Try again.',
  write_failed: 'The speech files could not be saved on this machine. Check its free disk space and try again.',
  // The installer words this one itself (it knows the sizes); this is only the fallback.
  no_disk: 'This machine does not have enough free disk space for the speech files.',
  no_memory: 'This machine does not have enough free memory to load speech right now.',
  load_failed: 'The speech files are saved but the engine could not start with them.',
};

interface Loaded {
  readonly thread: SpeechThread;
  readonly kind: RuntimeKind;
  readonly loadMs: number;
  readonly memoryMb: number;
}

/** The roles only the WebAssembly engine reads (everything else is read by both). */
const WASM_ONLY_ROLES: readonly string[] = ['sherpa-wasm'];

/** The one line that says why a native start failed (a refused hash or the loader's own words). */
const reasonFor = (error: unknown): string =>
  error instanceof VoiceEngineError && error.code === 'hash_mismatch'
    ? 'its saved files were not the pinned ones, so they were deleted'
    : reasonOf(error);

/**
 * The machine speech engine (owner decision O2, and what it was measured to need): sherpa-onnx in a worker thread,
 * NATIVE where the machine can run its compiled library (Parakeet decodes about six times faster, on several threads) and
 * WebAssembly where it cannot. It owns three things: what is installed (read from disk, so a restart forgets nothing), the
 * background install, and the one worker thread, started on first use and ended after {@link IDLE_UNLOAD} without a call
 * so its memory is freed.
 *
 * WHICH ENGINE is decided as the reply voice's is (`../reply/engine.ts`): the native files complete and not failed here
 * (native), else the WebAssembly files complete (WebAssembly). Install tries native first and falls to WebAssembly only
 * when the library would not START.
 */
export class SpeechEngine implements VoiceEngineApi {
  private installing: Promise<void> | undefined;
  private doneBytes = 0;
  private failure: { code: VoiceEngineFailureCode; sentence: string } | undefined;
  private selfTest: VoiceEngineSelfTest | undefined;
  private thread: SpeechThread | undefined;
  private loading: Promise<SpeechThread> | undefined;
  private cancelIdle: (() => void) | undefined;
  /** Bumped by every {@link unload}: a load that began before it is superseded and ends its own thread. */
  private generation = 0;
  /** Why the native library is not what runs, once this process saw it fail; forgotten at a restart. */
  private nativeFailure: string | undefined;
  /** The native host's stops since a call last succeeded: a few in a row give the engine up for the WebAssembly one. */
  private readonly stops = new StopLedger();
  /** What an install in flight is fetching, so the progress bar's total follows a fall to WebAssembly. */
  private installKind: RuntimeKind | undefined;

  constructor(private readonly parts: EngineParts) {}

  private get catalog(): readonly EngineFile[] {
    return this.parts.catalog ?? ENGINE_FILES;
  }

  private get nativeAddonFiles(): readonly EngineFile[] {
    return this.parts.native?.target?.files ?? [];
  }

  /** The files both engines read. */
  private get shared(): readonly EngineFile[] {
    return this.catalog.filter(file => !WASM_ONLY_ROLES.includes(file.role));
  }

  private get wasmOnly(): readonly EngineFile[] {
    return this.catalog.filter(file => WASM_ONLY_ROLES.includes(file.role));
  }

  /** Empty when this machine has no native build: then there is no native set to be ready. */
  private get nativeSet(): readonly EngineFile[] {
    return this.nativeAddonFiles.length === 0 ? [] : [...this.shared, ...this.nativeAddonFiles];
  }

  private async has(files: readonly EngineFile[]): Promise<boolean> {
    return files.length > 0 && (await missingOf(this.parts.files, files)).length === 0;
  }

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
        sentence:
          this.stops.latest !== undefined
            ? `The fast native engine stopped on ${machine}: ${this.stops.latest}. It starts again the next time speech is needed.`
            : `The fast native engine is turning your speech into words on ${machine}, on up to ${threads} ${threads === 1 ? 'thread' : 'threads'}.`,
      };
    }
    const native = this.parts.native;
    const why =
      native === undefined
        ? 'The built-in engine is turning your speech into words.'
        : native.target === undefined
          ? `There is no native engine for ${native.platform}, so ${machine} turns your speech into words on the slower built-in engine.`
          : this.nativeFailure !== undefined
            ? `The fast native engine could not start on ${machine} (${this.nativeFailure}), so it runs on the slower built-in engine.`
            : `${machine} runs it on the slower built-in engine. The fast native engine can be installed in its place.`;
    return { kind, threads: 1, sentence: why, ...(upgradeBytes === undefined ? {} : { upgradeBytes }) };
  }

  async view(): Promise<VoiceEngineView> {
    const installed = await this.installedKind();
    const kind = this.installing === undefined ? installed : undefined;
    const plan = this.planOf(
      this.installing !== undefined && this.installKind !== undefined
        ? this.installKind
        : (installed ?? (this.nativeSet.length === 0 ? 'wasm' : 'native')),
    );
    const sizeBytes = plan.reduce((sum, file) => sum + file.bytes, 0);
    const present = await this.bytesPresent(plan);
    // Saved is not ready: a failure after the download (the models would not load) keeps it `failed` until a retry.
    const state =
      this.installing !== undefined
        ? 'installing'
        : this.failure !== undefined
          ? 'failed'
          : kind !== undefined
            ? 'ready'
            : 'not_installed';
    const upgradable =
      kind === 'wasm' && this.nativeSet.length > 0 && this.nativeFailure === undefined
        ? (await missingOf(this.parts.files, this.nativeSet)).reduce((sum, file) => sum + file.bytes, 0) || undefined
        : undefined;
    return {
      state,
      machine: this.parts.machine(),
      label: ENGINE_LABEL,
      sizeBytes,
      doneBytes: state === 'installing' ? Math.max(this.doneBytes, present) : present,
      loaded: this.thread !== undefined && this.loading === undefined,
      ...(this.failure !== undefined && state === 'failed' ? { failure: this.failure } : {}),
      ...(this.selfTest !== undefined && state === 'ready' ? { selfTest: this.selfTest } : {}),
      ...(kind !== undefined && state === 'ready' ? { runtime: this.runtimeOf(kind, upgradable) } : {}),
    };
  }

  async install(): Promise<VoiceEngineView> {
    if (this.installing === undefined) {
      this.failure = undefined;
      this.doneBytes = 0;
      this.installKind = this.nativeSet.length === 0 ? 'wasm' : 'native';
      const run = this.runInstall()
        .catch((error: unknown) => {
          const code = error instanceof VoiceEngineError && error.code !== 'not_ready' ? error.code : 'download_failed';
          this.failure = {
            code,
            sentence: code === 'no_disk' && error instanceof Error ? error.message : SENTENCES[code],
          };
          this.parts.log.warn('voice.engine.install_failed', { code });
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
    if (this.nativeSet.length === 0) {
      await fetchSet(this.catalog);
      await this.proveItLoads('wasm');
      return;
    }
    // A voice that is loaded (the normal case: the WebAssembly one) is ended first, so the proof below loads the NATIVE engine
    // rather than finding the running WebAssembly thread and mistaking that for a native engine that would not start.
    await this.unload();
    // The room for the whole native plan is asked for before anything is downloaded, not file by file as it goes.
    await ensureRoom(files, await missingOf(files, this.nativeSet));
    this.nativeFailure = undefined;
    this.stops.clear();
    const result = await installNativeFirst({
      fetchAddon: async () => {
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
      prove: async kind => await this.proveItLoads(kind),
      dropNative: async () => {
        await this.unload();
        for (const file of this.nativeAddonFiles) await files.remove(file);
      },
      dropWasm: async () => {
        for (const file of this.wasmOnly) await files.remove(file);
      },
    });
    if (result.reason !== undefined) {
      this.nativeFailure = result.reason;
      this.parts.log.warn('voice.engine.native_unavailable', { reason: result.reason });
    }
  }

  /** Resolves when the running install has ended (a test and the route's own follow-up wait on it). */
  async settled(): Promise<void> {
    await this.installing;
  }

  /** Loads the native library alone in a worker of its own: whether this machine can run it, before the models are fetched. */
  private async probeNative(): Promise<void> {
    const bad = await unverified(this.parts.files, this.nativeAddonFiles);
    if (bad.length > 0) {
      for (const file of bad) await this.parts.files.remove(file);
      throw new VoiceEngineError('hash_mismatch', SENTENCES.hash_mismatch);
    }
    const thread = this.parts.start('native');
    try {
      const addon = this.nativeAddonFiles.find(file => file.role === NATIVE_ADDON_ROLE);
      if (addon === undefined) throw new Error('this machine has no native engine');
      const reply = await thread.call({ kind: 'probe', addon: this.parts.files.pathOf(addon) });
      if (reply.kind !== 'probe') throw new Error('unexpected reply');
      this.parts.log.info('voice.engine.native_probe', { version: reply.version });
    } catch (error) {
      asUnavailable(error);
    } finally {
      await thread.terminate();
    }
  }

  /**
   * Install ends by loading once and decoding a second of silence: "Ready" means it ran, not only that it is saved.
   * The models are then UNLOADED again, pass or fail: the proof is not a use, so nothing stays resident (about 1.8 GB
   * on WebAssembly) for ten idle minutes. The first real call loads them again. A NATIVE proof that could not load or
   * decode says so as {@link NativeUnavailable}, which sends the install to WebAssembly.
   */
  private async proveItLoads(kind: RuntimeKind): Promise<void> {
    try {
      // A native proof starts from nothing loaded: models woken meanwhile (they would be WebAssembly) are not the engine on trial.
      if (kind === 'native') await this.unload();
      const loadedAt = await this.ensureLoaded();
      if (kind === 'native' && loadedAt.kind !== 'native')
        throw new NativeUnavailable(this.nativeFailure ?? 'the native engine did not start');
      const silence = new Float32Array(SPEECH_SAMPLE_RATE);
      const reply = await loadedAt.thread.call({ kind: 'transcribe', samples: silence }, [silence.buffer]);
      if (reply.kind !== 'transcribe') throw new VoiceEngineError('load_failed', SENTENCES.load_failed);
      this.selfTest = { loadMs: loadedAt.loadMs, decodeMs: reply.decodeMs, memoryMb: loadedAt.memoryMb };
      this.parts.log.info('voice.engine.ready', { ...this.selfTest, engine: loadedAt.kind });
    } catch (error) {
      if (kind === 'native') asUnavailable(error);
      throw error;
    } finally {
      await this.unload();
    }
  }

  async remove(): Promise<VoiceEngineView> {
    if (this.installing !== undefined) throw new VoiceEngineError('not_ready', 'Wait for the install to finish first.');
    await this.unload();
    for (const file of new Set([...this.catalog, ...this.nativeAddonFiles])) await this.parts.files.remove(file);
    this.selfTest = undefined;
    this.failure = undefined;
    this.nativeFailure = undefined;
    this.stops.clear();
    return await this.view();
  }

  async transcribe(samples: Float32Array): Promise<VoiceTranscription> {
    const { thread } = await this.ensureLoaded();
    const audioSeconds = samples.length / SPEECH_SAMPLE_RATE;
    const copy = samples.slice();
    try {
      const reply = await thread.call({ kind: 'transcribe', samples: copy }, [copy.buffer]);
      if (reply.kind !== 'transcribe') throw new VoiceEngineError('load_failed', SENTENCES.load_failed);
      this.stops.clear();
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

  /**
   * Ends the worker now, freeing its memory. A later call loads again. A load still in flight is SUPERSEDED: it ends
   * its own thread when it lands and never publishes it, so no worker is left behind and no second load is started here.
   */
  async unload(): Promise<void> {
    this.generation += 1;
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    const thread = this.thread;
    const native = this.loadedAt?.kind === 'native';
    this.thread = undefined;
    this.loadedAt = undefined;
    this.loading = undefined;
    // A native engine is asked to free its models first: a thread that is only ended keeps them (see `collectNative`).
    if (thread !== undefined && native) await this.release(thread);
    await thread?.terminate();
  }

  /** Asks the thread to let go of the native handles, and waits for that (or the clock) before the thread is ended. */
  private async release(thread: SpeechThread): Promise<void> {
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

  /** A native host ended on its own: said in Settings, and after too many in a row the slower engine takes over. */
  private noteStopped(reason: string): void {
    this.parts.log.warn('voice.engine.native_stopped', { reason });
    if (this.stops.note(reason)) {
      this.nativeFailure = `it stopped ${MAX_CONSECUTIVE_STOPS} times in a row; the last time ${reason}`;
      this.parts.log.warn('voice.engine.native_given_up', { reason: this.nativeFailure });
    }
  }

  private touch(): void {
    this.cancelIdle?.();
    this.cancelIdle = this.parts.clock.after(IDLE_UNLOAD, () => {
      this.cancelIdle = undefined;
      this.parts.log.info('voice.engine.idle_unload');
      void this.unload();
    });
  }

  private loadedAt: Loaded | undefined;

  private async ensureLoaded(): Promise<Loaded> {
    if (this.thread !== undefined && this.loadedAt?.thread === this.thread) {
      this.touch();
      return this.loadedAt;
    }
    if (this.loading === undefined) {
      const run: Promise<SpeechThread> = this.load().finally(() => {
        // Only the load that is still current clears it: a superseded one finishing must not hide a newer one.
        if (this.loading === run) this.loading = undefined;
      });
      this.loading = run;
    }
    await this.loading;
    this.touch();
    if (this.loadedAt === undefined) throw new VoiceEngineError('load_failed', SENTENCES.load_failed);
    return this.loadedAt;
  }

  private async load(): Promise<SpeechThread> {
    const generation = this.generation;
    const available = this.parts.availableMemory();
    if (
      available !== undefined &&
      available < LOAD_HEADROOM_BYTES + this.catalog.reduce((sum, file) => sum + file.bytes, 0)
    )
      throw new VoiceEngineError('no_memory', SENTENCES.no_memory);
    if (this.nativeFailure === undefined && (await this.has(this.nativeSet))) {
      try {
        return await this.loadWith('native', generation);
      } catch (error) {
        // The native library failed to start here: the WebAssembly files, when they are there, carry on.
        if (error instanceof VoiceEngineError && error.code === 'not_ready') throw error;
        // A host that STOPPED (a crash, a deadline) is given another start at the next use, until it has stopped too often in a row.
        if (wasStopped(error) && this.nativeFailure === undefined) throw error;
        this.nativeFailure ??= reasonFor(error);
        this.parts.log.warn('voice.engine.native_failed', { reason: this.nativeFailure });
        if (!(await this.has(this.catalog))) throw error;
      }
    }
    if (!(await this.has(this.catalog)))
      throw new VoiceEngineError('not_ready', 'Speech is not installed on this machine yet.');
    return await this.loadWith('wasm', generation);
  }

  /** Reads the small files a load sends; the three big graphs are never read here by the native engine. */
  private async bytesOf<R extends string>(roles: readonly R[]): Promise<Record<R, ArrayBuffer>> {
    const out = {} as Record<R, ArrayBuffer>;
    for (const role of roles) {
      const file = this.catalog.find(candidate => candidate.role === role);
      const bytes = file === undefined ? undefined : await this.parts.files.read(file);
      if (bytes === undefined) throw new VoiceEngineError('not_ready', 'Speech is not installed on this machine yet.');
      // The state read hands over a whole buffer: transfer it as it is, never a second 650 MB copy.
      out[role] =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    }
    return out;
  }

  private async loadWith(kind: RuntimeKind, generation: number): Promise<SpeechThread> {
    const files = this.parts.files;
    let call: Parameters<SpeechThread['call']>;
    if (kind === 'native') {
      // EVERY native load re-hashes the addon and both shared libraries (about 0.1 s next to the model load): the files sit
      // in a folder other programs of this user can write, and what is hashed here is what is loaded next.
      const bad = await unverified(files, this.nativeAddonFiles);
      if (bad.length > 0) {
        // Not the pinned bytes: not loaded, and deleted, so the next Install fetches them again.
        for (const file of bad) await files.remove(file);
        throw new VoiceEngineError('hash_mismatch', SENTENCES.hash_mismatch);
      }
      const addon = this.nativeAddonFiles.find(file => file.role === NATIVE_ADDON_ROLE);
      if (addon === undefined) throw new VoiceEngineError('not_ready', 'Speech is not installed on this machine yet.');
      const path = (role: string): string => files.pathOf({ role });
      const small = await this.bytesOf<NativeLoadRole>(NATIVE_LOAD_ROLES);
      call = [
        {
          kind: 'load',
          engine: 'native',
          addon: files.pathOf(addon),
          threads: this.parts.native?.threads() ?? 1,
          paths: { encoder: path('encoder'), decoder: path('decoder'), joiner: path('joiner'), tokens: path('tokens') },
          files: small,
        },
        Object.values(small),
      ];
    } else {
      const loaded = await this.bytesOf<LoadRole>(LOAD_ROLES);
      call = [{ kind: 'load', engine: 'wasm', files: loaded }, Object.values(loaded)];
    }
    if (generation !== this.generation) throw new VoiceEngineError('not_ready', SUPERSEDED);
    const thread = this.parts.start(kind);
    thread.onEnd(stopped => {
      if (this.thread === thread) {
        this.thread = undefined;
        this.loadedAt = undefined;
        this.loading = undefined;
      }
      if (stopped !== undefined && kind === 'native') this.noteStopped(stopped);
    });
    try {
      const reply = await thread.call(...call);
      if (reply.kind !== 'load') throw new Error('unexpected reply');
      if (generation !== this.generation) {
        // Unloaded or removed while this was loading: this thread was never published, so it ends here.
        await thread.terminate();
        throw new VoiceEngineError('not_ready', SUPERSEDED);
      }
      this.thread = thread;
      this.loadedAt = { thread, kind, loadMs: reply.loadMs, memoryMb: reply.memoryMb };
      this.parts.log.info('voice.engine.loaded', {
        loadMs: Math.round(reply.loadMs),
        memoryMb: reply.memoryMb,
        engine: kind,
      });
      return thread;
    } catch (error) {
      if (error instanceof VoiceEngineError && error.code === 'not_ready') throw error;
      await thread.terminate();
      this.parts.log.warn('voice.engine.load_error', {
        reason: String((error as Error)?.message ?? error).slice(0, 400),
        engine: kind,
      });
      throw new VoiceEngineError('load_failed', SENTENCES.load_failed, { cause: error });
    }
  }
}
