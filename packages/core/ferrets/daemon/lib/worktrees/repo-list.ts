import path from 'node:path';
import {
  isListableCommonDirectory,
  REPO_WORKTREE_LIMIT,
  type ManagedWorktreeSummary,
  type RepoWorktreeListResponse,
  type RepoWorktreeRow,
  type WorktreeLiveState,
} from '../../../contract/index.ts';
import { bounded } from '../moves/bounded.ts';
import { WorktreeError } from './errors.ts';
import { isWithinDirectory } from './policy.ts';
import { isWorktreeSessionActive, type WorktreeSessionFact } from './service.ts';
import type {
  CheckManagedWorktreeRemovalInput,
  ManagedWorktree,
  ManagedWorktreeInspection,
  WorktreeListEntry,
} from './types.ts';

/**
 * Every worktree of one repository: what Git lists, merged with what Ferretry records and who stands in it.
 *
 * GIT IS THE LIST, THE REGISTRY IS ONLY A LABEL. A checkout somebody made by hand, in `/tmp` or inside the repository,
 * is a worktree all the same and is listed (`tracked: 'none'`); a registry record Git no longer lists is not a worktree
 * of this repository and is not invented here. Nothing is written.
 *
 * NEVER A HANG, NEVER A GUESS. At most {@link REPO_WORKTREE_LIMIT} rows are read; each is inspected under its own timeout
 * and the whole listing under a budget, a few at a time; a row that cannot be read keeps Git's own facts for it and says in
 * `live.undetermined` what is missing, exactly as the managed list does. The one failure that is not a row's is the
 * repository itself: an unusable common directory is refused.
 */

/** How long one row's inspection may take before the row says it could not be read. */
const REPO_ROW_TIMEOUT_MS = 15_000;
/** How long the whole listing keeps starting inspections; later rows are listed with Git's facts and a stated reason. */
export const REPO_LIST_BUDGET_MS = 60_000;
/** How many rows are inspected at once: a repository with hundreds of worktrees must not start hundreds of Git children. */
const REPO_INSPECT_PARALLEL = 4;

/** What the listing is built from. Every member answers from the live host or the registry; none is cached. */
export interface RepoWorktreeEvidence {
  /** `git worktree list` of the repository this directory is the common directory of, refusing anything that is not one. */
  rows(commonDirectory: string): Promise<readonly WorktreeListEntry[]>;
  /** The managed list's own inspection (live state), so a row here and a row there never disagree. */
  examine(input: CheckManagedWorktreeRemovalInput): Promise<ManagedWorktreeInspection>;
  /** The registry's durable facts. */
  records(): Promise<readonly ManagedWorktreeSummary[]>;
  /** Which ferrets stand in which folders; `undefined` when the fleet could not be read. */
  sessions(): Promise<readonly WorktreeSessionFact[] | undefined>;
  /** Where managed checkouts live (the inspection's containment reference). */
  readonly managedRoot: string;
  readonly clock: {
    nowMs(): number;
    sleep(ms: number): Promise<void>;
  };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A worktree this daemon did not record, as the inspection reads one.
 *
 * `gitDir` is the checkout's own folder on purpose: the inspection reads an ownership marker inside it, an untracked
 * checkout has none, and pointing it at the folder the daemon already may reach keeps that read inside the same fence.
 * The inspection's removal verdict is not used here; only its live state is.
 */
function inspectedAs(entry: WorktreeListEntry, commonDirectory: string, mainPath: string): ManagedWorktree {
  return {
    version: 1,
    path: entry.path,
    branch: entry.branch ?? '',
    repositoryRoot: mainPath,
    commonDir: commonDirectory,
    gitDir: entry.path,
    ownershipToken: '',
    createdAt: '',
    initialHead: entry.head ?? '',
    branchPreexisted: true,
    sourceCwd: entry.path,
    relativeCwd: '',
  };
}

/** Git's own facts for a row, with `undetermined` carrying what is not known. */
function gitFacts(entry: WorktreeListEntry, undetermined: readonly string[]): WorktreeLiveState {
  return {
    ...(entry.head === undefined ? {} : { head: entry.head }),
    ...(entry.branch === undefined ? {} : { branch: entry.branch }),
    detached: entry.detached,
    ...(entry.locked === undefined ? {} : { locked: entry.locked }),
    ...(entry.prunable === undefined ? {} : { prunable: entry.prunable }),
    undetermined: [...undetermined],
  };
}

/** Git's list wins where the inspection could not say (a folder gone from disk is still `prunable` to Git). */
function overlaid(live: WorktreeLiveState, entry: WorktreeListEntry): WorktreeLiveState {
  return {
    ...live,
    ...(live.head === undefined && entry.head !== undefined ? { head: entry.head } : {}),
    ...(live.branch === undefined && entry.branch !== undefined ? { branch: entry.branch } : {}),
    ...(live.locked === undefined && entry.locked !== undefined ? { locked: entry.locked } : {}),
    ...(live.prunable === undefined && entry.prunable !== undefined ? { prunable: entry.prunable } : {}),
  };
}

/**
 * Which row each ferret stands in: the DEEPEST row containing its folder, so a worktree nested inside another (a
 * `.worktrees/` folder inside the main checkout) is not counted as the outer one's.
 */
export function ferretsByRow(
  rows: readonly WorktreeListEntry[],
  sessions: readonly WorktreeSessionFact[],
): ReadonlyMap<number, readonly { readonly id: string; readonly active: boolean }[]> {
  const byRow = new Map<number, { id: string; active: boolean }[]>();
  for (const session of sessions) {
    let best = -1;
    rows.forEach((row, index) => {
      if (row.bare || !isWithinDirectory(row.path, session.cwd)) return;
      const current = rows[best];
      if (current === undefined || path.resolve(row.path).length > path.resolve(current.path).length) best = index;
    });
    if (best < 0) continue;
    byRow.set(best, [...(byRow.get(best) ?? []), { id: session.id, active: isWorktreeSessionActive(session) }]);
  }
  return byRow;
}

export class RepoWorktreeLister {
  constructor(private readonly evidence: RepoWorktreeEvidence) {}

  async list(commonDirectory: string): Promise<RepoWorktreeListResponse> {
    if (!isListableCommonDirectory(commonDirectory)) {
      throw new WorktreeError(
        'invalid_common_directory',
        'commonDir must be an absolute path to a git common directory',
      );
    }
    const entries = await this.evidence.rows(commonDirectory);
    const listed = entries.slice(0, REPO_WORKTREE_LIMIT);
    const mainPath = listed[0]?.path ?? '';
    const [records, sessions] = await Promise.all([
      this.evidence.records().catch(() => undefined),
      this.evidence.sessions().catch(() => undefined),
    ]);
    const tracked = new Set(
      (records ?? [])
        .filter(record => record.removedAt === undefined && record.unresolved === undefined)
        .map(record => path.resolve(record.path)),
    );
    const standing = sessions === undefined ? undefined : ferretsByRow(listed, sessions);
    const lives = await this.#inspect(listed, commonDirectory, mainPath, records === undefined);
    const worktrees: RepoWorktreeRow[] = listed.map((entry, index) => ({
      path: entry.path,
      main: index === 0,
      bare: entry.bare,
      tracked: tracked.has(path.resolve(entry.path)) ? 'managed' : 'none',
      live: lives[index] ?? gitFacts(entry, ['this row was not inspected']),
      ...(standing === undefined ? {} : { ferrets: [...(standing.get(index) ?? [])] }),
    }));
    return {
      commonDirectory,
      worktrees,
      total: entries.length,
      truncated: entries.length > listed.length,
    };
  }

  /** Every row's live state, a few at a time, none able to hold the listing past its own timeout or the budget. */
  async #inspect(
    rows: readonly WorktreeListEntry[],
    commonDirectory: string,
    mainPath: string,
    registryUnread: boolean,
  ): Promise<readonly WorktreeLiveState[]> {
    const { clock } = this.evidence;
    const started = clock.nowMs();
    const lives: WorktreeLiveState[] = [];
    const note = registryUnread ? ['the registry could not be read, so which worktrees Ferretry made is unknown'] : [];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < rows.length; index = next++) {
        const entry = rows[index];
        if (entry === undefined) continue;
        lives[index] = await this.#liveOf(entry, commonDirectory, mainPath, started, note);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REPO_INSPECT_PARALLEL, rows.length) }, worker));
    return lives;
  }

  async #liveOf(
    entry: WorktreeListEntry,
    commonDirectory: string,
    mainPath: string,
    started: number,
    note: readonly string[],
  ): Promise<WorktreeLiveState> {
    // A bare repository has no files to read.
    if (entry.bare) return gitFacts(entry, note);
    const { clock } = this.evidence;
    if (clock.nowMs() - started > REPO_LIST_BUDGET_MS) {
      return gitFacts(entry, ['not inspected: the time allowed for this list ran out', ...note]);
    }
    try {
      const inspection = await bounded(
        this.evidence.examine({
          managed: inspectedAs(entry, commonDirectory, mainPath),
          managedRoot: this.evidence.managedRoot,
          ownerActive: false,
        }),
        REPO_ROW_TIMEOUT_MS,
        'inspecting this worktree',
        ms => clock.sleep(ms),
      );
      return overlaid({ ...inspection.live, undetermined: [...inspection.live.undetermined, ...note] }, entry);
    } catch (error) {
      return gitFacts(entry, [`could not be inspected: ${message(error)}`, ...note]);
    }
  }
}
