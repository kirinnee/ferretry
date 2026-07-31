import type { SttInstallStatus, SttModelStatus, SttWorkerModel } from '@ferretry/protocol';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import {
  advanceInstall,
  buildInstalledManifest,
  declaredSizeMatches,
  idleInstall,
  type InstallDownload,
  type InstalledSttModel,
  modelDirectoryFor,
  parseInstalledManifest,
  planInstall,
  projectModelStatus,
  publicModelFile,
  STT_MODEL_MANIFEST,
  SttError,
  sttInstallScratchPath,
  SttModelCatalog,
  type SttModelDefinition,
  type SttModelFileDefinition,
  type SttPaths,
  workerModelFor,
} from '../../lib/index.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_MESSAGE_CHARS = 500;
const STREAM_RELEASE_BUDGET_MS = 1_000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 600_000;

export interface SttCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the runner had to kill the command to get it to stop. */
  readonly timedOut?: boolean;
}

/**
 * Runs an external archive tool. The only process this store ever starts, and it
 * must always be bounded: an extraction that never returned used to wedge the
 * model in the installing state for the lifetime of the daemon.
 */
export interface SttCommandRunner {
  run(argv: readonly string[], timeoutMs: number): Promise<SttCommandResult>;
}

export type SttDownloadFetch = (url: string) => Promise<Response>;

export interface SttModelStoreOptions {
  readonly paths: SttPaths;
  readonly catalog?: SttModelCatalog;
  readonly fetch: SttDownloadFetch;
  readonly runner: SttCommandRunner;
  readonly now: () => string;
  readonly uniqueId: () => string;
  /** How long a download may make no progress before it is abandoned. */
  readonly stallTimeoutMs?: number;
  /** How long an archive extraction may run before the child is killed. */
  readonly extractTimeoutMs?: number;
}

export interface PublicSttModelFile {
  readonly path: string;
  readonly definition: SttModelFileDefinition;
}

/** The narrow slice of a byte stream this store consumes. */
interface DownloadChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

interface FileFacts {
  readonly signature: string;
  readonly bytes: number;
}

function boundedMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return (message.length === 0 ? fallback : message).slice(0, MAX_MESSAGE_CHARS);
}

async function regularFileFacts(target: string, expectedBytes: number): Promise<FileFacts | undefined> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (info === undefined || !info.isFile() || info.size !== expectedBytes) return undefined;
  return {
    bytes: info.size,
    signature: [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(':'),
  };
}

async function sha256File(target: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(target)) digest.update(chunk as Uint8Array);
  return digest.digest('hex');
}

/**
 * Releasing a stream must never become the caller's problem: the cancel() of a
 * stream whose pull() stopped responding can hang for exactly as long, which
 * left install() pending forever and the model stuck in `installing`.
 */
async function releaseStream(release: () => Promise<void>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<void>(resolve => {
    timer = setTimeout(resolve, budgetMs);
  });
  const attempt = (async () => {
    await release();
  })().catch(() => undefined);
  try {
    await Promise.race([attempt, bounded]);
  } finally {
    clearTimeout(timer);
  }
}

/** The narrow slice of a file handle the download writer needs. */
export interface ChunkWriter {
  write(chunk: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
}

/**
 * A single write() may be short. Ignoring the count truncates the file while the
 * digest — taken over the whole chunk — still matches, so the corruption would
 * surface only as a checksum failure much later, or not at all.
 */
export async function writeAll(handle: ChunkWriter, chunk: Uint8Array): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, written, chunk.byteLength - written);
    if (bytesWritten <= 0) throw new SttError('install_failed', 'model download write made no progress');
    written += bytesWritten;
  }
}

async function pathExists(target: string): Promise<boolean> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  return info !== undefined;
}

/**
 * Owns every filesystem and network touch for model installation. Each decision
 * — what to download, whether a manifest describes this model, what the wire
 * status is — comes from `lib/stt/models.ts`; this class only performs the IO
 * and reports what happened.
 */
export class SttModelStore {
  private readonly catalog: SttModelCatalog;
  private readonly paths: SttPaths;
  private readonly stallTimeoutMs: number;
  private readonly releaseBudgetMs: number;
  private readonly extractTimeoutMs: number;
  private readonly installs = new Map<string, SttInstallStatus>();
  private readonly active = new Map<string, Promise<SttModelStatus>>();
  private readonly starting = new Map<string, Promise<{ started: boolean; status: SttModelStatus }>>();
  /** A hash is trusted only while the file's identity and timestamps are unchanged. */
  private readonly verified = new Map<string, string>();

  constructor(private readonly options: SttModelStoreOptions) {
    this.catalog = options.catalog ?? new SttModelCatalog();
    this.paths = options.paths;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 60_000;
    this.releaseBudgetMs = Math.min(this.stallTimeoutMs, STREAM_RELEASE_BUDGET_MS);
    this.extractTimeoutMs = options.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;
  }

  definition(modelId: string): SttModelDefinition {
    return this.catalog.definition(modelId);
  }

  installStatus(modelId: string): SttInstallStatus {
    const definition = this.catalog.definition(modelId);
    return this.installs.get(modelId) ?? idleInstall(definition);
  }

  /** Reads the on-disk manifest and re-verifies every file it claims. */
  async inspect(modelId: string): Promise<InstalledSttModel | undefined> {
    const definition = this.catalog.definition(modelId);
    const directory = modelDirectoryFor(this.paths, definition);
    const text = await readFile(join(directory, STT_MODEL_MANIFEST), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return undefined;
      throw error;
    });
    if (text === undefined) return undefined;
    const manifest = parseInstalledManifest(text, definition);
    if (manifest === undefined) return undefined;
    for (const file of definition.files) {
      if (!(await this.fileMatches(join(directory, file.name), file))) return undefined;
    }
    return { definition, directory, installedAt: manifest.installedAt };
  }

  async modelStatus(modelId: string): Promise<SttModelStatus> {
    const definition = this.catalog.definition(modelId);
    const installed = await this.inspect(modelId);
    return projectModelStatus(definition, this.installStatus(modelId), installed, this.active.has(modelId));
  }

  async inventory(): Promise<{ daemon: SttModelStatus; browser: SttModelStatus }> {
    const [daemon, browser] = await Promise.all([
      this.modelStatus(this.catalog.definitionFor('daemon').id),
      this.modelStatus(this.catalog.definitionFor('browser').id),
    ]);
    return { daemon, browser };
  }

  /** Starts an install at most once per model; concurrent callers observe it. */
  async startInstall(modelId: string): Promise<{ started: boolean; status: SttModelStatus }> {
    const definition = this.catalog.definition(modelId);
    const pending = this.starting.get(modelId);
    if (pending !== undefined) {
      await pending;
      return { started: false, status: await this.modelStatus(modelId) };
    }
    const operation = this.beginInstall(definition);
    this.starting.set(modelId, operation);
    try {
      return await operation;
    } finally {
      if (this.starting.get(modelId) === operation) this.starting.delete(modelId);
    }
  }

  /** Starts an install if needed and resolves once it has finished. */
  async install(modelId: string): Promise<SttModelStatus> {
    await this.startInstall(modelId);
    const running = this.active.get(modelId);
    return running === undefined ? await this.modelStatus(modelId) : await running;
  }

  async resolveDaemonModel(): Promise<SttWorkerModel | undefined> {
    const definition = this.catalog.definitionFor('daemon');
    const installed = await this.inspect(definition.id);
    return installed === undefined ? undefined : workerModelFor(definition, installed.directory);
  }

  /** Resolves a browser-servable file, refusing anything outside the model tree. */
  async resolvePublicFile(modelId: string, fileName: string): Promise<PublicSttModelFile | undefined> {
    const definition = this.catalog.find(modelId);
    if (definition === undefined) return undefined;
    const file = publicModelFile(definition, fileName);
    if (file === undefined) return undefined;
    const installed = await this.inspect(modelId);
    if (installed === undefined) return undefined;
    const candidate = join(installed.directory, file.name);
    if ((await regularFileFacts(candidate, file.bytes)) === undefined) return undefined;
    const [root, resolved] = await Promise.all([realpath(installed.directory), realpath(candidate)]);
    if (!resolved.startsWith(`${root}${sep}`)) return undefined;
    return { path: resolved, definition: file };
  }

  private async beginInstall(definition: SttModelDefinition): Promise<{ started: boolean; status: SttModelStatus }> {
    const modelId = definition.id;
    if (this.active.has(modelId) || (await this.inspect(modelId)) !== undefined) {
      return { started: false, status: await this.modelStatus(modelId) };
    }
    this.record(definition, { phase: 'downloading', receivedBytes: 0 });
    const running = this.performInstall(definition);
    this.active.set(modelId, running);
    const forget = () => {
      if (this.active.get(modelId) === running) this.active.delete(modelId);
    };
    void running.then(forget, forget);
    return { started: true, status: await this.modelStatus(modelId) };
  }

  private record(definition: SttModelDefinition, progress: Parameters<typeof advanceInstall>[2]): void {
    const previous = this.installs.get(definition.id) ?? idleInstall(definition);
    this.installs.set(definition.id, advanceInstall(definition, previous, progress, this.options.now()));
  }

  private async performInstall(definition: SttModelDefinition): Promise<SttModelStatus> {
    const temporary = sttInstallScratchPath(this.paths, definition.id, `install-${this.options.uniqueId()}`);
    const staged = join(temporary, 'ready');
    try {
      await mkdir(this.paths.models, { recursive: true, mode: DIRECTORY_MODE });
      await mkdir(this.paths.directory, { recursive: true, mode: DIRECTORY_MODE });
      await mkdir(temporary, { recursive: false, mode: DIRECTORY_MODE });
      await this.fetchArtifacts(definition, temporary, staged);
      await this.verifyStaged(definition, staged);
      await this.publish(definition, staged);
      this.record(definition, { phase: 'ready' });
      return await this.modelStatus(definition.id);
    } catch (error) {
      const failure =
        error instanceof SttError
          ? error
          : new SttError('install_failed', boundedMessage(error, 'model installation failed'), { cause: error });
      this.record(definition, { phase: 'failed', message: failure.message, code: failure.code });
      throw failure;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async fetchArtifacts(definition: SttModelDefinition, temporary: string, staged: string): Promise<void> {
    const plan = planInstall(definition);
    if (plan.kind === 'archive') {
      const [artifact] = plan.downloads;
      if (artifact === undefined) throw new SttError('install_failed', 'archive install has no artifact');
      const archive = join(temporary, artifact.target);
      await this.download(definition, artifact, archive);
      this.record(definition, { phase: 'extracting', receivedBytes: artifact.bytes });
      const unpack = join(temporary, 'unpack');
      await mkdir(unpack, { mode: DIRECTORY_MODE });
      const result = await this.options.runner.run(
        ['tar', '-xjf', archive, '-C', unpack, '--no-same-owner', '--no-same-permissions'],
        this.extractTimeoutMs,
      );
      if (result.timedOut === true) throw new SttError('install_failed', 'model extraction timed out');
      if (result.code !== 0) {
        throw new SttError('install_failed', `model extraction failed: ${result.stderr.slice(0, MAX_MESSAGE_CHARS)}`);
      }
      const extracted = join(unpack, plan.archiveRoot ?? '');
      if (!(await pathExists(extracted))) {
        throw new SttError('install_failed', 'model archive has an unexpected layout');
      }
      await rename(extracted, staged);
      return;
    }

    await mkdir(staged, { mode: DIRECTORY_MODE });
    for (const artifact of plan.downloads) {
      const target = join(staged, artifact.target);
      await mkdir(dirname(target), { recursive: true, mode: DIRECTORY_MODE });
      await this.download(definition, artifact, target);
    }
  }

  private async verifyStaged(definition: SttModelDefinition, staged: string): Promise<void> {
    this.record(definition, { phase: 'verifying', receivedBytes: definition.costs.downloadBytes });
    for (const file of definition.files) {
      const candidate = join(staged, file.name);
      if ((await regularFileFacts(candidate, file.bytes)) === undefined) {
        throw new SttError('install_failed', `installed model file is missing or has the wrong size: ${file.name}`);
      }
      if ((await sha256File(candidate)) !== file.sha256) {
        throw new SttError('install_failed', `installed model checksum mismatch: ${file.name}`);
      }
    }
  }

  /** Swap the staged tree in, keeping the previous one until the swap succeeds. */
  private async publish(definition: SttModelDefinition, staged: string): Promise<string> {
    const installedAt = this.options.now();
    const manifest = buildInstalledManifest(definition, installedAt);
    await writeFile(join(staged, STT_MODEL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: FILE_MODE,
      flag: 'wx',
    });

    const destination = modelDirectoryFor(this.paths, definition);
    const quarantine = (await pathExists(destination))
      ? sttInstallScratchPath(this.paths, definition.id, `replaced-${this.options.uniqueId()}`)
      : undefined;
    if (quarantine !== undefined) await rename(destination, quarantine);
    try {
      await rename(staged, destination);
    } catch (error) {
      if (quarantine !== undefined) await rename(quarantine, destination).catch(() => undefined);
      throw error;
    }
    if (quarantine !== undefined) await rm(quarantine, { recursive: true, force: true });
    return installedAt;
  }

  private async fileMatches(target: string, file: SttModelFileDefinition): Promise<boolean> {
    const before = await regularFileFacts(target, file.bytes);
    if (before === undefined) return false;
    const key = `${target}\0${before.signature}\0${file.sha256}`;
    if (this.verified.get(target) === key) return true;

    const digest = await sha256File(target);
    const after = await regularFileFacts(target, file.bytes);
    if (after === undefined || after.signature !== before.signature || digest !== file.sha256) {
      this.verified.delete(target);
      return false;
    }
    this.verified.set(target, key);
    return true;
  }

  private async download(definition: SttModelDefinition, artifact: InstallDownload, target: string): Promise<void> {
    const response = await this.options.fetch(artifact.url).catch((error: unknown) => {
      throw new SttError('install_failed', `model download failed: ${boundedMessage(error, 'network error')}`, {
        cause: error,
      });
    });
    const body = response.body;
    if (!response.ok || body === null) {
      if (body !== null) await releaseStream(() => body.cancel(), this.releaseBudgetMs);
      throw new SttError('install_failed', `model download failed with HTTP ${response.status}`);
    }
    if (!declaredSizeMatches(response.headers.get('content-length'), artifact.bytes)) {
      await releaseStream(() => body.cancel(), this.releaseBudgetMs);
      throw new SttError('install_failed', 'model download size does not match the pinned manifest');
    }
    await this.streamToFile(definition, artifact, target, body);
  }

  private async streamToFile(
    definition: SttModelDefinition,
    artifact: InstallDownload,
    target: string,
    body: NonNullable<Response['body']>,
  ): Promise<void> {
    const handle = await open(target, 'wx', FILE_MODE);
    const digest = createHash('sha256');
    const reader: DownloadChunkReader = body.getReader();
    let received = 0;
    try {
      for (;;) {
        const chunk = await this.readWithoutStalling(reader);
        if (chunk === undefined) break;
        received += chunk.byteLength;
        if (received > artifact.bytes) {
          throw new SttError('install_failed', 'model download exceeded its pinned size');
        }
        digest.update(chunk);
        await writeAll(handle, chunk);
        this.record(definition, { phase: 'downloading', receivedBytes: artifact.receivedBefore + received });
      }
    } finally {
      await handle.close();
      await releaseStream(() => reader.cancel(), this.releaseBudgetMs);
    }
    if (received !== artifact.bytes) throw new SttError('install_failed', 'model download was incomplete');
    if (digest.digest('hex') !== artifact.sha256) {
      throw new SttError('install_failed', 'model download checksum mismatch');
    }
  }

  /**
   * A download that stops sending is abandoned. Without this the source could
   * hold a model in `installing` forever: the promise never settled, so the
   * install was never cleared and no retry was possible.
   */
  private async readWithoutStalling(reader: DownloadChunkReader): Promise<Uint8Array | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SttError('install_failed', 'model download stalled')), this.stallTimeoutMs);
    });
    try {
      const { done, value } = await Promise.race([reader.read(), stalled]);
      return done ? undefined : value;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Runs a command with Bun's spawner, under a deadline. The child is killed once
 * the deadline passes — first politely, then outright — so no extraction can
 * outlive its install and the install always settles.
 */
export class BunCommandRunner implements SttCommandRunner {
  constructor(private readonly killGraceMs = 2_000) {}

  async run(argv: readonly string[], timeoutMs: number): Promise<SttCommandResult> {
    const child = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    let timedOut = false;
    const insist = setTimeout(() => {
      timedOut = true;
      signal(child, 'SIGTERM');
    }, timeoutMs);
    const escalate = setTimeout(() => {
      signal(child, 'SIGKILL');
    }, timeoutMs + this.killGraceMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(insist);
      clearTimeout(escalate);
      signal(child, 'SIGKILL');
    }
  }
}

function signal(child: { kill(signal: NodeJS.Signals): void }, name: NodeJS.Signals): void {
  try {
    child.kill(name);
  } catch {
    // The child is already gone; there is nothing left to signal.
  }
}
