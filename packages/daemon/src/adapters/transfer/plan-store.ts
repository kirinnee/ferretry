import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { InstantSchema, type SessionTransferPlan, SessionTransferPlanSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { SessionId } from '../../lib/session-id.ts';
import { deriveTransferPlanId } from '../../lib/transfer/prepare.ts';

/** The authoritative global receipt, one file per plan id. */
const RECEIPT_FILE_SUFFIX = '.json';

/**
 * The seam phase a receipt was recorded at.
 *
 * INTEGRATION NOTE: narrowly a string because the seam's phase vocabulary lives in the not-yet-built
 * `src/lib/transfer/**`. The parent should replace this with the seam's real phase enum (design §4.5
 * names the handover phases; a fork uses the first two — `requested` → `replacement_creating` — per
 * §4.11). The store treats phase as an opaque, append-only label, so swapping the type is the only
 * change needed here.
 */
type TransferPersistencePhase = string;

/** An optional terminal outcome stamped onto a receipt once the transfer settles. */
interface TransferOutcome {
  readonly status: string;
  readonly detail?: string;
  readonly at: string;
}

/**
 * The authoritative, daemon-global receipt for one fork transfer (design §4.4 receipt, adapted for
 * the fork row whose source is immutable).
 *
 * It lives at `state/forks/<planId>.json`, keyed by the composite identity
 * `planId = deriveTransferPlanId(sourceSessionId, requestId)`, and is written BEFORE the target
 * session is created. That ordering is the whole reason it is global rather than per-target: a
 * crash between "mint target id" and `lifecycle.create` leaves no target directory to read, so the
 * target id can only be recovered from this receipt — and the create-before-plan window is only
 * closed because the receipt (carrying the parsed plan) is durable before create begins.
 *
 * The parsed plan is embedded so a restart replays without re-deriving its decisions from a source
 * that has moved on. Import still re-reads the pinned source solely to validate the frozen decision.
 * `fingerprint` is the canonical identity of the WHOLE frozen decision — the full plan plus every
 * resolved target field — so a re-prepare that changed any carried fact is a detectable mismatch
 * rather than a silent overwrite of P0 with P1; `phaseHistory` is append-only progress, deliberately
 * outside the fingerprint so a phase advance appends rather than conflicts.
 *
 * Parsed rather than asserted: {@link TransferReceiptSchema} ties every durable anchor together — the
 * outer `planId`, `sourceSessionId`, `requestId` and `fingerprint`, the embedded plan, and
 * `deriveTransferPlanId(...)` — so a damaged receipt keyed as plan A but embedding plan B is refused
 * on the way in rather than redirecting recovery at a different session.
 */
export type TransferReceipt = z.infer<typeof TransferReceiptSchema>;

/** How `FileSessionTransferPlanStore.record` resolved a persisted transfer. */
export interface TransferRecordOutcome {
  /** `created` wrote a fresh receipt; `replayed` found the same request already recorded. */
  readonly status: 'created' | 'replayed';
  readonly receipt: TransferReceipt;
  /** Whether this call appended a new phase to the receipt's history. */
  readonly phaseAppended: boolean;
}

/** How `FileSessionTransferPlanStore.install` resolved a target plan copy. */
export interface TransferInstallOutcome {
  readonly status: 'installed' | 'present';
  readonly plan: SessionTransferPlan;
}

/** The two ways a second transfer can be refused where one is already recorded. */
export type SessionTransferPlanConflictKind =
  /** Same composite key, different request: the key was reused for a different transfer. */
  | 'payload_mismatch'
  /** A different plan id already claims this target session: a session is created by one transfer. */
  | 'session_claimed';

/**
 * Raised where a transfer is recorded a second time with a different request, or a target session is
 * asked to adopt a second plan.
 *
 * The fingerprint is AUTHORIZATION, not an optimisation — the same doctrine as
 * `MigrationReplayGuard`: a request id is caller-minted, so answering a second, different transfer
 * with the first's result would tell a caller its fork to target B succeeded when what was first
 * recorded was a fork to target A. A mismatch is refused outright and the durable receipt stands.
 */
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

/** Raised when a receipt or plan document exists but no longer parses as a valid record. */
export class SessionTransferPlanCorruptError extends Error {
  constructor(cause: unknown) {
    super('the persisted transfer receipt or plan could not be parsed; the durable anchor is corrupt', { cause });
    this.name = 'SessionTransferPlanCorruptError';
  }
}

/** Options for recording a transfer against its composite key. */
export interface SessionTransferRecordOptions {
  /** The caller-minted request id; with the source session it is the composite key. */
  readonly requestId: string;
  /** The pre-minted target session id; written ahead of `lifecycle.create`. */
  readonly targetId: string;
  /** The seam phase this record is being made at (design §4.5). */
  readonly phase: TransferPersistencePhase;
  /** An optional terminal outcome stamped onto the receipt. */
  readonly outcome?: { readonly status: string; readonly detail?: string };
}

/**
 * The canonical fingerprint of one transfer request — the conflict basis for its composite key, and
 * the freeze that makes a replay reuse P0 rather than overwrite it with a re-prepared P1.
 *
 * It is what the request `(sourceSessionId, requestId)` must resolve to: the WHOLE decision
 * preparation made. The full parsed plan already carries the exact message cut (including its
 * `point.v`, so a future point version can never silently match an old receipt), every resolved
 * target field (account, harness, model, effort, context window), the durable settings, and every
 * facet a fork carries. `preparedAt` — the lone wall-clock field — is the only thing excluded: a
 * re-prepare at a later clock is the same request, not a conflict, while a re-prepare that changed an
 * attachment, the workspace, a lineage fact, a durable setting or the resolved target is a different
 * decision and is refused outright. The target id is stored on the receipt and recovered from it on
 * restart, so it is pinned by the record (see `FileSessionTransferPlanStore.record`) rather than by
 * this hash.
 */
export function transferRequestFingerprint(plan: SessionTransferPlan): string {
  return createHash('sha256')
    .update(canonicalJson(decisionOf(plan)))
    .digest('hex');
}

/** The plan with the lone wall-clock `preparedAt` removed: every field left is a resolved decision. */
function decisionOf(plan: SessionTransferPlan): Record<string, unknown> {
  const decision: Record<string, unknown> = { ...plan };
  delete decision.preparedAt;
  return decision;
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
type LeafDirectoryDurability = 'authoritative-receipt' | 'target-session';

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
 * the name. Receipts therefore always persist their lazy leaf's parent. Target plans always persist
 * the complete session-name chain anchored at state: `<state>` then `<state>/sessions`.
 */
function entryParentsToPersist(
  firstCreated: string | undefined,
  leaf: string,
  leafDurability: LeafDirectoryDurability,
): readonly string[] {
  const last = dirname(leaf);
  const requiredTop = leafDurability === 'target-session' ? dirname(last) : last;
  const tops = new Set([requiredTop, ...(firstCreated === undefined ? [] : [dirname(firstCreated)])]);
  const parents: string[] = [];
  for (let directory = last; ; directory = dirname(directory)) {
    parents.push(directory);
    tops.delete(directory);
    if (tops.size === 0) return parents.reverse();
    if (dirname(directory) === directory) {
      throw new Error(`transfer-plan leaf ${leaf} is not beneath its required durable directory chain`);
    }
  }
}

/**
 * Writes complete bytes under a private exclusive name, flushes and closes them, then atomically
 * publishes the file and flushes the containing directory.
 *
 * Receipt directories are lazy global infrastructure, so every receipt write flushes the leaf's
 * parent before publishing. A target plan persists the whole target name chain on its own behalf:
 * lifecycle reservation can make a session directory visible before its own parent barriers finish,
 * and a transfer plan must never become durable inside a target whose name is not.
 */
async function writeDurableAtomicText(
  file: string,
  text: string,
  uniqueId: () => string,
  syncDirectory: DirectorySync,
  leafDurability: LeafDirectoryDurability,
): Promise<void> {
  const leaf = dirname(file);
  const firstCreated = await mkdir(leaf, { recursive: true, mode: 0o700 });
  for (const parent of entryParentsToPersist(firstCreated, leaf, leafDurability)) await syncDirectory(parent);

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
 * to make its name durable too. Authoritative receipts retain their lazy-directory parent guard;
 * target plans retain the complete state-anchored session-name chain.
 */
async function makeVisibleFileNameDurable(
  file: string,
  syncDirectory: DirectorySync,
  leafDurability: LeafDirectoryDurability,
): Promise<void> {
  const leaf = dirname(file);
  for (const parent of entryParentsToPersist(undefined, leaf, leafDurability)) await syncDirectory(parent);
  await syncDirectory(leaf);
}

/**
 * The target-local half of transfer persistence, with no global receipt capability.
 *
 * Forks already have one authoritative daemon-global CAS receipt in
 * `FileSessionForkReceiptStore`. Their binder needs only the exact plan copy beneath the reserved
 * target, so production composition uses this narrower class and cannot accidentally write a
 * second receipt through an invented path. Row-48 consumers that own both halves may keep using
 * `FileSessionTransferPlanStore`, which delegates its target operations here.
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
      await makeVisibleFileNameDurable(file, this.syncDirectory, 'target-session');
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
    await writeDurableAtomicText(file, text, this.uniqueId, this.syncDirectory, 'target-session');
  }
}

/**
 * Durable transfer persistence: the authoritative daemon-global receipt, plus the plan copy installed
 * into the target session once it exists.
 *
 * GLOBAL RECEIPT. `record` writes `state/forks/<planId>.json` BEFORE `lifecycle.create`, keyed by the
 * composite `planId = deriveTransferPlanId(sourceSessionId, requestId)`. The receipt carries the
 * parsed plan, the pre-minted target id, the request fingerprint and an append-only phase history, so
 * a restart recovers the exact target id and plan without re-deriving it from a source that may have
 * moved on. Import still performs its validation-only re-read of the pinned provenance and point.
 * A second record under the same plan id with a different fingerprint (or a different target id) is
 * refused — the composite key names one request.
 *
 * TARGET PLAN COPY. `install` writes the plan into the target session's own directory after it is
 * created, so the new session (and the agent it launches) can read its provenance locally. One plan
 * per target session; a target asked to adopt a second plan id is refused.
 *
 * SOURCE IMMUTABILITY HOLDS BY CONSTRUCTION (seam invariant I1): every write is to `state/forks/` or
 * to the TARGET session directory. No source path is ever opened for writing.
 *
 * NOT CONCURRENCY-SAFE FOR ONE KEY. Two concurrent `record` calls for the same plan id, or `install`
 * calls for the same target, could interleave a read and write; the orchestrator must serialize per
 * key (the seam's request lifecycle does, and `DaemonStorage`'s per-session `SerialExecutor` is the
 * production pattern). Distinct keys are safe, which is all a fan-out of forks needs.
 *
 * INTEGRATION NOTE (for the parent wiring `src/lib/transfer/**`): this is the persistence half of seam
 * I5 and the §4.4 receipt for the fork row. Compose it as
 * `new FileSessionTransferPlanStore(planId => join(paths.state, 'forks', `${planId}.json`),
 * id => join(createSessionPaths(paths, id).directory, 'transfer-plan.json'))`. The orchestrator calls
 * `record` before `lifecycle.create`, `install` after it, advances phase via further `record` calls,
 * and `replay(planId)` after a restart.
 */
export class FileSessionTransferPlanStore {
  private readonly targetPlans: FileSessionTransferTargetPlanStore;

  constructor(
    private readonly receiptFile: (planId: string) => string,
    targetPlanFile: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
    private readonly now: () => string = defaultInstant,
    private readonly syncDirectory: DirectorySync = fsyncTransferPlanDirectory,
    private readonly syncOpenFile: OpenFileSync = fsyncTransferPlanFile,
  ) {
    this.targetPlans = new FileSessionTransferTargetPlanStore(targetPlanFile, uniqueId, syncDirectory, syncOpenFile);
  }

  /**
   * Records (or re-records) the authoritative receipt for this transfer's composite key.
   *
   * No prior receipt → writes it (`created`), embedding the plan, target id, fingerprint and the first
   * phase. A prior receipt with the same fingerprint and target id → appends `phase` if it is new and
   * stamps `outcome` if given (`replayed`) — the crash/restart path. An otherwise exact replay
   * re-flushes the visible receipt and its directory entries before returning. Anything else →
   * `SessionTransferPlanConflictError`: the composite key names one request, and this one differs.
   */
  async record(plan: SessionTransferPlan, options: SessionTransferRecordOptions): Promise<TransferRecordOutcome> {
    const planId = deriveTransferPlanId(plan.source.sessionId, options.requestId);
    if (plan.planId !== planId) {
      throw new SessionTransferPlanConflictError(
        plan.planId,
        'payload_mismatch',
        `plan carries id ${JSON.stringify(plan.planId)} but its source session and request derive ${JSON.stringify(planId)}: the plan id must match the composite key`,
      );
    }
    const fingerprint = transferRequestFingerprint(plan);
    const file = this.receiptFile(planId);
    const existing = await readPinnedJson(file, this.syncOpenFile, async (document, syncPinned) => {
      const held = parseReceipt(document);
      const at = this.now();

      if (
        held.fingerprint !== fingerprint ||
        held.requestId !== options.requestId ||
        held.targetId !== options.targetId
      ) {
        throw new SessionTransferPlanConflictError(
          planId,
          'payload_mismatch',
          `request id was reused for a different transfer ${JSON.stringify(planId)}: one composite key names one frozen decision, target and cut, and the persisted plan is never replaced by a re-prepare`,
        );
      }

      const lastPhase = held.phaseHistory[held.phaseHistory.length - 1]?.phase;
      const phaseAppended = lastPhase !== options.phase;
      const outcome = outcomeEntry(options.outcome, at);
      const receipt: TransferReceipt = {
        ...held,
        // The frozen plan (P0) is reused, never replaced: a replay applies the decision preparation
        // made the first time, not a re-prepare against a source that has since moved on.
        phaseHistory: phaseAppended ? [...held.phaseHistory, { phase: options.phase, at }] : held.phaseHistory,
        outcome: outcome ?? held.outcome,
        updatedAt: phaseAppended || outcome !== null ? at : held.updatedAt,
      };
      const rewrite = phaseAppended || outcome !== null;
      // Only an authoritative exact replay returns from this inode. A phase advance closes it without
      // flushing, then publishes a new, independently durable replacement.
      if (!rewrite) await syncPinned();
      return { receipt, phaseAppended, rewrite };
    });

    if (existing === undefined) {
      const at = this.now();
      const receipt: TransferReceipt = {
        v: 1,
        planId,
        sourceSessionId: plan.source.sessionId,
        requestId: options.requestId,
        targetId: options.targetId,
        fingerprint,
        phaseHistory: [{ phase: options.phase, at }],
        outcome: outcomeEntry(options.outcome, at),
        plan,
        createdAt: at,
        updatedAt: at,
      };
      await this.writeReceipt(planId, receipt);
      return { status: 'created', receipt, phaseAppended: true };
    }

    if (existing.rewrite) await this.writeReceipt(planId, existing.receipt);
    else await this.makeReceiptNameDurable(file);
    return { status: 'replayed', receipt: existing.receipt, phaseAppended: existing.phaseAppended };
  }

  /**
   * The authoritative receipt for a composite key, or `undefined` when none was ever recorded.
   *
   * This is an inspection read and deliberately performs no durability barrier. `record` adds one
   * only for an exact replay (not before replacing a phase-advanced receipt), while `replay` adds one
   * before handing recovery state to downstream work.
   */
  async load(planId: string): Promise<TransferReceipt | undefined> {
    const parsed = await this.readJson(this.receiptFile(planId));
    if (parsed === undefined) return undefined;
    return parseReceipt(parsed);
  }

  /**
   * The plan and receipt to resume from after a restart, located by the composite key.
   *
   * `undefined` when no receipt was ever recorded for this key; the orchestrator then decides whether
   * to begin fresh or refuse. The recovered `receipt.targetId` and `receipt.plan` are everything needed
   * to resume without re-deriving the plan from the source. Before returning an existing receipt,
   * replay re-flushes its visible inode and directory entries so recovery never acts on an unsynced
   * rename left visible by a process crash.
   */
  async replay(planId: string): Promise<{ plan: SessionTransferPlan; receipt: TransferReceipt } | undefined> {
    const file = this.receiptFile(planId);
    const receipt = await readPinnedJson(file, this.syncOpenFile, async (document, syncPinned) => {
      const parsed = parseReceipt(document);
      await syncPinned();
      return parsed;
    });
    if (receipt === undefined) return undefined;
    await this.makeReceiptNameDurable(file);
    return { plan: receipt.plan, receipt };
  }

  /**
   * Installs the plan copy into the target session's own directory, after `lifecycle.create`.
   *
   * Idempotent — a replay that re-installs the exact same plan leaves the file untouched but repairs
   * its durability before returning (`present`). A target directory that already holds a different
   * plan value, even under the same plan id, is refused (`session_claimed`): one target is anchored to
   * one receipt-owned frozen decision.
   */
  async install(targetId: SessionId, plan: SessionTransferPlan): Promise<TransferInstallOutcome> {
    return await this.targetPlans.install(targetId, plan);
  }

  /** The plan copy in the target session's directory, or `undefined` when none was installed. */
  async loadTargetPlan(targetId: SessionId): Promise<SessionTransferPlan | undefined> {
    return await this.targetPlans.load(targetId);
  }

  /** Where the authoritative receipt for a plan id lives. Public so a caller can name it. */
  receiptPath(planId: string): string {
    return this.receiptFile(planId);
  }

  /** Where the target session's plan copy lives. Public so a caller can name it. */
  targetPlanPath(id: SessionId): string {
    return this.targetPlans.targetPlanPath(id);
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

  private async writeReceipt(planId: string, receipt: TransferReceipt): Promise<void> {
    await this.writeAtomicText(this.receiptFile(planId), `${canonicalJson(receipt)}\n`);
  }

  /** Name barrier shared by exact `record` and restart `replay`; each already flushed its pinned inode. */
  private async makeReceiptNameDurable(file: string): Promise<void> {
    await makeVisibleFileNameDurable(file, this.syncDirectory, 'authoritative-receipt');
  }

  private async writeAtomicText(file: string, text: string): Promise<void> {
    await writeDurableAtomicText(file, text, this.uniqueId, this.syncDirectory, 'authoritative-receipt');
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

function outcomeEntry(
  outcome: { readonly status: string; readonly detail?: string } | undefined,
  at: string,
): TransferOutcome | null {
  return outcome === undefined
    ? null
    : { status: outcome.status, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }), at };
}

const TransferReceiptPhaseSchema = z.strictObject({
  phase: z.string().min(1),
  at: InstantSchema,
});

const TransferOutcomeSchema = z.strictObject({
  status: z.string().min(1),
  detail: z.string().optional(),
  at: InstantSchema,
});

/**
 * The whole durable receipt, parsed rather than asserted.
 *
 * Every cross-anchor rule below is a property a replay depends on, which is why they are refinements
 * on the schema rather than comments: a receipt that violates one is refused on the way IN, before it
 * can redirect recovery at a session or a plan it does not name. A damaged receipt keyed as plan A
 * but embedding plan B fails the embedded `plan.planId` or the re-derivation of the plan id, and a
 * stale fingerprint fails against the plan it claims to freeze.
 */
const TransferReceiptSchema = z
  .strictObject({
    v: z.literal(1),
    planId: z.string().min(1),
    sourceSessionId: z.string().min(1),
    requestId: z.string().min(1),
    targetId: z.string().min(1),
    fingerprint: z.string().min(1),
    phaseHistory: z.array(TransferReceiptPhaseSchema).min(1).readonly(),
    outcome: TransferOutcomeSchema.nullable(),
    plan: SessionTransferPlanSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .superRefine((value, context) => {
    if (value.planId !== deriveTransferPlanId(value.sourceSessionId, value.requestId))
      context.addIssue({
        code: 'custom',
        message: 'the plan id must be the composite of its source session and request id',
        path: ['planId'],
      });

    if (value.plan.planId !== value.planId)
      context.addIssue({
        code: 'custom',
        message: 'the embedded plan must carry the same plan id as the receipt that freezes it',
        path: ['plan', 'planId'],
      });

    if (value.sourceSessionId !== value.plan.source.sessionId)
      context.addIssue({
        code: 'custom',
        message: 'the receipt must name the source session its own plan was prepared from',
        path: ['sourceSessionId'],
      });

    if (value.fingerprint !== transferRequestFingerprint(value.plan))
      context.addIssue({
        code: 'custom',
        message: 'the fingerprint must be the canonical identity of the frozen plan',
        path: ['fingerprint'],
      });
  });

function parseReceipt(value: unknown): TransferReceipt {
  const parsed = TransferReceiptSchema.safeParse(value);
  if (!parsed.success) throw new SessionTransferPlanCorruptError(parsed.error);
  return parsed.data;
}

/** A wall-clock instant; overridable in tests so a phase history is deterministic. */
function defaultInstant(): string {
  return new Date().toISOString();
}

/** Join helper for callers that want the conventional `state/forks/<planId>.json` layout. */
export function forkReceiptPath(stateDirectory: string, planId: string): string {
  return join(stateDirectory, 'forks', `${planId}${RECEIPT_FILE_SUFFIX}`);
}
