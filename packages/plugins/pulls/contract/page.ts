/**
 * What the PR page reads (`GET /v1/pulls/:project/:repo/:number`, r9 E4): the pull request, its conversation and a
 * summary of its checks. Added by E4 beside E1's shapes (a Contract change in E4's PR); every object is strict and
 * carries no token. Text strangers wrote (a body, a comment, a title) is DATA: the app draws it inert.
 */
import { z } from 'zod';
import { CI_STATES, CI_STATUSES, PullCommentSchema, PullDetailSchema, PullReviewSchema } from './wire.ts';

const Instant = z.iso.datetime();
const Url = z.url().max(500);

/** The most comments and reviews one page carries (five pages of 100 each); past it `truncated` says so. */
export const MAX_PAGE_ENTRIES = 500;
/** The most checks listed (one GitHub page); the counts above them cover the same page. */
export const MAX_PAGE_CHECKS = 100;

/** One check on the PR's head commit, in the words every CI shape uses. */
export const PullCheckSchema = z.strictObject({
  name: z.string().max(500),
  status: z.enum(CI_STATUSES),
  url: Url.optional(),
});
export type PullCheck = z.infer<typeof PullCheckSchema>;

/** The head commit's checks in one line, plus the checks themselves. E9 draws the full run page; this is the summary. */
export const PullChecksSchema = z.strictObject({
  state: z.enum(CI_STATES),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  items: z.array(PullCheckSchema).max(MAX_PAGE_CHECKS),
});
export type PullChecks = z.infer<typeof PullChecksSchema>;

export const PullPageSchema = z.strictObject({
  kind: z.literal('page'),
  pull: PullDetailSchema,
  /** Issue comments (the main conversation), oldest first. */
  comments: z.array(PullCommentSchema).max(MAX_PAGE_ENTRIES),
  /** Reviews (verdict + the text sent with it), oldest first. */
  reviews: z.array(PullReviewSchema).max(MAX_PAGE_ENTRIES),
  checks: PullChecksSchema,
  /** More comments or reviews exist than this page carries. */
  truncated: z.boolean(),
  /** Every GitHub answer behind this page was the cached one (all `304`). */
  fromCache: z.boolean(),
});
export type PullPage = z.infer<typeof PullPageSchema>;

/** Polling is paused to stay inside GitHub's limit: nothing is read until `until` (the screen says why). */
export const PullPausedSchema = z.strictObject({ kind: z.literal('paused'), until: Instant });
export type PullPaused = z.infer<typeof PullPausedSchema>;

export const PullPageAnswerSchema = z.discriminatedUnion('kind', [PullPageSchema, PullPausedSchema]);
export type PullPageAnswer = z.infer<typeof PullPageAnswerSchema>;
