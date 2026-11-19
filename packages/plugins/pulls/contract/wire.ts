/**
 * The wire shapes of pull requests and CI (plugin `pulls`). Every E unit reads this file; only E1 edits it, and a later
 * unit that needs a field asks in its PR (`## Contract change`).
 *
 * NOTHING HERE CAN CARRY A TOKEN. Every object is strict and `NO_SECRET_FIELDS` names the words no field may use (the
 * contract test reads every schema against it). The account's token never leaves the `git-accounts` daemon half: this
 * plugin names an account by id and asks that half to make the call.
 *
 * Text that strangers wrote (a title, a body, a comment, a branch name) is DATA: bounded here, rendered inert by the
 * app (E4). A GitHub `body_html` field has no place in any shape.
 */
import { z } from 'zod';

/** A closed union, the same one `git-accounts` uses, so GitLab is one more member. */
export const PULL_PROVIDERS = ['github'] as const;
export const PullProviderSchema = z.enum(PULL_PROVIDERS);
export type PullProvider = z.infer<typeof PullProviderSchema>;

const Instant = z.iso.datetime();
const Url = z.url().max(500);
/** GitHub's own cap on a comment or a description. */
export const MAX_TEXT = 65_536;

// ─── who and where ────────────────────────────────────────────────────────────────────────────────────────────────

export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}|[A-Za-z0-9-]{0,37}\[bot\])$/u;
export const GITHUB_REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/u;

export const RepoRefSchema = z.strictObject({
  provider: PullProviderSchema,
  owner: z.string().regex(GITHUB_LOGIN),
  name: z.string().regex(GITHUB_REPO_NAME),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const PullAuthorSchema = z.strictObject({
  login: z.string().min(1).max(100),
  avatarUrl: Url.optional(),
});
export type PullAuthor = z.infer<typeof PullAuthorSchema>;

// ─── a pull request ───────────────────────────────────────────────────────────────────────────────────────────────

export const PULL_STATES = ['open', 'closed', 'merged'] as const;
export const REVIEW_STATES = ['none', 'review_required', 'approved', 'changes_requested'] as const;
/** CI as a PR list shows it: one word per PR, from its head commit's runs. */
export const CI_STATES = ['none', 'queued', 'running', 'passing', 'failing', 'cancelled'] as const;
export type CiState = (typeof CI_STATES)[number];

export const PullSummarySchema = z.strictObject({
  repo: RepoRefSchema,
  number: z.number().int().positive(),
  title: z.string().max(1024),
  author: PullAuthorSchema,
  state: z.enum(PULL_STATES),
  draft: z.boolean(),
  review: z.enum(REVIEW_STATES),
  ci: z.enum(CI_STATES),
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/u),
  headRef: z.string().max(255),
  baseRef: z.string().max(255),
  createdAt: Instant,
  updatedAt: Instant,
  url: Url,
});
export type PullSummary = z.infer<typeof PullSummarySchema>;

export const PullDetailSchema = PullSummarySchema.extend({
  /** The description as the author wrote it. Never GitHub's rendered HTML. */
  body: z.string().max(MAX_TEXT),
  requestedReviewers: z.array(z.string().min(1).max(100)).max(100),
  commits: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  mergedAt: Instant.optional(),
  closedAt: Instant.optional(),
});
export type PullDetail = z.infer<typeof PullDetailSchema>;

// ─── files and diff ───────────────────────────────────────────────────────────────────────────────────────────────

export const FILE_STATUSES = ['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'] as const;
/** GitHub pages files 100 at a time and lists at most 3000 of them. */
export const MAX_PULL_FILES = 3000;

export const PullFileSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  previousPath: z.string().min(1).max(4096).optional(),
  status: z.enum(FILE_STATUSES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** The unified diff hunks. GitHub sends none for a binary or very large file: the app says "open on GitHub". */
  patch: z
    .string()
    .max(1024 * 1024)
    .optional(),
  /** Where the file is on GitHub. */
  url: Url.optional(),
});
export type PullFile = z.infer<typeof PullFileSchema>;

// ─── conversation: comments, reviews, threads ─────────────────────────────────────────────────────────────────────

/** One comment on a PR: in the main conversation, in a review, or in a thread on a diff line. */
export const PullCommentSchema = z.strictObject({
  id: z.string().min(1).max(100),
  author: PullAuthorSchema,
  body: z.string().max(MAX_TEXT),
  createdAt: Instant,
  url: Url,
});
export type PullComment = z.infer<typeof PullCommentSchema>;

export const REVIEW_VERDICTS = ['approved', 'changes_requested', 'commented', 'dismissed', 'pending'] as const;
export const PullReviewSchema = z.strictObject({
  id: z.string().min(1).max(100),
  author: PullAuthorSchema,
  verdict: z.enum(REVIEW_VERDICTS),
  body: z.string().max(MAX_TEXT),
  submittedAt: Instant.optional(),
  url: Url,
});
export type PullReview = z.infer<typeof PullReviewSchema>;

export const DIFF_SIDES = ['left', 'right'] as const;
export const ReviewThreadSchema = z.strictObject({
  /** GitHub's GraphQL node id: a reply names it. */
  id: z.string().min(1).max(100),
  resolved: z.boolean(),
  /** The line it was made on no longer exists in the current diff: listed, not placed. */
  outdated: z.boolean(),
  path: z.string().min(1).max(4096),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  side: z.enum(DIFF_SIDES),
  comments: z.array(PullCommentSchema).min(1).max(250),
});
export type ReviewThread = z.infer<typeof ReviewThreadSchema>;

// ─── CI: runs, jobs, steps and timing ─────────────────────────────────────────────────────────────────────────────

/** One word for a run, a job or a step; GitHub's status + conclusion pair folded. */
export const CI_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled', 'skipped'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

/**
 * A step. A skipped step has no `start` or `end` (no bar). `live` is a step still running (its end is "now" on screen);
 * `clamped` is a step that fell outside its job (clock skew) and was pulled inside.
 */
export const CiStepSchema = z.strictObject({
  name: z.string().max(500),
  number: z.number().int().nonnegative(),
  status: z.enum(CI_STATUSES),
  start: Instant.optional(),
  end: Instant.optional(),
  live: z.boolean().optional(),
  clamped: z.boolean().optional(),
});
export type CiStep = z.infer<typeof CiStepSchema>;

export const CiJobSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  name: z.string().max(500),
  status: z.enum(CI_STATUSES),
  /** From the run's creation to this job's start. */
  queuedMs: z.number().int().nonnegative(),
  start: Instant.optional(),
  end: Instant.optional(),
  live: z.boolean().optional(),
  steps: z.array(CiStepSchema).max(1000),
  /** Where the logs are. Logs are never read into Ferretry (declared). */
  url: Url.optional(),
});
export type CiJob = z.infer<typeof CiJobSchema>;

export const CiRunSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  /** The workflow's name, or the check's name for a CI that is not GitHub Actions. */
  name: z.string().max(500),
  status: z.enum(CI_STATUSES),
  /** What started it: `push`, `pull_request`, `schedule` … */
  trigger: z.string().max(100),
  /** 1 for the first run; a re-run adds one. */
  attempt: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/u),
  createdAt: Instant,
  start: Instant.optional(),
  end: Instant.optional(),
  /** Time from creation to the first job start (or to now while nothing has started). */
  queuedMs: z.number().int().nonnegative(),
  /** Creation to end (or to now while running). */
  wallMs: z.number().int().nonnegative(),
  live: z.boolean().optional(),
  /** Empty for a CI that is not GitHub Actions: it is shown as one bar. */
  jobs: z.array(CiJobSchema).max(256),
  url: Url.optional(),
});
export type CiRun = z.infer<typeof CiRunSchema>;

// ─── the rate budget ──────────────────────────────────────────────────────────────────────────────────────────────

/** GitHub keeps one bucket for REST and one for GraphQL. */
export const RATE_RESOURCES = ['rest', 'graphql'] as const;
export type RateResource = (typeof RATE_RESOURCES)[number];

/** Polling pauses below this share of the hourly allowance, until the allowance resets. */
export const BUDGET_PAUSE_FRACTION = 0.1;

export const RateBudgetSchema = z.strictObject({
  /** A `git-accounts` id (`gha_…`): a plain id here, as Projects keeps it, so no contract imports another's. */
  account: z.string().regex(/^gha_[0-9]{1,20}$/u),
  resource: z.enum(RATE_RESOURCES),
  remaining: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  resetsAt: Instant,
  /** Set while polling is paused to stay inside the limit. */
  pausedUntil: Instant.optional(),
});
export type RateBudgetView = z.infer<typeof RateBudgetSchema>;

/** The one sentence every screen says while polling is paused. `time` is already in the device's local time. */
export const budgetSentence = (time: string): string => `Paused until ${time} to stay inside GitHub's limit`;

/** The words no field of any wire shape here may be named by. A test reads every schema against it. */
export const NO_SECRET_FIELDS = /token|secret|password|private|bearer|digest|credential|body_html|bodyHtml/iu;
