import { z } from 'zod';
import { WorktreeError } from './errors.ts';
import type { ManagedWorktree, ManagedWorktreeIntent } from './types.ts';

/**
 * The durable record of every checkout this daemon created, and of every one it was part-way through.
 *
 * WHY A REGISTRY EXISTS AT ALL. Git can enumerate worktrees; it cannot say which of them Ferretry
 * made, who asked, when, from which commit, or whether the branch pre-dated the fork. Without those
 * a removal has no safe answer available to it, which is exactly why this whole surface sat
 * unreachable: every route the client already spoke needed a record nothing wrote.
 *
 * WHY IT ALSO RECORDS INTENT. Atomic writes make each SAVE all-or-nothing; they say nothing about a
 * crash BETWEEN a save and the Git mutation it describes, and there are exactly two such windows.
 * Filing a record only after `git worktree add` leaves a checkout on disk that nothing knows about —
 * unlistable, unremovable, and holding a branch. Striking a record only after `git worktree remove`
 * leaves a row pointing at a directory that is gone, and every retry then fails on `missing_worktree`
 * rather than healing. So the intent is written FIRST in both directions — a creation is declared
 * before Git is asked to make it, a removal is stamped before Git is asked to destroy it — and
 * {@link isCreationUnresolved}/{@link isRemovalInterrupted} are how the next read finds the leftovers.
 * Reconciliation then makes the durable state agree with the disk, whichever side crashed.
 *
 * THE DOCUMENT IS VERSIONED AND PARSED, never cast. A registry that cannot be read is DAMAGE and
 * says so; a registry that is absent is a daemon that has made no worktrees yet. Collapsing the two
 * — the shape of bug this repository has now fixed several times — would report a corrupt file as an
 * empty fleet and then happily create a second checkout on a branch the lost record was holding.
 */

const ManagedWorktreeRecordSchema = z.strictObject({
  version: z.literal(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  repositoryRoot: z.string().min(1),
  commonDir: z.string().min(1),
  gitDir: z.string().min(1),
  ownershipToken: z.string().min(1),
  createdAt: z.string().min(1),
  initialHead: z.string().min(1),
  branchPreexisted: z.boolean(),
  sourceCwd: z.string().min(1),
  relativeCwd: z.string(),
  ownerSessionId: z.string().min(1).optional(),
  removalStartedAt: z.string().min(1).optional(),
  removedAt: z.string().min(1).optional(),
});

const ManagedWorktreeIntentSchema = z.strictObject({
  version: z.literal(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  repositoryRoot: z.string().min(1),
  commonDir: z.string().min(1),
  ownershipToken: z.string().min(1),
  declaredAt: z.string().min(1),
  initialHead: z.string().min(1),
  branchPreexisted: z.boolean(),
  sourceCwd: z.string().min(1),
  relativeCwd: z.string(),
  ownerSessionId: z.string().min(1).optional(),
});

export const MANAGED_WORKTREE_DOCUMENT_VERSION = 1 as const;

export const ManagedWorktreeDocumentSchema = z.strictObject({
  version: z.literal(MANAGED_WORKTREE_DOCUMENT_VERSION),
  worktrees: z.array(ManagedWorktreeRecordSchema),
  /** Defaulted so a document written before intents existed still reads as an ordinary registry. */
  intents: z.array(ManagedWorktreeIntentSchema).default([]),
});
export type ManagedWorktreeDocument = z.infer<typeof ManagedWorktreeDocumentSchema>;

/** Everything the registry holds: finished records, and creations Git was asked for. */
export interface ManagedWorktreeRegistryState {
  readonly worktrees: readonly ManagedWorktree[];
  readonly intents: readonly ManagedWorktreeIntent[];
}

/** The state an absent registry is equivalent to. Missing is the initial state, never damage. */
export function emptyManagedWorktreeState(): ManagedWorktreeRegistryState {
  return { worktrees: [], intents: [] };
}

/** The document this state makes, ready to be written. */
export function managedWorktreeDocument(state: ManagedWorktreeRegistryState): ManagedWorktreeDocument {
  return {
    version: MANAGED_WORKTREE_DOCUMENT_VERSION,
    worktrees: [...state.worktrees],
    intents: [...state.intents],
  };
}

/**
 * The state a document holds, or a stated refusal.
 *
 * Parsed at the boundary so nothing downstream has to wonder whether a field survived a hand edit,
 * a partial write, or a build that wrote a shape this one does not know.
 */
export function parseManagedWorktreeRegistry(value: unknown): ManagedWorktreeRegistryState {
  const parsed = ManagedWorktreeDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorktreeError('registry_damaged', 'the managed-worktree registry is damaged and cannot be read');
  }
  return { worktrees: parsed.data.worktrees, intents: parsed.data.intents };
}

/** The state after a creation is DECLARED — written before Git is asked to make anything. */
export function withManagedWorktreeIntent(
  state: ManagedWorktreeRegistryState,
  intent: ManagedWorktreeIntent,
): ManagedWorktreeRegistryState {
  return { ...state, intents: [...state.intents.filter(existing => existing.path !== intent.path), intent] };
}

/** The state after an intent is dropped, because nothing was ever created at its path. */
export function withoutManagedWorktreeIntent(
  state: ManagedWorktreeRegistryState,
  path: string,
): ManagedWorktreeRegistryState {
  return { ...state, intents: state.intents.filter(intent => intent.path !== path) };
}

/**
 * The state after a record is filed, replacing any earlier record — and any intent — of that path.
 *
 * Both halves in one write, because they are one fact: the checkout this daemon declared is now the
 * checkout this daemon has. Two writes would leave a window where the same path is both.
 */
export function withManagedWorktree(
  state: ManagedWorktreeRegistryState,
  entry: ManagedWorktree,
): ManagedWorktreeRegistryState {
  return {
    worktrees: [...state.worktrees.filter(existing => existing.path !== entry.path), entry],
    intents: state.intents.filter(intent => intent.path !== entry.path),
  };
}

/** The state after a removal is stamped — written before Git is asked to destroy anything. */
export function withRemovalStarted(
  state: ManagedWorktreeRegistryState,
  path: string,
  startedAt: string,
): ManagedWorktreeRegistryState {
  return {
    ...state,
    worktrees: state.worktrees.map(entry => (entry.path === path ? { ...entry, removalStartedAt: startedAt } : entry)),
  };
}

/**
 * The state after an attempted removal turned out not to have happened.
 *
 * A refusal takes this path immediately; a crash takes it on the next read, once the checkout has
 * been found still on disk. Either way the row goes back to being an ordinary live record rather
 * than staying stuck mid-removal.
 */
export function withRemovalAbandoned(state: ManagedWorktreeRegistryState, path: string): ManagedWorktreeRegistryState {
  return {
    ...state,
    worktrees: state.worktrees.map(entry => {
      if (entry.path !== path) return entry;
      const { removalStartedAt: _started, ...rest } = entry;
      return rest;
    }),
  };
}

/**
 * The state after a path is marked removed.
 *
 * A TOMBSTONE RATHER THAN A DELETION. The record says a checkout on this branch was made here and
 * later removed. It does not reserve the path forever: a later successful create may deliberately
 * replace the tombstone with a new incarnation, and {@link withManagedWorktree} makes that
 * replacement atomic. A path the registry does not hold is left exactly as it was — nothing here
 * invents a record for it.
 */
export function withRemovedManagedWorktree(
  state: ManagedWorktreeRegistryState,
  path: string,
  removedAt: string,
): ManagedWorktreeRegistryState {
  return {
    ...state,
    worktrees: state.worktrees.map(entry => (entry.path === path ? { ...entry, removedAt } : entry)),
  };
}

/** The record for one path, or nothing. */
export function findManagedWorktree(entries: readonly ManagedWorktree[], path: string): ManagedWorktree | undefined {
  return entries.find(entry => entry.path === path);
}

/** Whether this row was stamped for removal and never confirmed gone — the second crash window. */
export function isRemovalInterrupted(entry: ManagedWorktree): boolean {
  return entry.removalStartedAt !== undefined && entry.removedAt === undefined;
}

/** Whether this state carries anything a reconciliation would have to resolve. */
export function isRegistrySettled(state: ManagedWorktreeRegistryState): boolean {
  return state.intents.length === 0 && !state.worktrees.some(isRemovalInterrupted);
}

/**
 * The durable side of the surface, as the domain sees it.
 *
 * TWO OPERATIONS, and `write` takes a FUNCTION rather than a value on purpose: every change here is
 * a read-modify-write, and handing the store the change lets it apply it under whatever it uses to
 * keep two concurrent requests from interleaving. A `save(state)` port would move that window into
 * every caller, which is where a lost update comes from.
 */
export interface ManagedWorktreeRegistry {
  read(): Promise<ManagedWorktreeRegistryState>;
  write(mutate: (current: ManagedWorktreeRegistryState) => ManagedWorktreeRegistryState): Promise<void>;
}
