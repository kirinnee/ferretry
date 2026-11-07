import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type SessionTransferPlan, SessionTransferPlanSchema } from '../../lib/protocol/session-transfer.ts';
import type { SessionId } from '../../lib/session-id.ts';

/** How `FileSessionTransferTargetPlanStore.install` resolved a target plan copy. */
export interface TransferInstallOutcome {
  readonly status: 'installed' | 'present';
  readonly plan: SessionTransferPlan;
}

/** The one way a target session is refused a plan: it already belongs to another transfer. */
export type SessionTransferPlanConflictKind =
  /** A different plan id already claims this target session: a session is created by one transfer. */
  'session_claimed';

/** Raised where a target session is asked to adopt a second plan. */
export class SessionTransferPlanConflictError extends Error {
  constructor(
    readonly planId: string,
    readonly conflict: SessionTransferPlanConflictKind,
    message: string,
  ) {
    super(message);
    this.name = 'SessionTransferPlanConflictError';
  }
}

/** Raised when a plan document exists but no longer parses as a valid record. */
export class SessionTransferPlanCorruptError extends Error {
  constructor(cause: unknown) {
    super('the persisted transfer plan could not be parsed; the durable anchor is corrupt', { cause });
    this.name = 'SessionTransferPlanCorruptError';
  }
}

/** Stable JSON: object keys sorted recursively, so two equal values serialise alike regardless of construction path. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

type DirectorySync = (path: string) => Promise<void>;
type OpenFileSync = (handle: FileHandle, path: string) => Promise<void>;

const TOLERATED_DIRECTORY_SYNC_CODES: ReadonlySet<string> = new Set(['EINVAL', 'ENOTSUP', 'EPERM']);

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

/**
 * Persists one directory's entries.
 *
 * Exported so ordering tests can wrap the real operation rather than replace it with a recorder that
 * would make the durability claim vacuous.
 */
export async function fsyncTransferPlanDirectory(
  path: string,
  syncOpenDirectory: (handle: FileHandle) => Promise<void> = async handle => await handle.sync(),
  openDirectory: (path: string) => Promise<FileHandle> = async directory => await open(directory, 'r'),
): Promise<void> {
  try {
    const handle = await openDirectory(path);
    try {
      await syncOpenDirectory(handle);
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Some filesystems refuse the directory open itself; others allow the open and refuse fsync.
    // Both report one unsupported platform capability, so the tolerance surrounds the COMPLETE
    // directory operation. Exactly the repo-standard set degrades the NAME to page-cache visibility;
    // a file flush remains strict, and every other directory failure propagates.
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (typeof code !== 'string' || !TOLERATED_DIRECTORY_SYNC_CODES.has(code)) throw error;
  }
}

/** Flushes one already-open file handle strictly; file durability errors are never tolerated. */
export async function fsyncTransferPlanFile(handle: FileHandle): Promise<void> {
  await handle.sync();
}

/**
 * The parents whose entries make one leaf directory reachable, oldest first.
 *
 * `mkdir(..., { recursive: true })` returns its first created path, or `undefined` when it created
 * nothing. Every directory it created is a contiguous chain through `leaf`, but creation ownership
 * alone is insufficient: another caller can observe a visible directory before its creator syncs
 * the name. Target plans therefore always persist the complete session-name chain anchored at state:
 * `<state>` then `<state>/sessions`.
 */
function entryParentsToPersist(firstCreated: string | undefined, leaf: string): readonly string[] {
  const last = dirname(leaf);
  const requiredTop = dirname(last);
  const tops = new Set([requiredTop, ...(firstCreated === undefined ? [] : [dirname(firstCreated)])]);
  const parents: string[] = [];
  for (let directory = last; ; directory = dirname(directory)) {
    parents.push(directory);
    tops.delete(directory);
    if (tops.size === 0 || dirname(directory) === directory) return parents.reverse();
  }
}

/**
 * Writes complete bytes under a private exclusive name, flushes and closes them, then atomically
 * publishes the file and flushes the containing directory.
 *
 * A target plan persists the whole target name chain on its own behalf: lifecycle reservation can
 * make a session directory visible before its own parent barriers finish, and a transfer plan must never become durable inside a target whose name is not.
 */
async function writeDurableAtomicText(
  file: string,
  text: string,
  uniqueId: () => string,
  syncDirectory: DirectorySync,
): Promise<void> {
  const leaf = dirname(file);
  const firstCreated = await mkdir(leaf, { recursive: true, mode: 0o700 });
  for (const parent of entryParentsToPersist(firstCreated, leaf)) await syncDirectory(parent);

  const temporary = `${file}.${uniqueId()}.tmp`;
  let ownsTemporary = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    // Rename consumed the name this call owned. It is free for immediate reuse, including while the
    // directory sync awaits, so cleanup must stop targeting it before that next scheduling point.
    ownsTemporary = false;
    await syncDirectory(leaf);
  } finally {
    // Never remove a colliding name we failed to create, or a name reused after our rename consumed it.
    if (ownsTemporary) await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Reads one visible document and lets the caller decide from, and flush, one pinned read-only inode.
 *
 * The callback receives parsed JSON and a flush that closes over THE SAME handle those bytes came
 * from. Reading by path and reopening by path would be two name lookups around a concurrent rename:
 * it could validate inode A, flush inode B, and return a durability claim about bytes it never made
 * durable. `undefined` is reserved for an absent name; malformed bytes are a corrupt durable anchor.
 */
async function readPinnedJson<T>(
  file: string,
  syncOpenFile: OpenFileSync,
  use: (document: unknown, syncPinned: () => Promise<void>) => Promise<T>,
): Promise<T | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    const document = parseJsonDocument(await handle.readFile('utf8'));
    return await use(document, async () => await syncOpenFile(handle, file));
  } finally {
    await handle.close();
  }
}

/**
 * Persists the names an exact replay depends on after its pinned file handle has been flushed/closed.
 *
 * A process can die after rename made the final path visible but before its directory fsync. A fresh
 * process can read the exact document from page cache, flush that pinned inode, then use this barrier
 * to make its name durable too. Target plans retain the complete state-anchored session-name chain.
 */
async function makeVisibleFileNameDurable(file: string, syncDirectory: DirectorySync): Promise<void> {
  const leaf = dirname(file);
  for (const parent of entryParentsToPersist(undefined, leaf)) await syncDirectory(parent);
  await syncDirectory(leaf);
}

/**
 * The target-local transfer persistence, with no global receipt capability.
 *
 * Forks already have one authoritative daemon-global CAS receipt in
 * `FileSessionForkReceiptStore`. Their binder needs only the exact plan copy beneath the reserved
 * target, so production composition cannot accidentally write a
 * second receipt through an invented path.
 */
export class FileSessionTransferTargetPlanStore {
  constructor(
    private readonly targetPlanFile: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
    private readonly syncDirectory: DirectorySync = fsyncTransferPlanDirectory,
    private readonly syncOpenFile: OpenFileSync = fsyncTransferPlanFile,
  ) {}

  /**
   * Installs one parsed plan beneath the target, idempotently and without a receipt write.
   *
   * An exact visible replay leaves the document untouched but re-flushes its inode, the state root,
   * sessions directory and target directory before returning `present`; visibility can outlive a
   * process whose rename or session-name barriers were not yet durable across host power loss.
   */
  async install(targetId: SessionId, plan: SessionTransferPlan): Promise<TransferInstallOutcome> {
    const file = this.targetPlanFile(targetId);
    const existing = await readPinnedJson(file, this.syncOpenFile, async (document, syncPinned) => {
      const parsed = SessionTransferPlanSchema.safeParse(document);
      if (!parsed.success) throw new SessionTransferPlanCorruptError(parsed.error);
      if (parsed.data.planId !== plan.planId) {
        throw new SessionTransferPlanConflictError(
          plan.planId,
          'session_claimed',
          `target session already holds plan ${JSON.stringify(parsed.data.planId)}, not ${JSON.stringify(plan.planId)}: a session is created by one transfer`,
        );
      }
      if (canonicalJson(parsed.data) !== canonicalJson(plan)) {
        throw new SessionTransferPlanConflictError(
          plan.planId,
          'session_claimed',
          `target session already holds a different frozen plan under id ${JSON.stringify(plan.planId)}: replay must install the exact receipt-owned plan`,
        );
      }
      // The comparison and this flush are one inode operation. Only an exact plan earns a durability
      // claim; conflicts and corrupt documents close without flushing and are never rewritten here.
      await syncPinned();
      return { status: 'present', plan: parsed.data } as const;
    });
    if (existing !== undefined) {
      await makeVisibleFileNameDurable(file, this.syncDirectory);
      return existing;
    }
    await this.writeAtomicText(file, `${canonicalJson(plan)}\n`);
    return { status: 'installed', plan };
  }

  /** The parsed plan beneath the target, or `undefined` when none was installed. */
  async load(targetId: SessionId): Promise<SessionTransferPlan | undefined> {
    const parsed = await this.readJson(this.targetPlanFile(targetId));
    if (parsed === undefined) return undefined;
    const plan = SessionTransferPlanSchema.safeParse(parsed);
    if (!plan.success) throw new SessionTransferPlanCorruptError(plan.error);
    return plan.data;
  }

  /** Where this target's plan copy lives. There is deliberately no receipt-path counterpart. */
  targetPlanPath(id: SessionId): string {
    return this.targetPlanFile(id);
  }

  private async readJson(path: string): Promise<unknown | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    return parseJsonDocument(text);
  }

  private async writeAtomicText(file: string, text: string): Promise<void> {
    await writeDurableAtomicText(file, text, this.uniqueId, this.syncDirectory);
  }
}

/** Parses whole document bytes; a present but malformed anchor is never reported as absent. */
function parseJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SessionTransferPlanCorruptError(error);
  }
}
