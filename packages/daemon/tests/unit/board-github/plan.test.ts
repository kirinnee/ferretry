import { describe, it } from 'bun:test';
import { type PrLink, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import {
  cardCategory,
  isLinkable,
  isWatched,
  jittered,
  needsPoll,
  POLL_IDLE_MS,
  POLL_OPEN_MS,
  pollDelay,
  prKey,
  refileTargets,
  repoKey,
  UNFILED_REFILE_AFTER_MS,
} from '../../../src/lib/board-github/index.ts';
import { card, lanes, NOW, PROJECT } from '../board/support.ts';

const pr = (overrides: Partial<PrLink> = {}): PrLink => ({
  url: 'https://github.com/kirinnee/ferretry/pull/1',
  number: 1,
  repo: 'kirinnee/ferretry',
  state: 'unknown',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: null,
  ...overrides,
});

const laneSets = new Map([
  [PROJECT, lanes()],
  [UNFILED_PROJECT_ID, lanes(UNFILED_PROJECT_ID, 'quick')],
]);
const nowMs = Date.parse(NOW);

describe('cadence', () => {
  it('should poll about once a minute while a PR is open and every ten minutes otherwise, jittered either way', () => {
    should(pollDelay(true, 0.5)).equal(POLL_OPEN_MS);
    should(pollDelay(false, 0.5)).equal(POLL_IDLE_MS);
    should(jittered(1000, 0)).equal(900);
    should(jittered(1000, 0.999_999)).equal(1100);
  });
});

describe('what is watched', () => {
  it('should poll only what GitHub can still change', () => {
    should(needsPoll(pr())).be.true();
    should(needsPoll(pr({ state: 'open' }))).be.true();
    should(needsPoll(pr({ state: 'merged' }))).be.true();
    should(needsPoll(pr({ state: 'merged', releasedIn: { version: '1.0.0', tag: 'v1.0.0', at: NOW } }))).be.false();
    should(needsPoll(pr({ state: 'closed' }))).be.false();
  });

  it('should watch open cards, and link only cards that have not shipped', () => {
    should(isWatched(card({ laneId: 'merged' }), laneSets)).be.true();
    should(isWatched(card({ laneId: 'closed' }), laneSets)).be.false();
    should(isWatched(card({ dropped: { reason: 'gone', at: NOW } }), laneSets)).be.false();
    should(isLinkable(card({ laneId: 'review' }), laneSets)).be.true();
    should(isLinkable(card({ laneId: 'merged' }), laneSets)).be.false();
    should(isLinkable(card({ laneId: 'todo', dropped: { reason: 'gone', at: NOW } }), laneSets)).be.false();
  });

  it('should know no category for a board without lanes or a lane it does not have', () => {
    should(cardCategory(card({ laneId: 'gone' }), laneSets)).be.null();
    should(cardCategory(card({ projectId: '33333333-3333-4333-8333-333333333333' }), laneSets)).be.null();
  });

  it('should key repositories and PRs without case', () => {
    should(repoKey('KirinNee/Ferretry')).equal('kirinnee/ferretry');
    should(prKey('KirinNee/Ferretry', 7)).equal('kirinnee/ferretry#7');
  });
});

describe('refileTargets', () => {
  const old = new Date(nowMs - UNFILED_REFILE_AFTER_MS - 1).toISOString();
  const owners = new Map([['kirinnee/ferretry', { id: PROJECT, name: 'Ferretry' }]]);
  const unfiled = (overrides = {}) =>
    card({
      projectId: UNFILED_PROJECT_ID,
      createdAt: old,
      links: { prs: [pr({ repo: 'KirinNee/Ferretry' })], branch: null, commits: [], docs: [] },
      ...overrides,
    });

  it('should refile a day-old Unfiled card to the project that owns its PR', () => {
    const [target] = refileTargets([unfiled()], laneSets, owners, nowMs);
    should(target?.projectId).equal(PROJECT);
    should(target?.reason).equal(
      '&F1 sat on the Unfiled board for over a day, and its PR #1 is in KirinNee/Ferretry, which Ferretry owns',
    );
  });

  it('should leave a card that is young, filed, closed, without a PR, or whose repository no project owns', () => {
    const cases = [
      unfiled({ createdAt: NOW }),
      card({ createdAt: old, links: { prs: [pr()], branch: null, commits: [], docs: [] } }),
      unfiled({ laneId: 'closed' }),
      unfiled({ links: { prs: [], branch: null, commits: [], docs: [] } }),
      unfiled({ links: { prs: [pr({ repo: 'someone/else' })], branch: null, commits: [], docs: [] } }),
    ];
    should(refileTargets(cases, laneSets, owners, nowMs)).be.empty();
  });

  it("should count a day from the card's last refile onto the Unfiled board", () => {
    const back = unfiled();
    const refiled = {
      ...back,
      history: [
        ...back.history,
        {
          seq: 2,
          at: NOW,
          actor: { kind: 'owner' as const },
          type: 'refiled' as const,
          fromProject: PROJECT,
          toProject: UNFILED_PROJECT_ID,
          toLane: 'todo',
          reason: null,
        },
      ],
    };
    should(refileTargets([refiled], laneSets, owners, nowMs)).be.empty();
  });
});
