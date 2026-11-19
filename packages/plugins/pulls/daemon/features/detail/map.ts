/**
 * GitHub's answers, folded into the wire shapes (pure). GitHub's JSON is read by LOOSE schemas that name only the fields
 * used, so anything else it sends (a `body_html`, avatar addresses, `_links`) is never copied out. Text strangers wrote is
 * bounded and kept as DATA; an address is only kept when it is on github.com.
 *
 * An avatar address is dropped on purpose: drawing it would be a remote image load made by the app for a stranger's
 * benefit. The screen shows initials.
 */
import { z } from 'zod';
import {
  MAX_PAGE_CHECKS,
  MAX_TEXT,
  type CiState,
  type CiStatus,
  type PullCheck,
  type PullChecks,
  type PullComment,
  type PullDetail,
  type PullReview,
  type RepoRef,
  type REVIEW_VERDICTS,
} from '../../../contract/index.ts';

const Instant = z.iso.datetime();
const User = z
  .looseObject({ login: z.string().min(1) })
  .nullish()
  .transform(user => user?.login ?? 'ghost');
const Text = z
  .string()
  .nullish()
  .transform(text => (text ?? '').slice(0, MAX_TEXT));

const RawPull = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  user: User,
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged_at: Instant.nullish(),
  closed_at: Instant.nullish(),
  created_at: Instant,
  updated_at: Instant,
  body: Text,
  head: z.looseObject({ sha: z.string().regex(/^[0-9a-f]{7,64}$/u), ref: z.string() }),
  base: z.looseObject({ ref: z.string() }),
  requested_reviewers: z.array(z.looseObject({ login: z.string().min(1) })).default([]),
  commits: z.number().int().nonnegative().default(0),
  changed_files: z.number().int().nonnegative().default(0),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
});

const RawComment = z.looseObject({
  id: z.union([z.number(), z.string()]),
  user: User,
  body: Text,
  created_at: Instant,
  html_url: z.string().optional(),
});

const RawReview = z.looseObject({
  id: z.union([z.number(), z.string()]),
  user: User,
  body: Text,
  state: z.string(),
  submitted_at: Instant.nullish(),
  html_url: z.string().optional(),
});

const RawCheckRun = z.looseObject({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullish(),
  html_url: z.string().optional(),
});
const RawChecks = z.looseObject({ check_runs: z.array(z.unknown()).default([]) });

/** An address on github.com over https, else undefined (a stranger's text never names where the app links). */
export const githubUrl = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length > 500 || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'github.com' && url.username === '' && url.password === ''
    ? url.href
    : undefined;
};

export const pullUrl = (repo: Pick<RepoRef, 'owner' | 'name'>, number: number): string =>
  `https://github.com/${repo.owner}/${repo.name}/pull/${String(number)}`;

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** The PR itself. `review` and `ci` are filled by the caller from the reviews and checks it also read. */
export function mapPull(
  raw: unknown,
  repo: RepoRef,
  derived: Pick<PullDetail, 'review' | 'ci'>,
): PullDetail | undefined {
  const parsed = RawPull.safeParse(raw);
  if (!parsed.success) return undefined;
  const pull = parsed.data;
  const merged = pull.merged_at !== null && pull.merged_at !== undefined;
  return {
    repo,
    number: pull.number,
    title: clip(pull.title, 1024),
    author: { login: clip(pull.user, 100) },
    state: merged ? 'merged' : pull.state,
    draft: pull.draft === true,
    review: derived.review,
    ci: derived.ci,
    headSha: pull.head.sha,
    headRef: clip(pull.head.ref, 255),
    baseRef: clip(pull.base.ref, 255),
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    url: pullUrl(repo, pull.number),
    body: pull.body,
    requestedReviewers: pull.requested_reviewers.slice(0, 100).map(user => clip(user.login, 100)),
    commits: pull.commits,
    changedFiles: pull.changed_files,
    additions: pull.additions,
    deletions: pull.deletions,
    ...(merged && pull.merged_at ? { mergedAt: pull.merged_at } : {}),
    ...(pull.closed_at ? { closedAt: pull.closed_at } : {}),
  };
}

/** Issue comments, oldest first; one that does not parse is left out (never half-shown). */
export function mapComments(items: readonly unknown[], fallbackUrl: string): PullComment[] {
  const out: PullComment[] = [];
  for (const item of items) {
    const parsed = RawComment.safeParse(item);
    if (!parsed.success) continue;
    const comment = parsed.data;
    out.push({
      id: String(comment.id).slice(0, 100),
      author: { login: clip(comment.user, 100) },
      body: comment.body,
      createdAt: comment.created_at,
      url: githubUrl(comment.html_url) ?? fallbackUrl,
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const VERDICT: Readonly<Record<string, (typeof REVIEW_VERDICTS)[number]>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};

/** Reviews, oldest first. A pending review is somebody's unsent draft: it is not shown to anyone else. */
export function mapReviews(items: readonly unknown[], fallbackUrl: string): PullReview[] {
  const out: PullReview[] = [];
  for (const item of items) {
    const parsed = RawReview.safeParse(item);
    if (!parsed.success) continue;
    const review = parsed.data;
    const verdict = VERDICT[review.state.toUpperCase()];
    if (verdict === undefined || verdict === 'pending') continue;
    out.push({
      id: String(review.id).slice(0, 100),
      author: { login: clip(review.user, 100) },
      verdict,
      body: review.body,
      ...(review.submitted_at ? { submittedAt: review.submitted_at } : {}),
      url: githubUrl(review.html_url) ?? fallbackUrl,
    });
  }
  return out.sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
}

/** The review word a PR list shows: the latest decisive review of each person decides. */
export function reviewState(reviews: readonly PullReview[], requested: number): PullDetail['review'] {
  const latest = new Map<string, PullReview['verdict']>();
  for (const review of reviews) {
    if (review.verdict === 'approved' || review.verdict === 'changes_requested' || review.verdict === 'dismissed')
      latest.set(review.author.login, review.verdict);
  }
  const verdicts = [...latest.values()];
  if (verdicts.includes('changes_requested')) return 'changes_requested';
  if (verdicts.includes('approved')) return 'approved';
  return requested > 0 ? 'review_required' : 'none';
}

const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const PASSED = new Set(['success', 'neutral']);

/** One check's status, GitHub's `status` + `conclusion` folded into one word. */
export function checkStatus(status: string, conclusion: string | null | undefined): CiStatus {
  if (status === 'queued' || status === 'waiting' || status === 'pending' || status === 'requested') return 'queued';
  if (status === 'in_progress') return 'running';
  if (conclusion === 'skipped') return 'skipped';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion !== null && conclusion !== undefined && FAILED.has(conclusion)) return 'failed';
  if (conclusion !== null && conclusion !== undefined && PASSED.has(conclusion)) return 'passed';
  return 'queued';
}

/** The head commit's checks: counts, one word for the PR, and up to 100 of them by name. */
export function mapChecks(raw: unknown): PullChecks {
  const parsed = RawChecks.safeParse(raw);
  const runs = parsed.success ? parsed.data.check_runs : [];
  const items: PullCheck[] = [];
  for (const run of runs) {
    const check = RawCheckRun.safeParse(run);
    if (!check.success) continue;
    const url = githubUrl(check.data.html_url);
    items.push({
      name: clip(check.data.name, 500),
      status: checkStatus(check.data.status, check.data.conclusion),
      ...(url === undefined ? {} : { url }),
    });
  }
  const shown = items.slice(0, MAX_PAGE_CHECKS);
  const count = (status: CiStatus): number => shown.filter(item => item.status === status).length;
  const failed = count('failed');
  const running = count('running');
  const queued = count('queued');
  const cancelled = count('cancelled');
  const passed = count('passed');
  const considered = shown.filter(item => item.status !== 'skipped').length;
  let state: CiState = 'passing';
  if (considered === 0) state = 'none';
  else if (failed > 0) state = 'failing';
  else if (running > 0) state = 'running';
  else if (queued > 0) state = 'queued';
  else if (cancelled > 0) state = 'cancelled';
  return { state, total: shown.length, passed, failed, running, queued, items: shown };
}
