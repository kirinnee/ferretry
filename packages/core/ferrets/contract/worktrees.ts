/**
 * Managed worktrees: the wire contract, and the two decisions both ends must agree on.
 *
 * WHY THIS FILE EXISTS AT ALL. The CLI declared these schemas itself, and its own header said that
 * was wrong: a client restating the daemon's domain types is a duplicate, and duplicates drift. The
 * drift was already visible — a blocker `code` the client accepted as any non-empty string, so a
 * daemon renaming one would have been rendered rather than refused. The set is closed here, and both
 * ends read the same closed set.
 *
 * TWO OF THE MEMBERS ARE FUNCTIONS RATHER THAN SHAPES, and that is the point of owning the fact
 * rather than merely the constant. "Which blockers survive the consent this caller gave" is asked by
 * BOTH programs — the client asks it to name the missing flag before anything is sent, the daemon
 * asks it to decide whether to mutate — and a client applying a weaker rule than the daemon would
 * print "safe to remove" over a removal the daemon then refuses, while a client applying a stronger
 * one would refuse a removal the daemon would have allowed. Neither side may own it, so it lives
 * above both.
 */
import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './view/common.ts';
import { WorktreeMoveOfferSchema } from './worktree-move.ts';

const Text = z.string().min(1);

/** What `git status` says about a checkout's content, as independent facts rather than one flag. */
const WorktreeStatusSummarySchema = z.object({
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  ignored: z.boolean(),
  conflicted: z.boolean(),
  dirtySubmodule: z.boolean(),
  /** Git's answer did not fit the read budget, so the four above are incomplete evidence. */
  truncated: z.boolean(),
});
export type WorktreeStatusSummaryView = z.infer<typeof WorktreeStatusSummarySchema>;

/**
 * The classes of loss a caller can consent to, one per class.
 *
 * THERE IS DELIBERATELY NO BLANKET FORCE. A single flag that cleared every blocker would clear ones
 * the caller never saw — "another session is working here" among them — so each override names
 * exactly one thing that will be destroyed.
 */
const WorktreeRemovalOverrideSchema = z.enum(['discard_worktree_changes', 'accept_unpushed_commits']);
export type WorktreeRemovalOverride = z.infer<typeof WorktreeRemovalOverrideSchema>;

/** Every reason a removal can be refused. Closed, so a renamed code fails loudly at the client. */
const WorktreeRemovalBlockerCodeSchema = z.enum([
  'active_session',
  'current_checkout',
  'main_checkout',
  'outside_managed_root',
  'missing_worktree',
  'path_identity_mismatch',
  'repository_mismatch',
  'branch_mismatch',
  'ownership_mismatch',
  'locked_worktree',
  'shared_checkout',
  'live_terminal',
  'staged_changes',
  'unstaged_changes',
  'untracked_content',
  'ignored_content',
  'conflicted_worktree',
  'dirty_submodule',
  'unpushed_commits',
  'git_error',
  /**
   * Host evidence this daemon could not establish at all.
   *
   * NOT THE SAME AS "there is nothing there". A session list or a terminal listing that could not be
   * read means a shell or an agent inside the checkout cannot be RULED OUT, and a surface that
   * silently counted zero would turn its own un-forceable safety refusals into decoration. Nothing
   * overrides it: the answer is to make the evidence readable, not to accept losing whatever it
   * would have protected.
   */
  'undetermined_evidence',
]);
export type WorktreeRemovalBlockerCode = z.infer<typeof WorktreeRemovalBlockerCodeSchema>;

const WorktreeRemovalBlockerSchema = z.object({
  code: WorktreeRemovalBlockerCodeSchema,
  message: Text,
  /** The override that clears this blocker. ABSENT MEANS NOTHING CLEARS IT. */
  override: WorktreeRemovalOverrideSchema.optional(),
});
export type WorktreeRemovalBlocker = z.infer<typeof WorktreeRemovalBlockerSchema>;

/** The confirmations that authorize deleting a branch, one per reason deletion would lose work. */
const BranchDeletionConfirmationSchema = z.enum([
  'delete_preexisting_branch',
  'delete_unpushed_branch',
  'delete_unmerged_branch',
]);
export type BranchDeletionConfirmation = z.infer<typeof BranchDeletionConfirmationSchema>;

const BranchDeletionBlockerCodeSchema = z.enum([
  'protected_branch',
  'branch_checked_out',
  'active_checkout',
  'live_terminal',
  'preexisting_branch',
  'unpushed_commits',
  'unmerged_branch',
  /** The checkout was removed, but Git refused or failed while deleting its branch. */
  'git_error',
]);

const BranchDeletionBlockerSchema = z.object({
  code: BranchDeletionBlockerCodeSchema,
  message: Text,
  /** The confirmation that clears it. ABSENT MEANS NOTHING DOES. */
  confirmation: BranchDeletionConfirmationSchema.optional(),
});
export type BranchDeletionBlocker = z.infer<typeof BranchDeletionBlockerSchema>;

const BranchDeletionDecisionSchema = z.object({
  deletable: z.boolean(),
  blockers: z.array(BranchDeletionBlockerSchema),
});
export type BranchDeletionDecision = z.infer<typeof BranchDeletionDecisionSchema>;

/** The exact registry row, attached ref, directory incarnation and commit a person reviewed. */
export const ReviewedWorktreeIdentitySchema = z.strictObject({
  recordId: Text,
  branchRef: Text.refine(value => value.startsWith('refs/heads/')),
  checkout: z.string().regex(/^\d+:\d+$/u),
  head: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u),
});
export type ReviewedWorktreeIdentity = z.infer<typeof ReviewedWorktreeIdentitySchema>;

export const GuardedWorktreeRemovalRequestSchema = z.strictObject({
  path: Text,
  expectedHead: ReviewedWorktreeIdentitySchema.shape.head,
  expectedIdentity: ReviewedWorktreeIdentitySchema,
  currentWorkingDirectory: Text.optional(),
});
export type GuardedWorktreeRemovalRequest = z.infer<typeof GuardedWorktreeRemovalRequestSchema>;

export const WorktreeRemovalDecisionSchema = z.object({
  removable: z.boolean(),
  reviewedIdentity: ReviewedWorktreeIdentitySchema.optional(),
  path: Text,
  branch: Text,
  head: Text.optional(),
  upstream: Text.optional(),
  blockers: z.array(WorktreeRemovalBlockerSchema),
  /**
   * What deleting the branch too would cost, decided from the same evidence.
   *
   * ABSENT MEANS UNDETERMINED — the checkout could not be inspected far enough to say — and an
   * absent answer is never read as permission: the daemon refuses a branch deletion it could not
   * assess. It travels on the CHECK so a caller learns the price before authorizing anything, which
   * is the whole ordering this surface is built around.
   */
  branchDeletion: BranchDeletionDecisionSchema.optional(),
});
export type WorktreeRemovalDecision = z.infer<typeof WorktreeRemovalDecisionSchema>;

/**
 * What Git says about a checkout RIGHT NOW, read on every refresh rather than replayed from a record.
 *
 * EVERY FIELD IS OPTIONAL FOR ONE REASON: it could not be determined. A list that reported `ahead: 0`
 * for a branch whose upstream Git could not resolve would be inventing agreement, so the number is
 * absent and `undetermined` says why in words a human can act on.
 */
const WorktreeLiveStateSchema = z.object({
  /** The commit the checkout is on now — NOT the commit it was created at. */
  head: Text.optional(),
  /** The branch the checkout is on now. Absent when detached or unreadable. */
  branch: Text.optional(),
  detached: z.boolean(),
  status: WorktreeStatusSummarySchema.optional(),
  upstream: Text.optional(),
  ahead: NonNegativeIntegerSchema.optional(),
  behind: NonNegativeIntegerSchema.optional(),
  /** Git's lock reason. Present means locked; the empty string is a lock with no reason given. */
  locked: z.string().optional(),
  /** Git's prune reason. Present means Git considers the checkout prunable. */
  prunable: z.string().optional(),
  /** Whether the branch is contained in its integration target. Absent means the target was unknown. */
  integrated: z.boolean().optional(),
  /** Each fact this refresh could not establish, said plainly instead of defaulted. */
  undetermined: z.array(Text),
});
export type WorktreeLiveState = z.infer<typeof WorktreeLiveStateSchema>;

/** One worktree the daemon created and still owns. */
const ManagedWorktreeViewSchema = z.object({
  origin: z.enum(['managed', 'adopted']).optional(),
  path: Text,
  branch: Text,
  repositoryRoot: Text,
  /**
   * The repository's common directory: the identity two checkouts of one repository share.
   *
   * This is what joins a worktree to its Project, and it is a fact rather than a coincidence — a
   * path prefix says only that two directories are near each other on disk.
   */
  commonDirectory: Text,
  /** Where inside the source checkout the fork was taken from; the empty string is its root. */
  relativeCwd: z.string(),
  createdAt: InstantSchema,
  /** The commit the checkout was created at. Compare with `live.head` to see movement. */
  initialHead: Text,
  branchPreexisted: z.boolean(),
  removedAt: InstantSchema.optional(),
  /** The session that asked for it, absent once that session has ended or when nothing owns it. */
  ownerSessionId: Text.optional(),
  ownerActive: z.boolean(),
  /** Sessions other than the owner currently working in it. */
  sharedWith: z.array(Text).default([]),
  /** The Project this checkout belongs to, when one is registered for its common directory. */
  projectId: Text.optional(),
  /**
   * Why this row is not a finished checkout, when it is not one.
   *
   * A creation the daemon declared, was interrupted part-way through, and cannot now prove it made:
   * something is at that path and it does not verify as ours. The row is kept and SAID rather than
   * dropped, because dropping it is what turns a leftover directory into one nothing can see.
   */
  unresolved: Text.optional(),
  /** Live Git evidence. Absent for a removed checkout — there is nothing left to inspect. */
  live: WorktreeLiveStateSchema.optional(),
  /** Whether it is safe to delete, and what stands in the way. Absent for a removed checkout. */
  removal: WorktreeRemovalDecisionSchema.optional(),
});
export type ManagedWorktreeView = z.infer<typeof ManagedWorktreeViewSchema>;

export const WorktreeListResponseSchema = z.object({
  worktrees: z.array(ManagedWorktreeViewSchema),
  /** Where managed worktrees live; absent when the daemon has no managed root configured. */
  managedRoot: Text.optional(),
});
export type WorktreeListResponse = z.infer<typeof WorktreeListResponseSchema>;

export const RemovedWorktreeSchema = z.object({
  path: Text,
  branch: Text,
  branchRetained: z.boolean(),
  removedAt: InstantSchema,
  /**
   * Why the branch outlived the checkout, when deletion was asked for and refused.
   *
   * A removal that silently kept a branch the caller asked to delete is the shape of bug that made
   * `--delete-branch` a dead flag for the whole of this surface's first life.
   */
  branchBlockers: z.array(BranchDeletionBlockerSchema).default([]),
});
export type RemovedWorktree = z.infer<typeof RemovedWorktreeSchema>;

export const WorktreeRemovalRequestSchema = z.strictObject({
  path: Text,
  expectedIdentity: ReviewedWorktreeIdentitySchema.optional(),
  /** Refuse if the checkout moved since the caller proved this commit safe (Tidy's merged PR head). */
  expectedHead: z
    .string()
    .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u)
    .optional(),
  overrides: z.array(WorktreeRemovalOverrideSchema),
  deleteBranch: z.boolean(),
  confirmations: z.array(BranchDeletionConfirmationSchema),
  /**
   * Where the caller is standing, so removing the checkout they are inside is refused.
   *
   * CALLER-DECLARED, and safe to be: it can only ever ADD a refusal. A caller that omits it or lies
   * about it is saying "I am not in there", and the worst it can do with that claim is destroy its
   * own working directory — which is precisely the loss the field exists to prevent, never a
   * protection over somebody else.
   */
  currentWorkingDirectory: Text.optional(),
});
export type WorktreeRemovalRequest = z.infer<typeof WorktreeRemovalRequestSchema>;

/**
 * Where a new checkout starts from.
 *
 * `auto` is what a caller means when they name only a branch: an existing local branch is checked
 * out where it is, a branch that exists on exactly one remote is tracked, and anything else forks
 * the source checkout's current commit. The other three are explicit answers, and `default-branch`
 * is resolved from LOCAL Git data only — there is no fetch here, so a repository with no
 * `origin/HEAD` is told so rather than guessed at.
 */
const WorktreeBaseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('auto') }),
  z.strictObject({ kind: z.literal('head') }),
  z.strictObject({ kind: z.literal('default-branch') }),
  z.strictObject({ kind: z.literal('commit'), reference: Text }),
]);
export type WorktreeBase = z.infer<typeof WorktreeBaseSchema>;

/**
 * Whether a path is absolute in either platform spelling the wire may carry.
 *
 * This decision cannot use the daemon's ambient platform: a CLI and daemon build still have to
 * agree before either resolves anything. POSIX roots, drive-qualified Windows paths and UNC shares
 * are absolute; drive-relative `C:repo` and ordinary relative names are not.
 */
function isProtocolAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value);
}

const AbsoluteWorktreeSourcePath = Text.refine(isProtocolAbsolutePath, {
  message: 'a worktree source path must be absolute',
});

/** The longest group folder name a caller may ask for. */
export const WORKTREE_GROUP_MAX_LENGTH = 64;

/**
 * Whether a caller-chosen group folder is one safe path segment under the managed root.
 *
 * THE ONE DECISION BOTH PROGRAMS MAKE: the request schema refuses it at the wire and the daemon refuses it again before
 * it joins a path. A group is OPAQUE to Ferrets — a letter or digit first, then letters, digits, `.`, `_` or `-` —
 * so `..`, a separator, an absolute path, an empty name, a control character and an overlong name all fail one rule.
 */
export function isPathSafeWorktreeGroup(value: string): boolean {
  return value.length <= WORKTREE_GROUP_MAX_LENGTH && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

export const CreateWorktreeRequestSchema = z.strictObject({
  /** An absolute directory inside the Git checkout to fork from. Its relative depth is preserved. */
  sourcePath: AbsoluteWorktreeSourcePath,
  branch: Text,
  base: WorktreeBaseSchema.default({ kind: 'auto' }),
  /** The session that will own it. Absent means the checkout is owned by nothing but the daemon. */
  sessionId: Text.optional(),
  /** An opaque folder the caller files the checkout under: `<root>/<group>/<repo>-<hash>/<branch>-<hash>`. Absent: today's `<root>/<repo>-<hash>/…`. */
  group: Text.refine(isPathSafeWorktreeGroup, { message: 'a worktree group must be one safe folder name' }).optional(),
});
export type CreateWorktreeRequest = z.infer<typeof CreateWorktreeRequestSchema>;

export const CreatedWorktreeSchema = z.object({
  worktree: ManagedWorktreeViewSchema,
  /**
   * The directory to start work in: the new checkout plus the source's relative subdirectory.
   *
   * Forking from `repo/packages/cli` lands in `<new>/packages/cli`, not at the root — the caller's
   * position in the tree is part of what they asked for.
   */
  cwd: Text,
});
export type CreatedWorktree = z.infer<typeof CreatedWorktreeSchema>;

export const AdoptWorktreeRequestSchema = z.strictObject({ path: Text });
export type AdoptWorktreeRequest = z.infer<typeof AdoptWorktreeRequestSchema>;

/**
 * Which blockers survive the consent a caller gave.
 *
 * THE ONE DECISION BOTH PROGRAMS MAKE. A blocker with no `override` is never cleared by anything,
 * which is what makes "the current checkout", "another session is here" and "a live terminal is
 * rooted in it" structurally un-forceable rather than merely undocumented.
 */
export function unclearedRemovalBlockers(
  blockers: readonly WorktreeRemovalBlocker[],
  granted: readonly WorktreeRemovalOverride[],
): readonly WorktreeRemovalBlocker[] {
  const consented = new Set(granted);
  return blockers.filter(blocker => blocker.override === undefined || !consented.has(blocker.override));
}

/** The most rows one repository listing carries; a repository with more says so with `truncated`. */
export const REPO_WORKTREE_LIMIT = 500;

/**
 * Whether a caller-supplied repository common directory is worth asking Git about.
 *
 * THE FIRST HALF OF THE ONE DECISION BOTH PROGRAMS MAKE (the daemon's Git check is the second): an absolute path with no
 * control character and a sane length. A relative name, an empty one or a path carrying a NUL never reaches a child process.
 */
export function isListableCommonDirectory(value: string): boolean {
  return (
    value.length <= 4096 &&
    isProtocolAbsolutePath(value) &&
    ![...value].some(character => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

/**
 * Whether Ferretry holds a worktree of a repository on record.
 *
 * `managed`: Ferretry made it. `adopted`: it was made by hand and Ferretry took it over in place (never moved).
 * `none`: Git lists it and Ferretry has no record of it.
 */
const RepoWorktreeTrackedSchema = z.enum(['managed', 'adopted', 'none']);
export type RepoWorktreeTracked = z.infer<typeof RepoWorktreeTrackedSchema>;

/** A ferret standing in a worktree. `active` false is a finished one: it does not hold the checkout. */
const RepoWorktreeFerretSchema = z.object({ id: Text, active: z.boolean() });

/** One row of `git worktree list`, with what Git says about it right now and who stands in it. */
const RepoWorktreeSchema = z.object({
  move: WorktreeMoveOfferSchema.optional(),
  path: Text,
  /** The repository's main checkout (Git lists it first). It is never removable. */
  main: z.boolean(),
  /** A bare repository has no checkout to inspect: `live` says nothing about files. */
  bare: z.boolean(),
  tracked: RepoWorktreeTrackedSchema,
  /**
   * Live Git state, read for this listing. A row that could not be inspected still has one: Git's own facts for the row
   * and `undetermined` saying why the rest is missing, never a guessed default.
   */
  live: WorktreeLiveStateSchema,
  /** The ferrets standing in it. ABSENT MEANS UNDETERMINED (the fleet could not be read), not "nobody". */
  ferrets: z.array(RepoWorktreeFerretSchema).optional(),
});
export type RepoWorktreeRow = z.infer<typeof RepoWorktreeSchema>;

export const RepoWorktreeListResponseSchema = z.object({
  /** The common directory asked about, as given. */
  commonDirectory: Text,
  worktrees: z.array(RepoWorktreeSchema),
  /** How many worktrees Git lists, which can exceed `worktrees.length` by the limit. */
  total: NonNegativeIntegerSchema,
  /** `total` is above {@link REPO_WORKTREE_LIMIT}: the rows after it are not listed. */
  truncated: z.boolean(),
});
export type RepoWorktreeListResponse = z.infer<typeof RepoWorktreeListResponseSchema>;
