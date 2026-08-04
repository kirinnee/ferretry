import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, createReadStream, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse, sep } from 'node:path';
import { z } from 'zod';
import type {
  DaemonSnapshot,
  DaemonSnapshotBuild,
  DaemonSnapshotIdentity,
  IDaemonSnapshotPort,
} from '../../lib/daemon/ports.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const SNAPSHOT_ID = /^sha256-[0-9a-f]{64}$/u;
const MANIFEST = 'manifest.json';
const SNAPSHOTS = 'snapshots';
const STAGING = 'staging';
const CURRENT = 'current';
const PROMOTED = 'promoted';
const PROMOTED_VERSION = '1\n';

const SnapshotManifestSchema = z
  .object({
    version: z.literal(1),
    daemon: z.object({ product: z.string().min(1), name: z.string().min(1) }).strict(),
    id: z.string().regex(SNAPSHOT_ID),
    digest: z.string().regex(DIGEST),
    bytes: z.number().int().positive(),
    sourceBinary: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;
type BigFileStat = BigIntStats;

export type DaemonSnapshotStoreErrorKind = 'damaged' | 'invalid_id' | 'invalid_source' | 'not_found' | 'source_changed';

/** Every refusal names whether the source, caller input or durable store was at fault. */
export class DaemonSnapshotStoreError extends Error {
  constructor(
    readonly kind: DaemonSnapshotStoreErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonSnapshotStoreError';
  }
}

export interface FileDaemonSnapshotStoreOptions {
  readonly root: string;
  readonly daemon: DaemonSnapshotIdentity;
  readonly sourceBinary: string;
  readonly now?: (() => Date) | undefined;
  readonly uniqueId?: (() => string) | undefined;
  /** Observation seam used by deterministic race tests; production leaves it absent. */
  readonly afterCopy?: (() => Promise<void>) | undefined;
}

interface FileDigest {
  readonly digest: string;
  readonly bytes: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function stableStat(path: string): Promise<BigIntStats> {
  return await stat(path, { bigint: true });
}

function sameFile(left: BigFileStat, right: BigFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function digestFile(path: string): Promise<FileDigest> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { digest: hash.digest('hex'), bytes };
}

async function durableWrite(path: string, contents: string, mode: number): Promise<void> {
  const handle = await open(path, 'wx', mode);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Filesystem-backed, content-addressed daemon snapshots.
 *
 * A build is copied and verified under `staging/`, made read-only, then published into an exclusively
 * reserved directory under `snapshots/`. Promotion is a same-directory symlink rename, so a reader
 * sees either the old complete target or the new complete target. The source is statted before and
 * after both copy and hashing; an editor cannot produce a successful snapshot by changing the file
 * halfway through the build.
 */
export class FileDaemonSnapshotStore implements IDaemonSnapshotPort {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly uniqueId: () => string;

  constructor(private readonly options: FileDaemonSnapshotStoreOptions) {
    const root = normalize(options.root);
    if (!isAbsolute(root) || root === parse(root).root) {
      throw new DaemonSnapshotStoreError('damaged', `snapshot root must be a non-root absolute path: ${options.root}`);
    }
    this.root = root;
    this.now = options.now ?? (() => new Date());
    this.uniqueId = options.uniqueId ?? randomUUID;
  }

  async build(): Promise<DaemonSnapshotBuild> {
    await this.#ensureStore();
    const source = await this.#source();
    const before = await stableStat(source);
    this.#requireSource(before, source);

    const stage = join(this.root, STAGING, this.uniqueId());
    await mkdir(stage, { mode: 0o700 });
    try {
      const stagedBinary = join(stage, this.options.daemon.name);
      await copyFile(source, stagedBinary);
      await this.options.afterCopy?.();
      const afterCopy = await stableStat(source);
      if (!sameFile(before, afterCopy)) this.#sourceChanged(source);

      const [sourceDigest, copiedDigest] = await Promise.all([digestFile(source), digestFile(stagedBinary)]);
      const afterHash = await stableStat(source);
      if (!sameFile(before, afterHash)) this.#sourceChanged(source);
      if (sourceDigest.digest !== copiedDigest.digest || sourceDigest.bytes !== copiedDigest.bytes) {
        this.#sourceChanged(source);
      }

      const id = `sha256-${copiedDigest.digest}`;
      const manifest: SnapshotManifest = {
        version: 1,
        daemon: this.options.daemon,
        id,
        digest: copiedDigest.digest,
        bytes: copiedDigest.bytes,
        sourceBinary: source,
        createdAt: this.now().toISOString(),
      };

      const stagedManifest = join(stage, MANIFEST);
      await durableWrite(stagedManifest, `${JSON.stringify(manifest)}\n`, 0o600);
      const binaryHandle = await open(stagedBinary, 'r');
      try {
        await binaryHandle.sync();
      } finally {
        await binaryHandle.close();
      }
      await chmod(stagedBinary, 0o555);
      await chmod(stagedManifest, 0o444);
      await syncDirectory(stage);

      const target = this.#snapshotDirectory(id);
      try {
        // `rename(stage, target)` is not exclusive on POSIX: it replaces an existing empty target
        // directory. Reserve the content address with `mkdir` instead, then move only this builder's
        // complete staged files into the directory it owns. During publication the target is mutable,
        // so a concurrent verifier fails closed; a crash leaves damaged evidence that no later build
        // overwrites or silently repairs.
        await mkdir(target, { mode: 0o700 });
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error;
        const snapshot = await this.#readSnapshot(id);
        return { ...snapshot, created: false };
      }
      await rename(stagedBinary, join(target, this.options.daemon.name));
      await rename(stagedManifest, join(target, MANIFEST));
      await syncDirectory(target);
      await chmod(target, 0o555);
      await syncDirectory(target);
      await syncDirectory(join(this.root, SNAPSHOTS));
      const snapshot = await this.#readSnapshot(id);
      return { ...snapshot, created: true };
    } finally {
      await chmod(stage, 0o700).catch(() => undefined);
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async promote(id: string): Promise<DaemonSnapshot> {
    this.#requireId(id);
    const snapshot = await this.#readSnapshot(id);
    await this.#ensureStore();
    const temporary = join(this.root, `.current-${this.uniqueId()}.tmp`);
    const target = join(SNAPSHOTS, id, this.options.daemon.name);
    let ownsTemporary = false;
    try {
      await symlink(target, temporary, 'file');
      ownsTemporary = true;
      // Publish durable evidence before the pointer. A crash or deletion can therefore never turn a
      // store that was promoted into apparently fresh state. The brief damaged window before the
      // first pointer appears is deliberately fail-closed, and an explicit promote repairs it.
      await this.#ensurePromotionMarker();
      await rename(temporary, join(this.root, CURRENT));
      ownsTemporary = false;
      await syncDirectory(this.root);
    } finally {
      if (ownsTemporary) await rm(temporary, { force: true }).catch(() => undefined);
    }
    // A concurrent later promotion may already have superseded this one by the time the caller
    // observes `current`. The successful rename above is this operation's linearization point, so
    // return the exact verified snapshot it promoted rather than spuriously rejecting that race.
    return snapshot;
  }

  async current(): Promise<DaemonSnapshot | undefined> {
    const rootState = await this.#optionalLstat(this.root);
    if (rootState === undefined) return undefined;
    await this.#validateStore(rootState);

    const pointer = join(this.root, CURRENT);
    const promoted = await this.#hasPromotionMarker();
    let pointerStat: Stats;
    try {
      pointerStat = await lstat(pointer);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        if (!promoted) return undefined;
        throw new DaemonSnapshotStoreError('damaged', `${pointer} is missing after this store was promoted`);
      }
      throw error;
    }
    if (!pointerStat.isSymbolicLink()) {
      throw new DaemonSnapshotStoreError('damaged', `${pointer} is not an atomic snapshot symlink`);
    }
    const target = await readlink(pointer);
    const parts = target.split(sep);
    const id = parts[1] ?? '';
    if (
      parts.length !== 3 ||
      parts[0] !== SNAPSHOTS ||
      parts[2] !== this.options.daemon.name ||
      !SNAPSHOT_ID.test(id)
    ) {
      throw new DaemonSnapshotStoreError('damaged', `${pointer} has an invalid daemon snapshot target: ${target}`);
    }
    if (!promoted) {
      throw new DaemonSnapshotStoreError('damaged', `${pointer} exists without durable promotion evidence`);
    }
    try {
      const snapshot = await this.#readSnapshot(id);
      // Canonicalize the target captured by `readlink`, not the live pointer: another valid promote
      // may replace `current` after our read, and this observation still linearizes before it.
      const resolved = await realpath(join(this.root, target));
      const expected = snapshot.binaryPath;
      if (resolved !== expected) {
        throw new DaemonSnapshotStoreError('damaged', `${pointer} resolves outside snapshot ${id}`);
      }
      return snapshot;
    } catch (error) {
      if (error instanceof DaemonSnapshotStoreError && error.kind === 'not_found') {
        throw new DaemonSnapshotStoreError('damaged', `${pointer} refers to a missing snapshot ${id}`);
      }
      throw error;
    }
  }

  async list(): Promise<readonly DaemonSnapshot[]> {
    const rootState = await this.#optionalLstat(this.root);
    if (rootState === undefined) return [];
    await this.#validateStore(rootState);
    const directory = join(this.root, SNAPSHOTS);
    const entries = await readdir(directory, { withFileTypes: true });
    const snapshots: DaemonSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name)) {
        throw new DaemonSnapshotStoreError('damaged', `${directory} contains an invalid snapshot entry: ${entry.name}`);
      }
      snapshots.push(await this.#readSnapshot(entry.name));
    }
    return snapshots.sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    );
  }

  async #ensureStore(): Promise<void> {
    await mkdir(dirname(this.root), { recursive: true, mode: 0o700 });
    let created = false;
    try {
      await mkdir(this.root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if (created) {
      // Only the invocation that exclusively created the root may initialize it. Once the root is
      // observable, missing structure is damage and must not be filled in by a later operation.
      await mkdir(join(this.root, SNAPSHOTS), { mode: 0o700 });
      await mkdir(join(this.root, STAGING), { mode: 0o700 });
      await syncDirectory(this.root);
    }
    const rootState = await lstat(this.root);
    await this.#validateStore(rootState);
  }

  async #validateStore(rootState: Stats): Promise<void> {
    this.#requireDirectory(rootState, this.root, true);
    for (const name of [SNAPSHOTS, STAGING]) {
      const directory = join(this.root, name);
      const state = await this.#optionalLstat(directory);
      if (state === undefined) {
        throw new DaemonSnapshotStoreError('damaged', `${this.root} exists without its ${name} directory`);
      }
      this.#requireDirectory(state, directory, true);
    }
    await this.#hasPromotionMarker();
  }

  /** A hard-link publication makes the marker visible only after its complete contents are durable. */
  async #ensurePromotionMarker(): Promise<void> {
    const marker = join(this.root, PROMOTED);
    const temporary = join(this.root, `.${PROMOTED}-${this.uniqueId()}.tmp`);
    let ownsTemporary = false;
    let created = false;
    try {
      await durableWrite(temporary, PROMOTED_VERSION, 0o444);
      ownsTemporary = true;
      try {
        await link(temporary, marker);
        created = true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      if (created) await syncDirectory(this.root);
      if (!(await this.#hasPromotionMarker())) {
        throw new DaemonSnapshotStoreError('damaged', `${marker} was not published`);
      }
    } finally {
      if (ownsTemporary) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #hasPromotionMarker(): Promise<boolean> {
    const marker = join(this.root, PROMOTED);
    const state = await this.#optionalLstat(marker);
    if (state === undefined) return false;
    this.#requireRegular(state, marker, false);
    let contents: string;
    try {
      contents = await readFile(marker, 'utf8');
    } catch (error) {
      throw new DaemonSnapshotStoreError('damaged', `cannot read ${marker}: ${errorMessage(error)}`);
    }
    if (contents !== PROMOTED_VERSION) {
      throw new DaemonSnapshotStoreError('damaged', `${marker} has an invalid promotion marker version`);
    }
    return true;
  }

  async #source(): Promise<string> {
    try {
      return await realpath(this.options.sourceBinary);
    } catch (error) {
      throw new DaemonSnapshotStoreError(
        'invalid_source',
        `cannot resolve daemon snapshot source ${this.options.sourceBinary}: ${errorMessage(error)}`,
      );
    }
  }

  #requireSource(source: BigFileStat, path: string): void {
    if (!source.isFile()) {
      throw new DaemonSnapshotStoreError('invalid_source', `daemon snapshot source is not a regular file: ${path}`);
    }
    if (source.size <= 0n) {
      throw new DaemonSnapshotStoreError('invalid_source', `daemon snapshot source is empty: ${path}`);
    }
    if ((source.mode & 0o111n) === 0n) {
      throw new DaemonSnapshotStoreError('invalid_source', `daemon snapshot source is not executable: ${path}`);
    }
  }

  #sourceChanged(source: string): never {
    throw new DaemonSnapshotStoreError(
      'source_changed',
      `daemon snapshot source changed while it was being copied: ${source}`,
    );
  }

  #requireId(id: string): void {
    if (!SNAPSHOT_ID.test(id)) {
      throw new DaemonSnapshotStoreError('invalid_id', `invalid ${this.options.daemon.name} snapshot id: ${id}`);
    }
  }

  #snapshotDirectory(id: string): string {
    return join(this.root, SNAPSHOTS, id);
  }

  async #readSnapshot(id: string): Promise<DaemonSnapshot> {
    this.#requireId(id);
    const directory = this.#snapshotDirectory(id);
    let directoryState: Stats;
    try {
      directoryState = await lstat(directory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        throw new DaemonSnapshotStoreError('not_found', `${this.options.daemon.name} snapshot not found: ${id}`);
      }
      throw error;
    }
    this.#requireDirectory(directoryState, directory, false);
    const names = (await readdir(directory)).sort();
    const expected = [MANIFEST, this.options.daemon.name].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      throw new DaemonSnapshotStoreError('damaged', `${directory} is not a complete two-file daemon snapshot`);
    }

    const manifestPath = join(directory, MANIFEST);
    const binaryPath = join(directory, this.options.daemon.name);
    const [manifestState, binaryState] = await Promise.all([lstat(manifestPath), lstat(binaryPath)]);
    this.#requireRegular(manifestState, manifestPath, false);
    this.#requireRegular(binaryState, binaryPath, true);

    let document: unknown;
    try {
      document = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    } catch (error) {
      throw new DaemonSnapshotStoreError('damaged', `cannot parse ${manifestPath}: ${errorMessage(error)}`);
    }
    const parsed = SnapshotManifestSchema.safeParse(document);
    if (!parsed.success) {
      throw new DaemonSnapshotStoreError('damaged', `invalid daemon snapshot manifest ${manifestPath}`);
    }
    const manifest = parsed.data;
    if (manifest.daemon.product !== this.options.daemon.product || manifest.daemon.name !== this.options.daemon.name) {
      throw new DaemonSnapshotStoreError('damaged', `${manifestPath} belongs to a different daemon`);
    }
    if (manifest.id !== id || manifest.digest !== id.slice('sha256-'.length) || !isAbsolute(manifest.sourceBinary)) {
      throw new DaemonSnapshotStoreError('damaged', `${manifestPath} does not identify snapshot ${id}`);
    }
    const [actual, canonicalSnapshots, canonicalBinary] = await Promise.all([
      digestFile(binaryPath),
      realpath(join(this.root, SNAPSHOTS)),
      realpath(binaryPath),
    ]);
    if (actual.digest !== manifest.digest || actual.bytes !== manifest.bytes) {
      throw new DaemonSnapshotStoreError('damaged', `${binaryPath} does not match its snapshot manifest`);
    }
    if (canonicalBinary !== join(canonicalSnapshots, id, this.options.daemon.name)) {
      throw new DaemonSnapshotStoreError('damaged', `${binaryPath} resolves outside snapshot ${id}`);
    }
    return {
      id,
      daemon: manifest.daemon,
      sourceBinary: manifest.sourceBinary,
      binaryPath: canonicalBinary,
      bytes: manifest.bytes,
      createdAt: manifest.createdAt,
    };
  }

  #requireDirectory(state: Stats, path: string, writable: boolean): void {
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new DaemonSnapshotStoreError('damaged', `${path} is not a real directory`);
    }
    if (!writable && (state.mode & 0o222) !== 0) {
      throw new DaemonSnapshotStoreError('damaged', `${path} is mutable; snapshots must be read-only`);
    }
  }

  #requireRegular(state: Stats, path: string, executable: boolean): void {
    if (!state.isFile() || state.isSymbolicLink()) {
      throw new DaemonSnapshotStoreError('damaged', `${path} is not a regular snapshot file`);
    }
    if ((state.mode & 0o222) !== 0) {
      throw new DaemonSnapshotStoreError('damaged', `${path} is mutable; snapshots must be read-only`);
    }
    if (executable && (state.mode & 0o111) === 0) {
      throw new DaemonSnapshotStoreError('damaged', `${path} is not executable`);
    }
  }

  async #optionalLstat(path: string): Promise<Stats | undefined> {
    try {
      return await lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }
}
