import { describe, it } from 'bun:test';
import type { BoardTask, PrLink } from '@ferretry/protocol';
import should from 'should';
import {
  blockedReviewCards,
  blockersOf,
  planReviewBlocked,
  recordReviewBlockedNudge,
  REVIEW_BLOCKED_MS,
  type ReviewBlockedMemory,
  type WardenSessionView,
} from '../../../src/lib/warden/index.ts';
import { boardOf, cardView } from './board-fixtures.ts';

/**
 * A card in Review whose pull request cannot merge, its ferret gone idle (2026-11-04: the compact-header PR sat with a
 * merge conflict for about seven hours, its ferret had finished its turn, and nothing noticed).
 */

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const URL_ONE = 'https://github.com/kirinnee/ferretry/pull/940';
const URL_TWO = 'https://github.com/kirinnee/ferretry/pull/941';

const pr = (over: Partial<PrLink> = {}): PrLink => ({
  url: URL_ONE,
  number: 940,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'passing',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: iso(NOW),
  ...over,
});

const reviewCard = (prs: readonly PrLink[], over: Partial<BoardTask> = {}) =>
  cardView({
    laneId: 'review',
    assignee: 'worker',
    links: { prs: [...prs], branch: null, commits: [], docs: [] },
    ...over,
  });

const worker = (
  over: { readonly state?: Partial<WardenSessionView['state']>; readonly mode?: 'auto' | 'interactive' } = {},
): WardenSessionView => ({
  config: { id: 'worker', mode: over.mode ?? 'auto', teammate: 'rebecca' },
  state: { status: 'running', turnState: 'your-turn', turnStateAt: iso(NOW - 60 * MINUTE), ...over.state },
  hasLiveMonitor: true,
});

const conflicted = pr({ mergeable: 'conflicting' });
const red = pr({ checks: 'failing' });

const plan = (
  over: {
    readonly prs?: readonly PrLink[];
    readonly memory?: ReviewBlockedMemory;
    readonly fleet?: readonly WardenSessionView[];
    readonly nowMs?: number;
    readonly enabled?: boolean;
    readonly mayNudge?: boolean;
  } = {},
) =>
  planReviewBlocked({
    blocked: blockedReviewCards(boardOf(reviewCard(over.prs ?? [conflicted]))),
    fleet: over.fleet ?? [worker()],
    memory: over.memory ?? {},
    enabled: over.enabled ?? true,
    mayNudge: over.mayNudge ?? true,
    clientName: 'fy',
    nowMs: over.nowMs ?? NOW,
  });

/** The sweep that first saw the card blocked, 31 minutes ago. */
const seenBefore = (state: string, over: { nudgedAt?: string } = {}): ReviewBlockedMemory => ({
  F1: { state, since: iso(NOW - 31 * MINUTE), ...over },
});
const CONFLICT_STATE = `${URL_ONE}:conflict`;

describe('which pull requests are blocked', () => {
  it('should name a merge conflict and red CI, each on its own and together, in a fixed order', () => {
    should(blockersOf(conflicted)).eql(['conflict']);
    should(blockersOf(red)).eql(['ci_failing']);
    should(blockersOf(pr({ mergeable: 'conflicting', checks: 'failing' }))).eql(['conflict', 'ci_failing']);
  });

  it('should not block a PR that merges cleanly, is pending, is a draft, or is no longer open', () => {
    should(blockersOf(pr({ mergeable: 'mergeable' }))).be.empty();
    should(blockersOf(pr({ checks: 'pending' }))).be.empty();
    should(blockersOf(pr({ checks: 'none' }))).be.empty();
    should(blockersOf(pr({ mergeable: 'conflicting', draft: true }))).be.empty();
    should(blockersOf(pr({ state: 'closed', checks: 'failing' }))).be.empty();
    should(blockersOf(pr({ state: 'unknown', mergeable: 'conflicting' }))).be.empty();
  });
});

describe('which cards are blocked', () => {
  it('should list a card in Review with a blocked PR, with its ferret and a state that ignores link order', () => {
    const forward = blockedReviewCards(
      boardOf(reviewCard([conflicted, pr({ url: URL_TWO, number: 941, checks: 'failing' })])),
    );
    const reversed = blockedReviewCards(
      boardOf(reviewCard([pr({ url: URL_TWO, number: 941, checks: 'failing' }), conflicted])),
    );
    should(forward).have.length(1);
    should(forward[0]).match({ id: 'F1', ref: '&F1', assignee: 'worker' });
    should(forward[0]?.prs.map(each => each.number)).eql([940, 941]);
    should(forward[0]?.state).equal(reversed[0]?.state);
  });

  it('should answer for the owner when the card has no assignee', () => {
    const [found] = blockedReviewCards(boardOf(reviewCard([conflicted], { assignee: null, owner: 'lead' })));
    should(found?.assignee).equal('lead');
  });

  it('should skip a card outside Review, a dropped card, and a card whose PRs merge cleanly', () => {
    const outside = cardView({
      laneId: 'implement',
      links: { prs: [conflicted], branch: null, commits: [], docs: [] },
    });
    const dropped = reviewCard([conflicted], { dropped: { reason: 'not needed', at: iso(NOW), by: 'lead' } as never });
    const clean = reviewCard([pr({ mergeable: 'mergeable' })]);
    should(blockedReviewCards(boardOf(outside, dropped, clean))).be.empty();
  });
});

describe('waking the ferret of a blocked card', () => {
  it('should start the clock when a blocked card is first seen, and wake nobody yet', () => {
    const result = plan();
    should(result.nudges).be.empty();
    should(result.memory).eql({ F1: { state: CONFLICT_STATE, since: iso(NOW) } });
  });

  it('should not wake anybody before the state has stood 30 minutes', () => {
    const memory: ReviewBlockedMemory = { F1: { state: CONFLICT_STATE, since: iso(NOW - REVIEW_BLOCKED_MS + MINUTE) } };
    should(plan({ memory }).nudges).be.empty();
  });

  it('should wake an idle ferret after 30 minutes with a short nudge naming the PR and what blocks it', () => {
    const { nudges } = plan({ memory: seenBefore(CONFLICT_STATE) });
    should(nudges).have.length(1);
    should(nudges[0]).match({ cardId: 'F1', sessionId: 'worker', state: CONFLICT_STATE });
    const message = nudges[0]?.message ?? '';
    should(message).containEql('&F1');
    should(message).containEql(URL_ONE);
    should(message).containEql('a merge conflict');
    should(message).containEql('31m');
    should(message.length).be.below(400);
  });

  it('should name red CI, and both blockers when a PR has both', () => {
    const redState = `${URL_ONE}:ci_failing`;
    const bothState = `${URL_ONE}:conflict+ci_failing`;
    should(plan({ prs: [red], memory: seenBefore(redState) }).nudges[0]?.message).containEql('has red CI');
    const both = plan({ prs: [pr({ mergeable: 'conflicting', checks: 'failing' })], memory: seenBefore(bothState) });
    should(both.nudges[0]?.message).containEql('a merge conflict and red CI');
  });

  it('should wake a ferret that has signalled done and sits at its prompt: it is the one that finished', () => {
    const finished: WardenSessionView = { ...worker(), hasDoneMarker: true };
    should(plan({ memory: seenBefore(CONFLICT_STATE), fleet: [finished] }).nudges).have.length(1);
  });

  it('should wake it ONCE: a state it was already woken for stands without a second nudge', () => {
    const memory = seenBefore(CONFLICT_STATE, { nudgedAt: iso(NOW - 10 * MINUTE) });
    const result = plan({ memory, nowMs: NOW + 6 * 60 * MINUTE });
    should(result.nudges).be.empty();
    should(result.memory).eql(memory);
  });

  it('should treat a changed state as a new episode, with its own clock and its own nudge', () => {
    // The conflict was fixed and woken for; now CI is red instead.
    const memory = seenBefore(CONFLICT_STATE, { nudgedAt: iso(NOW - 10 * MINUTE) });
    const next = plan({ prs: [red], memory });
    should(next.nudges).be.empty();
    should(next.memory).eql({ F1: { state: `${URL_ONE}:ci_failing`, since: iso(NOW) } });
    const later = plan({ prs: [red], memory: next.memory, nowMs: NOW + 31 * MINUTE });
    should(later.nudges).have.length(1);
  });

  it('should forget a card that is no longer blocked, so a new block is news again', () => {
    const fixed = planReviewBlocked({
      blocked: blockedReviewCards(boardOf(reviewCard([pr({ mergeable: 'mergeable' })]))),
      fleet: [worker()],
      memory: seenBefore(CONFLICT_STATE, { nudgedAt: iso(NOW - 10 * MINUTE) }),
      enabled: true,
      mayNudge: true,
      clientName: 'fy',
      nowMs: NOW,
    });
    should(fixed.memory).eql({});
    should(plan({ nowMs: NOW }).memory).eql({ F1: { state: CONFLICT_STATE, since: iso(NOW) } });
  });

  it('should leave a ferret that is not idle alone, and wake it the moment it goes idle', () => {
    const memory = seenBefore(CONFLICT_STATE);
    const busy = worker({ state: { turnState: 'working' } });
    should(plan({ memory, fleet: [busy] }).nudges).be.empty();
    // The clock kept running meanwhile.
    should(plan({ memory, fleet: [busy] }).memory).eql(memory);
    should(plan({ memory, fleet: [worker()] }).nudges).have.length(1);
  });

  it('should not wake a ferret in a declared wait, out of quota, finished, gone, or in someone’s terminal', () => {
    const memory = seenBefore(CONFLICT_STATE);
    const cases: Record<string, readonly WardenSessionView[]> = {
      waiting: [worker({ state: { waiting: { since: iso(NOW - 20 * MINUTE) } } })],
      'out of quota': [worker({ state: { status: 'rate_limited' } })],
      finished: [worker({ state: { status: 'completed' } })],
      gone: [],
      interactive: [worker({ mode: 'interactive' })],
    };
    for (const [name, fleet] of Object.entries(cases)) {
      should(plan({ memory, fleet }).nudges).have.length(0, name);
    }
  });

  it('should not wake a warden’s own lineage', () => {
    const warden: WardenSessionView = { ...worker(), config: { ...worker().config, wardenLineage: true } };
    should(plan({ memory: seenBefore(CONFLICT_STATE), fleet: [warden] }).nudges).be.empty();
  });

  it('should wake nobody while the Warden is off or may not nudge alone, but keep the clock', () => {
    const memory = seenBefore(CONFLICT_STATE);
    for (const over of [{ enabled: false }, { mayNudge: false }]) {
      const result = plan({ memory, ...over });
      should(result.nudges).be.empty();
      should(result.memory).eql(memory);
    }
  });

  it('should record a landed nudge only for the state it was for', () => {
    const memory = seenBefore(CONFLICT_STATE);
    const landed = recordReviewBlockedNudge(memory, { cardId: 'F1', state: CONFLICT_STATE }, iso(NOW));
    should(landed.F1?.nudgedAt).equal(iso(NOW));
    should(recordReviewBlockedNudge(memory, { cardId: 'F1', state: 'something else' }, iso(NOW))).eql(memory);
  });
});
