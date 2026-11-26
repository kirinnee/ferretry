/**
 * `branchPulls` (G3 U5): the latest pull request of each head branch, in ANY state, for a project's repository. The
 * worktree cleanup (Tidy) asks it to learn whether a branch's PR was merged, and with which head commit.
 *
 * AN ANSWER IS ONE OF THREE THINGS PER BRANCH. `pull`: GitHub named the newest PR of that branch. `none`: GitHub answered
 * and listed no PR for it. `unknown`: no usable answer came (paused to stay inside the rate limit, GitHub or the account
 * refused, the read failed, the name is not usable, the call asked for too many). A miss is `unknown`, NEVER `none`.
 * `none` says nothing about a branch pushed from a fork (GitHub lists a PR by the owner of its head repository).
 *
 * Nothing here can carry a token or a stranger's text: no title, no author, no body; a PR is numbers, a state, two times,
 * a commit id, one CI word and an address.
 */
import { definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { PULLS_CODES, type PullsCode } from './policy.ts';
import { CI_STATES, PULL_STATES, RepoRefSchema } from './wire.ts';

/** The most branches one call answers (each costs up to three reads, and a read of an unchanged answer costs none). */
export const MAX_BRANCH_PULLS = 25;
/** GitHub's own bound on a ref name. */
export const MAX_BRANCH_NAME = 255;

/** A branch name a call may carry: what the route accepts and the client puts in a query. */
export const isUsableBranch = (name: string): boolean =>
  name.length > 0 && name.length <= MAX_BRANCH_NAME && !/[\p{Cc}\s]/u.test(name);

const Instant = z.iso.datetime();

export const BranchPullSchema = z.strictObject({
  number: z.number().int().positive(),
  /** `merged` is GitHub's `closed` with a `merged_at`. */
  state: z.enum(PULL_STATES),
  createdAt: Instant,
  /** Set when the PR was merged. */
  mergedAt: Instant.optional(),
  /** The PR's head commit: for a merged PR, the head that was merged. */
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/u),
  /** Absent when this PR's CI could not be read: the PR itself is still answered. */
  ci: z.enum(CI_STATES).optional(),
  url: z.url().max(500),
});
export type BranchPull = z.infer<typeof BranchPullSchema>;

const CODES = Object.values(PULLS_CODES) as [PullsCode, ...PullsCode[]];

export const BranchPullResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ branch: z.string().max(MAX_BRANCH_NAME), outcome: z.literal('pull'), pull: BranchPullSchema }),
  z.strictObject({ branch: z.string().max(MAX_BRANCH_NAME), outcome: z.literal('none') }),
  z.strictObject({ branch: z.string().max(MAX_BRANCH_NAME), outcome: z.literal('unknown'), code: z.enum(CODES) }),
]);
export type BranchPullResult = z.infer<typeof BranchPullResultSchema>;

/** `GET /v1/pulls/:project/:repo/branches?branch=<name>…`: one result per distinct branch asked, in the order asked. */
export const BranchPullsAnswerSchema = z.strictObject({
  repo: RepoRefSchema,
  branches: z.array(BranchPullResultSchema).max(MAX_BRANCH_PULLS),
  fetchedAt: Instant,
});
export type BranchPullsAnswer = z.infer<typeof BranchPullsAnswerSchema>;

export interface PullsApi {
  /**
   * The latest PR of each branch (see the file's head). Never throws: a project, repository or account it cannot resolve
   * answers every branch `unknown`. Asks for at most {@link MAX_BRANCH_PULLS} branches; the rest are `unknown`.
   */
  branchPulls(
    project: string,
    repo: { readonly owner: string; readonly name: string },
    branches: readonly string[],
  ): Promise<readonly BranchPullResult[]>;
}
export const PullsPort = definePort<PullsApi>('pulls');
