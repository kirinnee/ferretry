import { describe, expect, test } from 'bun:test';
import type { GitAccount } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import {
  DEFAULT_NOTIFY,
  PullsConfigSchema,
  settingsOf,
  WATCH_CADENCE_MS,
  type WatchedPull,
  type WatchedRepo,
} from '../../contract/index.ts';
import { intervalFor, isViewed } from '../../daemon/features/watch/cadence.ts';
import { foldCi } from '../../daemon/features/watch/ci-fold.ts';
import { eventsOf } from '../../daemon/features/watch/events.ts';
import { foldReviews } from '../../daemon/features/watch/review-fold.ts';
import { reposOf, repoRefOf } from '../../daemon/features/watch/repos.ts';
import { buzzOf, cleanTitle } from '../../daemon/features/watch/words.ts';

const repo = { provider: 'github', owner: 'octo', name: 'widgets' } as const;
const pull = (over: Partial<WatchedPull> = {}): WatchedPull => ({
  repo,
  number: 7,
  title: 'Fix the thing',
  author: { login: 'me' },
  state: 'open',
  draft: false,
  review: 'none',
  ci: 'running',
  headSha: 'abcdef1',
  headRef: 'fix',
  baseRef: 'main',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  url: 'https://github.com/octo/widgets/pull/7',
  mine: true,
  requestedMe: false,
  comments: 0,
  ...over,
});

describe('foldCi', () => {
  test('worst first: failing, running, queued, cancelled, passing, none', () => {
    expect(foldCi([])).toBe('none');
    expect(foldCi([{ status: 'completed', conclusion: 'success' }])).toBe('passing');
    expect(
      foldCi([
        { status: 'completed', conclusion: 'skipped' },
        { status: 'completed', conclusion: 'neutral' },
      ]),
    ).toBe('passing');
    expect(foldCi([{ status: 'completed', conclusion: 'cancelled' }])).toBe('cancelled');
    expect(
      foldCi([
        { status: 'queued', conclusion: null },
        { status: 'completed', conclusion: 'success' },
      ]),
    ).toBe('queued');
    expect(
      foldCi([
        { status: 'in_progress', conclusion: null },
        { status: 'queued', conclusion: null },
      ]),
    ).toBe('running');
    // A failure shows at once even while other runs go on: that is the moment to tell.
    expect(
      foldCi([
        { status: 'completed', conclusion: 'failure' },
        { status: 'in_progress', conclusion: null },
      ]),
    ).toBe('failing');
    expect(foldCi([{ status: 'completed', conclusion: 'timed_out' }])).toBe('failing');
  });
  test('a run waiting for approval is queued, not a failure; an unknown conclusion is not a pass', () => {
    expect(foldCi([{ status: 'completed', conclusion: 'action_required' }])).toBe('queued');
    expect(foldCi([{ status: 'completed', conclusion: 'brand_new' }])).toBe('queued');
  });
});

describe('foldReviews', () => {
  const r = (login: string, state: string, at: string) => ({ user: { login }, state, submitted_at: at });
  test('the latest verdict per reviewer counts; comments change nothing; dismissal clears', () => {
    expect(foldReviews([], 0)).toBe('none');
    expect(foldReviews([], 2)).toBe('review_required');
    expect(foldReviews([r('a', 'APPROVED', '2026-01-01T00:00:00Z')], 0)).toBe('approved');
    expect(
      foldReviews([r('a', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z'), r('a', 'APPROVED', '2026-01-02T00:00:00Z')], 0),
    ).toBe('approved');
    expect(
      foldReviews([r('a', 'APPROVED', '2026-01-01T00:00:00Z'), r('b', 'CHANGES_REQUESTED', '2026-01-02T00:00:00Z')], 0),
    ).toBe('changes_requested');
    expect(
      foldReviews([r('a', 'APPROVED', '2026-01-01T00:00:00Z'), r('a', 'COMMENTED', '2026-01-02T00:00:00Z')], 0),
    ).toBe('approved');
    expect(
      foldReviews(
        [r('a', 'CHANGES_REQUESTED', '2026-01-01T00:00:00Z'), r('a', 'DISMISSED', '2026-01-02T00:00:00Z')],
        0,
      ),
    ).toBe('none');
  });
});

describe('eventsOf: transitions, not states', () => {
  test('CI failing fires once; the next look with the same state tells nothing', () => {
    const before = [pull({ ci: 'running' })];
    const failed = [pull({ ci: 'failing' })];
    expect(eventsOf(before, failed, []).map(l => l.event)).toEqual(['ciFailed']);
    expect(eventsOf(failed, failed, [])).toEqual([]);
    // Fixed, then failing again: a new transition.
    expect(eventsOf([pull({ ci: 'passing' })], failed, []).map(l => l.event)).toEqual(['ciFailed']);
  });
  test('passing, verdicts, comments and an end are each told for the account’s own PR only', () => {
    expect(eventsOf([pull({ ci: 'running' })], [pull({ ci: 'passing' })], []).map(l => l.event)).toEqual(['ciPassed']);
    expect(eventsOf([pull()], [pull({ review: 'approved' })], []).map(l => l.event)).toEqual(['approved']);
    expect(eventsOf([pull()], [pull({ review: 'changes_requested' })], []).map(l => l.event)).toEqual([
      'changesRequested',
    ]);
    expect(eventsOf([pull()], [pull({ comments: 2 })], []).map(l => l.event)).toEqual(['comment']);
    const ended = [{ pull: pull(), merged: true }];
    const closed = eventsOf([pull()], [], ended);
    expect(closed.map(l => l.event)).toEqual(['closed']);
    expect(closed[0]?.merged).toBe(true);
    // Somebody else's PR: nothing but "asked of me".
    const theirs = pull({ mine: false, ci: 'failing', review: 'approved', comments: 5 });
    expect(eventsOf([pull({ mine: false, ci: 'running' })], [theirs], [])).toEqual([]);
  });
  test('a review asked of the account fires for any PR, once', () => {
    const asked = pull({ mine: false, requestedMe: true });
    expect(eventsOf([], [asked], []).map(l => l.event)).toEqual(['reviewRequested']);
    expect(eventsOf([asked], [asked], [])).toEqual([]);
  });
  test('a PR new to the look has CI to tell but no comments to be new against', () => {
    expect(eventsOf([], [pull({ ci: 'failing', comments: 3 })], []).map(l => l.event)).toEqual(['ciFailed']);
  });
  test('each occurrence has its own key; a repeat of the same state has the same key', () => {
    const a = eventsOf([pull()], [pull({ ci: 'failing' })], [])[0];
    const b = eventsOf([pull()], [pull({ ci: 'failing' })], [])[0];
    const c = eventsOf([pull()], [pull({ ci: 'failing', headSha: 'abcdef2' })], [])[0];
    expect(a?.key).toBe(b?.key as string);
    expect(c?.key).not.toBe(a?.key as string);
  });
});

describe('buzzOf: words only', () => {
  test('the title says what happened, the body is the PR title and nothing else of GitHub’s', () => {
    const line = eventsOf([pull()], [pull({ ci: 'failing', title: 'Fix‮the\nthing\u0007' })], [])[0]!;
    const buzz = buzzOf('11111111-1111-4111-8111-111111111111', line);
    expect(buzz.title).toBe('CI failed on #7');
    expect(buzz.body).toBe('Fix the thing');
    expect(buzz.kind).toBe('ci');
    expect(buzz.tag).toBe('pr-octo:widgets-7');
    expect(buzz.tag).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
    expect(buzz.url).toBe('/pulls/11111111-1111-4111-8111-111111111111/octo~widgets/7');
    expect(buzz.eventKey.length).toBeLessThanOrEqual(400);
  });
  test('a long title is cut to the push caps; PR events use the pr kind; a merge says Merged', () => {
    const long = 'x'.repeat(5000);
    const asked = buzzOf('p', eventsOf([], [pull({ mine: false, requestedMe: true, title: long })], [])[0]!);
    expect(asked.kind).toBe('pr');
    expect(asked.body.length).toBeLessThanOrEqual(200);
    expect(asked.title.length).toBeLessThanOrEqual(200);
    const merged = buzzOf('p', eventsOf([pull()], [], [{ pull: pull(), merged: true }])[0]!);
    expect(merged.title).toBe('Merged: #7');
    expect(cleanTitle('  a \t b ')).toBe('a b');
  });
});

describe('cadence', () => {
  const repoWith = (ci: WatchedPull['ci']): WatchedRepo => ({
    repo,
    account: 'gha_1',
    login: 'me',
    pulls: [pull({ ci })],
    checkedAt: '2026-11-01T00:00:00Z',
  });
  test('30 s with CI running or queued, 60 s with a screen open, 5 min otherwise', () => {
    expect(intervalFor([repoWith('running')], false)).toBe(WATCH_CADENCE_MS.running);
    expect(intervalFor([repoWith('queued')], true)).toBe(WATCH_CADENCE_MS.running);
    expect(intervalFor([repoWith('passing')], true)).toBe(WATCH_CADENCE_MS.viewed);
    expect(intervalFor([repoWith('passing')], false)).toBe(WATCH_CADENCE_MS.idle);
    expect(intervalFor([], false)).toBe(WATCH_CADENCE_MS.idle);
    expect(WATCH_CADENCE_MS).toMatchObject({ running: 30_000, viewed: 60_000, idle: 300_000 });
  });
  test('a screen counts as open for a little over two reads', () => {
    expect(isViewed(undefined, 1_000_000)).toBe(false);
    expect(isViewed(1_000_000 - WATCH_CADENCE_MS.viewedWithinMs, 1_000_000)).toBe(true);
    expect(isViewed(1_000_000 - WATCH_CADENCE_MS.viewedWithinMs - 1, 1_000_000)).toBe(false);
  });
});

describe('settings', () => {
  test('absent reads as watch off and the defaults; a project’s own choices sit on top', () => {
    expect(settingsOf(undefined, 'p')).toEqual({ watch: false, notify: DEFAULT_NOTIFY });
    const config = PullsConfigSchema.parse({
      projects: { p: { watch: true, notify: { ciPassed: true, ciFailed: false } } },
    });
    const s = settingsOf(config, 'p');
    expect(s.watch).toBe(true);
    expect(s.notify).toMatchObject({ ciPassed: true, ciFailed: false, reviewRequested: true, comment: false });
    expect(settingsOf(config, 'other').watch).toBe(false);
  });
  test('the defaults are the ones the owner chose: failures and reviews on; passes, comments and ends off', () => {
    expect(DEFAULT_NOTIFY).toEqual({
      ciFailed: true,
      reviewRequested: true,
      changesRequested: true,
      approved: true,
      ciPassed: false,
      comment: false,
      closed: false,
    });
  });
  test('an unknown key in the file is refused', () => {
    expect(PullsConfigSchema.safeParse({ projects: { p: { watch: true, token: 'x' } } }).success).toBe(false);
  });
});

describe('repos', () => {
  const account = (id: string): GitAccount => ({
    id: id as GitAccount['id'],
    provider: 'github',
    githubId: 1,
    login: `u-${id}`,
    scopes: [],
    keys: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const project = (over: Partial<ProjectInfo>): ProjectInfo => ({ id: 'p', ...over }) as ProjectInfo;
  test('only GitHub remotes count; .git and a trailing slash are dropped', () => {
    expect(repoRefOf({ path: '.', provider: 'github', remote: 'https://github.com/octo/widgets.git' })).toEqual(repo);
    expect(repoRefOf({ path: '.', provider: 'github', remote: 'https://github.com/octo/widgets/' })).toEqual(repo);
    expect(repoRefOf({ path: '.', provider: 'github', remote: 'https://gitlab.com/octo/widgets' })).toBeUndefined();
    expect(repoRefOf({ path: '.', provider: 'github' })).toBeUndefined();
    expect(repoRefOf({ path: '.', remote: 'https://github.com/octo/widgets' })).toBeUndefined();
  });
  test('a repo’s own account wins over the project’s first; a link to a gone account reads as none', () => {
    const accounts = [account('gha_1'), account('gha_2')];
    const p = project({
      accounts: ['gha_1'],
      repos: [
        { path: 'a', provider: 'github', remote: 'https://github.com/octo/a' },
        { path: 'b', provider: 'github', remote: 'https://github.com/octo/b', account: 'gha_2' },
        { path: 'c', provider: 'github', remote: 'https://github.com/octo/c', account: 'gha_9' },
        { path: 'd', provider: 'github', remote: 'https://github.com/octo/A' },
      ],
    });
    const out = reposOf(p, accounts);
    expect(out.map(each => [each.repo.name, each.account?.id])).toEqual([
      ['a', 'gha_1'],
      ['b', 'gha_2'],
      ['c', undefined],
    ]);
  });
  test('a project with no accounts reads every repo as needing one', () => {
    const p = project({ repos: [{ path: 'a', provider: 'github', remote: 'https://github.com/octo/a' }] });
    expect(reposOf(p, [account('gha_1')])[0]?.account).toBeUndefined();
  });
});
