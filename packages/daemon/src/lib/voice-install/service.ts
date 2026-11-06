import { basename, dirname, join } from 'node:path';
import {
  VOICE_ENGINE_CODES,
  type VoiceArchive,
  type VoiceEngineView,
  type VoiceInstallPhase,
  type VoiceInstallProgress,
  type VoiceInstallState,
  type VoiceModel,
  type VoiceModelRole,
  type VoiceRuntime,
  type VoiceRuntimeTarget,
} from '@ferretry/protocol';
import { z } from 'zod';
import { downloadArchive } from './download.ts';
import { VoiceInstallError } from './errors.ts';
import {
  NoDecompressorError,
  type VoiceArchiveReader,
  type VoiceEngineSettings,
  type VoiceFetch,
  type VoiceInstallClock,
  type VoiceInstallFiles,
} from './ports.ts';
import { UnsafeArchiveError, unpackTar } from './tar.ts';

/** Install needs this many times an archive's size free: the archive itself, and room to unpack it. */
const DISK_HEADROOM_FACTOR = 2;

const MAX_ARCHIVE_ENTRIES = 1_000;

/**
 * Slack on the unpack cap for everything in the stream that is not file content: every header (each entry may
 * be preceded by a long-name or pax record), the padding after every body, and the end-of-archive blocks.
 */
const UNPACK_SLACK_BYTES = MAX_ARCHIVE_ENTRIES * 3 * 1024 + 20 * 1024;

export const INSTALL_MANIFEST = 'install.json';

/** What a finished install leaves beside what it unpacked: which pinned archive it came from. */
const InstallManifestSchema = z.strictObject({
  archiveSha256: z.string(),
  installedAt: z.string(),
  bytes: z.number().int().nonnegative(),
});

/** The catalog the service installs from — the daemon's data, passed in so a test brings its own rows. */
interface VoiceInstallCatalog {
  readonly models: readonly VoiceModel[];
  readonly runtimes: readonly VoiceRuntime[];
  /** The `sherpa-onnx-node` JavaScript wrapper version the recognizer slice builds against. */
  readonly wrapperVersion: string;
}

export interface VoiceInstallDeps {
  /** `<state home>/voice`. */
  readonly root: string;
  readonly catalog: VoiceInstallCatalog;
  /** This machine's target, or why there is none. */
  readonly target: VoiceRuntimeTarget | { readonly unsupported: string };
  readonly files: VoiceInstallFiles;
  readonly fetch: VoiceFetch;
  readonly archives: VoiceArchiveReader;
  readonly settings: VoiceEngineSettings;
  readonly clock: VoiceInstallClock;
}

interface Running {
  readonly controller: AbortController;
  done: Promise<void>;
  progress: VoiceInstallProgress;
}

const manifestOf = (text: string | undefined): z.infer<typeof InstallManifestSchema> | undefined => {
  if (text === undefined) return undefined;
  try {
    const parsed = InstallManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The speech engine's installed pieces: the catalog with what this machine holds of each row, and the acts
 * that change it (docs/voice.md › "On my machine: models and Install").
 *
 * THE DISK IS THE TRUTH. What is installed is read from `install.json` beside the unpacked files, and what a
 * cancelled download left is the size of its `.part` file — nothing about an install is remembered in memory
 * except the one under way and how the last one ended, so a daemon restart forgets nothing that matters.
 *
 * ONE INSTALL AT A TIME. A second `install` while one runs is refused (`voice_install_busy`) rather than
 * queued: a person who asks twice meant once, and two multi-hundred-megabyte downloads compete for the same
 * link and disk.
 *
 * NOTHING IS LOADED. This module puts files on the disk and checks them; opening the native runtime is the
 * recognizer slice's job.
 */
export class VoiceInstallService {
  #running: Running | undefined;
  #last: VoiceInstallProgress | undefined;
  /** The tail of the queue every change to the installed files goes through; see `#exclusive`. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: VoiceInstallDeps) {}

  /**
   * ONE MUTEX FOR EVERY CHANGE. Install (its claim and checks), remove and use take their turn here, joined to
   * the queue before their first await, so no two of them are ever between "I checked" and "I changed" at
   * once. Without it, an install could start after a remove had passed its own check, and the older remove
   * would then delete the new install's download. A turn that waits is short (a few file operations); the
   * long part of an install runs on AFTER its turn, guarded by `#running`, which every other turn checks.
   */
  #exclusive<T>(act: () => Promise<T>): Promise<T> {
    const turn = this.#queue.then(act, act);
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  // ── paths ──────────────────────────────────────────────────────────────────────────────────────

  #modelDirectory(id: string): string {
    return join(this.deps.root, 'models', id);
  }

  #runtimeDirectory(runtime: VoiceRuntime): string {
    return join(this.deps.root, 'runtime', runtime.version, runtime.target);
  }

  /** The archive and its partial self are one file named by the pin, so a new pin never resumes an old download. */
  #partPath(archive: VoiceArchive): string {
    return join(this.deps.root, 'downloads', `${archive.sha256}.part`);
  }

  #runtime(): VoiceRuntime | undefined {
    const target = this.deps.target;
    if (typeof target !== 'string') return undefined;
    return this.deps.catalog.runtimes.find(runtime => runtime.target === target);
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────────────

  async #stateOf(directory: string, archive: VoiceArchive): Promise<VoiceInstallState> {
    const manifest = manifestOf(await this.deps.files.readText(join(directory, INSTALL_MANIFEST)));
    if (manifest?.archiveSha256 === archive.sha256) {
      return { state: 'installed', installedAt: manifest.installedAt, bytes: manifest.bytes };
    }
    return { state: 'not-installed', partialBytes: (await this.deps.files.size(this.#partPath(archive))) ?? 0 };
  }

  /** The catalog, what is installed, the runtime, and the install under way (or the last one's ending). */
  async view(): Promise<VoiceEngineView> {
    const { catalog, files, root } = this.deps;
    const engine = await this.deps.settings.read();
    const runtime = this.#runtime();
    const states = new Map<string, VoiceInstallState>();
    for (const model of catalog.models) {
      states.set(model.id, await this.#stateOf(this.#modelDirectory(model.id), model.archive));
    }
    const installed = (id: string | undefined): boolean => id !== undefined && states.get(id)?.state === 'installed';

    const warnings: string[] = [];
    const active = {} as Record<VoiceModelRole, string | null>;
    for (const role of ['batch', 'streaming'] as const) {
      const named = engine[role];
      const row = named === undefined ? undefined : catalog.models.find(model => model.id === named);
      if (named !== undefined && row === undefined) {
        warnings.push(`voice.yaml names the ${role} model "${named}", which is not in the catalog`);
      } else if (row !== undefined && row.role !== role) {
        warnings.push(`voice.yaml names "${named}" as the ${role} model, but it is a ${row.role} model`);
      } else if (row !== undefined && !installed(named)) {
        warnings.push(`voice.yaml names the ${role} model "${named}", which is not installed`);
      }
      const recommended = catalog.models.find(model => model.role === role && model.recommended);
      active[role] =
        row !== undefined && row.role === role && installed(row.id)
          ? row.id
          : recommended !== undefined && installed(recommended.id)
            ? recommended.id
            : null;
    }

    let runtimeView: VoiceEngineView['runtime'];
    if (engine.runtimePath !== undefined) {
      const addon = runtime?.addon ?? 'sherpa-onnx.node';
      const bytes = await files.size(join(engine.runtimePath, addon));
      runtimeView = {
        source: 'override',
        wrapperVersion: catalog.wrapperVersion,
        install: bytes === undefined ? { state: 'not-installed', partialBytes: 0 } : { state: 'installed', bytes },
        path: engine.runtimePath,
        ...(runtime === undefined ? {} : { version: runtime.version }),
      };
    } else {
      runtimeView = {
        source: 'downloaded',
        wrapperVersion: catalog.wrapperVersion,
        install:
          runtime === undefined
            ? { state: 'not-installed', partialBytes: 0 }
            : await this.#stateOf(this.#runtimeDirectory(runtime), runtime.archive),
        ...(runtime === undefined ? {} : { version: runtime.version, path: this.#runtimeDirectory(runtime) }),
      };
    }

    const free = await files.freeBytes(root);
    const target = this.deps.target;
    return {
      target: typeof target === 'string' ? target : null,
      ...(typeof target === 'string' ? {} : { unsupported: target.unsupported }),
      runtime: runtimeView,
      models: catalog.models.map(model => ({
        ...model,
        install: states.get(model.id) ?? { state: 'not-installed', partialBytes: 0 },
        active: active[model.role] === model.id,
      })),
      active,
      ...(free === undefined ? {} : { freeBytes: free }),
      install: this.#running?.progress ?? this.#last ?? null,
      warnings,
    };
  }

  // ── acts ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * Starts installing a model (and the runtime, when it is not there yet) and returns at once; the install
   * runs on, and `view().install` says how far it is. Refusals that can be known now are thrown now.
   */
  async install(id: string): Promise<VoiceEngineView> {
    const model = this.deps.catalog.models.find(candidate => candidate.id === id);
    if (model === undefined) {
      throw new VoiceInstallError(VOICE_ENGINE_CODES.unknownModel, `there is no model "${id}" in the catalog`);
    }
    const target = this.deps.target;
    if (typeof target !== 'string') {
      throw new VoiceInstallError(VOICE_ENGINE_CODES.unsupportedPlatform, target.unsupported);
    }
    const runtime = this.#runtime();
    if (runtime === undefined) {
      throw new VoiceInstallError(
        VOICE_ENGINE_CODES.unsupportedPlatform,
        `no speech runtime is published for ${target}`,
      );
    }
    return await this.#exclusive(async () => await this.#start(model, runtime));
  }

  /** The claim and the checks, in this turn at the mutex: after this returns, the install runs on its own. */
  async #start(model: VoiceModel, runtime: VoiceRuntime): Promise<VoiceEngineView> {
    if (this.#running !== undefined) {
      throw new VoiceInstallError(
        VOICE_ENGINE_CODES.busy,
        `another install is running (${this.#running.progress.modelId}); wait for it or cancel it`,
      );
    }
    const controller = new AbortController();
    const claim: Running = {
      controller,
      done: Promise.resolve(),
      progress: this.#progress(model.id, 'model', 'starting', 0, model.archive.bytes),
    };
    this.#running = claim;
    // `done` covers the whole install, checks included, so a Cancel that arrives during them waits for the end
    // of the install (here: it never begins) instead of answering while it is still going.
    const ready = this.#preflight(model, runtime);
    claim.done = ready
      .then(
        async () => {
          if (controller.signal.aborted) {
            claim.progress = {
              ...claim.progress,
              status: 'cancelled',
              code: VOICE_ENGINE_CODES.cancelled,
              message: 'the install was cancelled before it began',
              finishedAt: this.deps.clock.now(),
            };
          } else {
            await this.#run(claim, model, runtime);
          }
          this.#last = claim.progress;
        },
        () => undefined, // a refusal: thrown to the caller below, and no install to report
      )
      .finally(() => {
        this.#running = undefined;
      });
    try {
      await ready;
    } catch (error) {
      await claim.done;
      throw error;
    }
    return await this.view();
  }

  /** The refusals that can be known before any byte moves. */
  async #preflight(model: VoiceModel, runtime: VoiceRuntime): Promise<void> {
    const engine = await this.deps.settings.read();
    const runtimeDirectory = this.#runtimeDirectory(runtime);
    const modelDirectory = this.#modelDirectory(model.id);
    const needsRuntime =
      engine.runtimePath === undefined &&
      (await this.#stateOf(runtimeDirectory, runtime.archive)).state !== 'installed';
    const modelMissing = (await this.#stateOf(modelDirectory, model.archive)).state !== 'installed';
    // Staging directories a killed daemon left behind are reclaimed first: they may be what the disk is short of.
    if (modelMissing) {
      await this.#reclaimStaging(modelDirectory);
      await this.#requireDisk(model.archive);
    }
    if (needsRuntime) {
      await this.#reclaimStaging(runtimeDirectory);
      await this.#requireDisk(runtime.archive);
    }
  }

  /** Stops the install under way. What was downloaded is kept, so the next Install resumes. */
  async cancel(): Promise<VoiceEngineView> {
    const running = this.#running;
    if (running !== undefined) {
      running.controller.abort();
      await running.done;
    }
    return await this.view();
  }

  /** Waits for the install under way, if any. For tests and for a daemon that is shutting down. */
  async settled(): Promise<void> {
    await this.#running?.done;
  }

  /** Deletes a model: its files and any partial download. Clears it from `voice.yaml` if it was chosen there. */
  async remove(id: string): Promise<VoiceEngineView> {
    const model = this.deps.catalog.models.find(candidate => candidate.id === id);
    if (model === undefined) {
      throw new VoiceInstallError(VOICE_ENGINE_CODES.unknownModel, `there is no model "${id}" in the catalog`);
    }
    return await this.#exclusive(async () => await this.#remove(model));
  }

  async #remove(model: VoiceModel): Promise<VoiceEngineView> {
    if (this.#running !== undefined) {
      throw new VoiceInstallError(
        VOICE_ENGINE_CODES.busy,
        `an install is running (${this.#running.progress.modelId}); cancel it first, then remove`,
      );
    }
    const { files, root } = this.deps;
    await files.remove(this.#modelDirectory(model.id));
    await files.remove(this.#partPath(model.archive));
    for (const name of await files.list(join(root, 'models'))) {
      if (name.startsWith(`${model.id}.staging-`)) await files.remove(join(root, 'models', name));
    }
    const engine = await this.deps.settings.read();
    if (engine[model.role] === model.id) await this.deps.settings.setModel(model.role, null);
    this.#last = undefined;
    return await this.view();
  }

  /** Makes an installed model the one its role uses (written to `voice.yaml`). */
  async use(id: string): Promise<VoiceEngineView> {
    const model = this.deps.catalog.models.find(candidate => candidate.id === id);
    if (model === undefined) {
      throw new VoiceInstallError(VOICE_ENGINE_CODES.unknownModel, `there is no model "${id}" in the catalog`);
    }
    // Its turn at the mutex: a remove that is deleting this model must finish before "installed" is read.
    return await this.#exclusive(async () => {
      const state = await this.#stateOf(this.#modelDirectory(model.id), model.archive);
      if (state.state !== 'installed') {
        throw new VoiceInstallError(
          VOICE_ENGINE_CODES.notInstalled,
          `${model.name} is not installed; install it first`,
        );
      }
      await this.deps.settings.setModel(model.role, model.id);
      return await this.view();
    });
  }

  // ── the install itself ─────────────────────────────────────────────────────────────────────────

  #progress(
    modelId: string,
    component: 'runtime' | 'model',
    phase: VoiceInstallPhase,
    bytesDone: number,
    bytesTotal: number,
  ): VoiceInstallProgress {
    return {
      modelId,
      status: 'running',
      component,
      phase,
      bytesDone,
      bytesTotal,
      startedAt: this.deps.clock.now(),
    };
  }

  /** Deletes the staging directories a killed daemon left beside `directory` (gigabytes, for a big model). */
  async #reclaimStaging(directory: string): Promise<void> {
    const { files } = this.deps;
    const parent = dirname(directory);
    for (const name of await files.list(parent)) {
      if (name.startsWith(`${basename(directory)}.staging-`)) await files.remove(join(parent, name));
    }
  }

  /**
   * Refuses when the disk cannot hold what is STILL to come. A whole archive's worth of free space is not asked
   * for twice: the usable prefix already on disk (a cancelled download's `.part`, or a complete one waiting to
   * be unpacked) is counted as already paid, so a tight disk can still finish what it started.
   */
  async #requireDisk(archive: VoiceArchive): Promise<void> {
    const free = await this.deps.files.freeBytes(this.deps.root);
    const onDisk = (await this.deps.files.size(this.#partPath(archive))) ?? 0;
    // A part longer than the pin is junk the download will delete: it is not a prefix of anything.
    const retained = onDisk <= archive.bytes ? onDisk : 0;
    // Twice the download is the floor; an archive that unpacks to more than its own size (Cohere: 1.7× ) needs
    // the archive AND everything it unpacks to on disk at once.
    const total = Math.max(archive.bytes * DISK_HEADROOM_FACTOR, archive.bytes + archive.extractedBytes);
    const needed = total - retained;
    if (free !== undefined && free < needed) {
      throw new VoiceInstallError(
        VOICE_ENGINE_CODES.noDisk,
        `not enough free disk: ${String(needed)} more bytes are needed (the ${String(archive.bytes)}-byte download and what it unpacks to, at least twice the download${retained > 0 ? `, less the ${String(retained)} bytes already downloaded` : ''}) and ${String(free)} are free`,
      );
    }
  }

  async #run(claim: Running, model: VoiceModel, runtime: VoiceRuntime): Promise<void> {
    const set = (patch: Partial<VoiceInstallProgress>): void => {
      claim.progress = { ...claim.progress, ...patch };
    };
    try {
      const engine = await this.deps.settings.read();
      if (engine.runtimePath === undefined) {
        await this.#component(
          claim,
          'runtime',
          this.#runtimeDirectory(runtime),
          runtime.archive,
          new Set([runtime.addon, ...runtime.libraries]),
          set,
        );
      }
      await this.#component(
        claim,
        'model',
        this.#modelDirectory(model.id),
        model.archive,
        new Set(Object.values(model.files)),
        set,
      );
      set({ status: 'succeeded', finishedAt: this.deps.clock.now() });
    } catch (error) {
      if (error instanceof VoiceInstallError) {
        set({
          status: error.code === VOICE_ENGINE_CODES.cancelled ? 'cancelled' : 'failed',
          code: error.code,
          message: error.message,
          finishedAt: this.deps.clock.now(),
        });
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        set({
          status: 'failed',
          code: VOICE_ENGINE_CODES.failed,
          message: `the install failed: ${reason}`,
          finishedAt: this.deps.clock.now(),
        });
      }
    }
  }

  /** One pinned archive → one verified directory. Skipped when the directory already came from this pin. */
  async #component(
    claim: Running,
    component: 'runtime' | 'model',
    directory: string,
    archive: VoiceArchive,
    expected: ReadonlySet<string>,
    set: (patch: Partial<VoiceInstallProgress>) => void,
  ): Promise<void> {
    const { files } = this.deps;
    const signal = claim.controller.signal;
    if ((await this.#stateOf(directory, archive)).state === 'installed') return;

    set({ component, phase: 'starting', bytesDone: 0, bytesTotal: archive.bytes });
    await this.#reclaimStaging(directory);
    await this.#requireDisk(archive);
    const part = this.#partPath(archive);
    await downloadArchive(
      { files, fetch: this.deps.fetch },
      archive,
      part,
      bytesDone => set({ bytesDone }),
      phase => set({ phase }),
      signal,
    );

    set({ phase: 'unpacking', bytesDone: 0, bytesTotal: archive.extractedBytes });
    const staging = `${directory}.staging-${this.deps.clock.now().replace(/\D/g, '')}`;
    let unpacked: Awaited<ReturnType<typeof unpackTar>>;
    try {
      // The state home is trusted: the part was verified above, and whoever could swap it between that check and
      // this read can already edit the installed files, so this slice does not defend that boundary.
      const stream = this.deps.archives.tarStream(part, archive.format, signal);
      let written = 0;
      unpacked = await unpackTar(
        stream,
        {
          makeDirectory: async relative => await files.makeDirectory(join(staging, relative)),
          openFile: async (relative, executable) => {
            const sink = await files.openStaged(join(staging, relative), { executable });
            return {
              write: async chunk => {
                await sink.write(chunk);
                written += chunk.length;
                set({ bytesDone: Math.min(written, archive.extractedBytes) });
              },
              close: async () => await sink.close(),
            };
          },
        },
        {
          strip: 1,
          maxBytes: archive.extractedBytes + UNPACK_SLACK_BYTES,
          maxEntries: MAX_ARCHIVE_ENTRIES,
          include: relative => component === 'model' || expected.has(relative),
        },
        signal,
      );
    } catch (error) {
      await files.remove(staging);
      if (error instanceof NoDecompressorError) {
        throw new VoiceInstallError(VOICE_ENGINE_CODES.noDecompressor, error.message);
      }
      if (error instanceof UnsafeArchiveError) {
        // The hash matched, so the pin itself describes something unsafe: do not keep it to be tried again.
        await files.remove(part);
        throw new VoiceInstallError(VOICE_ENGINE_CODES.unsafeArchive, `the archive was refused: ${error.message}`);
      }
      if (signal.aborted) {
        throw new VoiceInstallError(VOICE_ENGINE_CODES.cancelled, 'the install was cancelled; the download is kept');
      }
      throw error;
    }

    set({ phase: 'finishing' });
    // A named path is a file with content, or a directory (Qwen3's `tokenizer`) holding at least one.
    const present = (path: string): boolean =>
      unpacked.files.some(file => (file.path === path && file.bytes > 0) || file.path.startsWith(`${path}/`));
    const missing = [...expected].filter(path => !present(path));
    if (missing.length > 0) {
      await files.remove(staging);
      await files.remove(part);
      throw new VoiceInstallError(
        VOICE_ENGINE_CODES.unsafeArchive,
        `the archive does not hold the files the recognizer needs (${missing.join(', ')})`,
      );
    }
    await files.writeText(
      join(staging, INSTALL_MANIFEST),
      `${JSON.stringify({ archiveSha256: archive.sha256, installedAt: this.deps.clock.now(), bytes: unpacked.totalBytes })}\n`,
    );
    await files.remove(directory);
    await files.rename(staging, directory);
    await files.remove(part);
    set({ bytesDone: archive.extractedBytes });
  }
}
