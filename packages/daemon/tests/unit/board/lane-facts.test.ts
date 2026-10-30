import { describe, it } from 'bun:test';
import type { BoardTask, BoardTaskEvent, LaneSet, PrLink, ReleasedIn, TaskWorkflow } from '@ferretry/protocol';
import should from 'should';
import { FACT_TRIGGERS, laneFromFacts } from '../../../src/lib/board/index.ts';
import { card, lanes, PROJECT } from './support.ts';

const MERGED_AT = '2026-10-30T09:00:00Z';
const SHA = 'a'.repeat(40);
const release = (version: string): ReleasedIn => ({ version, tag: `v${version}`, at: '2026-10-30T09:30:00Z' });

const pr = (number: number, overrides: Partial<PrLink> = {}): PrLink => ({
  url: `https://github.com/kirinnee/ferretry/pull/${String(number)}`,
  number,
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

const open = (number: number, draft = false): PrLink => pr(number, { state: 'open', draft });
const merged = (number: number, releasedIn: ReleasedIn | null = null): PrLink =>
  pr(number, { state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, releasedIn });

const at = (laneId: string, prs: readonly PrLink[], overrides: Partial<BoardTask> = {}): BoardTask =>
  card({ laneId, links: { prs: [...prs], branch: null, commits: [], docs: [] }, ...overrides });

const verdict = (
  subject: BoardTask,
  runningVersion: string | null = null,
  laneSet: LaneSet = lanes(),
  workflow: TaskWorkflow = subject.workflow,
) => {
  const move = laneFromFacts(subject, laneSet, workflow, { prs: subject.links.prs, runningVersion });
  return move === null ? null : [move.lane.id, move.trigger];
};

describe('laneFromFacts: what the facts say', () => {
  it.each([
    { name: 'no PR at all', prs: [], expected: null },
    { name: 'a PR nobody has asked GitHub about', prs: [pr(1)], expected: null },
    { name: 'a PR closed without merging', prs: [pr(1, { state: 'closed' })], expected: null },
    { name: 'a draft PR', prs: [open(1, true)], expected: ['review', 'pr.opened'] },
    { name: 'a PR ready for review', prs: [open(1)], expected: ['review', 'pr.ready'] },
    { name: 'a merged PR', prs: [merged(1)], expected: ['merged', 'pr.merged'] },
    {
      name: 'a merged PR in a release',
      prs: [merged(1, release('4.110.0'))],
      expected: ['released', 'release.published'],
    },
    {
      name: 'an open PR beside a merged one: the open one is not done',
      prs: [merged(1), open(2)],
      expected: ['review', 'pr.ready'],
    },
    {
      name: 'a merged PR beside a closed one: the closed one says nothing',
      prs: [merged(1), pr(2, { state: 'closed' })],
      expected: ['merged', 'pr.merged'],
    },
    {
      name: 'two merged PRs, only one released: not released yet',
      prs: [merged(1, release('4.110.0')), merged(2)],
      expected: ['merged', 'pr.merged'],
    },
    {
      name: 'two merged PRs, both released',
      prs: [merged(1, release('4.110.0')), merged(2, release('4.111.0'))],
      expected: ['released', 'release.published'],
    },
    {
      name: 'a merged PR beside one nobody has asked about',
      prs: [merged(1, release('4.110.0')), pr(2)],
      expected: ['merged', 'pr.merged'],
    },
  ])('should put a card in Implement by $name', ({ prs, expected }) => {
    should(verdict(at('implement', prs))).deepEqual(expected);
  });

  it('should say why, naming the PRs', () => {
    const move = laneFromFacts(at('implement', [merged(7), merged(8)]), lanes(), 'quick', {
      prs: [merged(7), merged(8)],
      runningVersion: null,
    });
    should(move?.reason).equal('PR #7, #8 merged');
    const open7 = laneFromFacts(at('implement', [open(7, true)]), lanes(), 'quick', {
      prs: [open(7, true)],
      runningVersion: null,
    });
    should(open7?.reason).equal('PR #7 open');
  });

  it('should say a release runs here only when this machine runs every release the card shipped in', () => {
    const subject = at('released', [merged(1, release('4.110.0')), merged(2, release('4.112.0'))]);
    should(verdict(subject, null)).be.null();
    should(verdict(subject, '4.111.0')).be.null();
    should(verdict(subject, '4.112.0')).deepEqual(['tested', 'release.running']);
    should(verdict(subject, '5.0.0')).deepEqual(['tested', 'release.running']);
    const early = at('merged', [merged(1, release('4.110.0'))]);
    should(verdict(early, '4.109.0')).deepEqual(['released', 'release.published']);
    should(verdict(early, '4.110.0')).deepEqual(['tested', 'release.running']);
  });

  it('should put a card that missed every event where its facts say, from any earlier lane', () => {
    const shipped = [merged(1, release('4.110.0'))];
    for (const lane of ['todo', 'plan', 'implement', 'review', 'merged']) {
      should(verdict(at(lane, shipped), '4.110.0')).deepEqual(['tested', 'release.running']);
    }
  });
});

describe('laneFromFacts: never backward, never sideways', () => {
  it.each([
    { from: 'review', prs: [open(1)] },
    { from: 'merged', prs: [open(1)] },
    { from: 'released', prs: [open(1)] },
    { from: 'tested', prs: [open(1)] },
    { from: 'merged', prs: [merged(1)] },
    { from: 'released', prs: [merged(1)] },
    { from: 'tested', prs: [merged(1, release('4.110.0'))] },
    { from: 'released', prs: [merged(1, release('4.110.0'))] },
  ])('should keep a card in $from when its facts are the same or behind', ({ from, prs }) => {
    should(verdict(at(from, prs))).be.null();
  });

  it('should leave a closed card, and a dropped one, alone', () => {
    should(verdict(at('closed', [merged(1)]))).be.null();
    should(verdict(at('implement', [merged(1)], { dropped: { reason: 'gone', at: MERGED_AT } }))).be.null();
  });

  it('should have no opinion about a lane the set does not know', () => {
    should(verdict(at('elsewhere', [merged(1)]))).be.null();
  });
});

describe('laneFromFacts: an open PR pulls a shipped card back', () => {
  const shipped = merged(1008, release('4.110.0'));
  const open = (number: number, overrides: Partial<PrLink> = {}) => pr(number, { state: 'open', ...overrides });
  const move = (subject: BoardTask, runningVersion: string | null = null) =>
    laneFromFacts(subject, lanes(), subject.workflow, { prs: subject.links.prs, runningVersion });

  it.each(['merged', 'released', 'tested'])('should move a card in %s back to review for an open PR', lane => {
    const subject = at(lane, [shipped, open(1013)]);
    should(move(subject, '4.110.0')).match({
      lane: { id: 'review' },
      trigger: 'pr.ready',
      backward: true,
      reason: 'moved back to Review/CI: PR #1013 ready for review',
    });
  });

  it('should pull a card back for a parallel PR that was opened before the merge', () => {
    should(move(at('tested', [shipped, open(1005, { createdAt: '2026-10-30T08:00:00Z' })]))).match({
      lane: { id: 'review' },
      backward: true,
    });
    should(move(at('tested', [shipped, open(1013, { createdAt: null })]))?.backward).be.true();
    should(move(at('tested', [shipped, open(1013, { repo: 'kirinnee/other' })]))?.backward).be.true();
  });

  it('should go back through an owner gate, because a fact is leaving To test, not deciding it', () => {
    should(move(at('tested', [shipped, open(1013, { draft: true })]))).match({
      lane: { id: 'review' },
      trigger: 'pr.opened',
      backward: true,
      reason: 'moved back to Review/CI: PR #1013 open',
    });
  });

  it('should name every open PR, and fall to the draft lane when only drafts are open', () => {
    should(move(at('tested', [shipped, open(1013), open(1014, { draft: true })]))?.reason).equal(
      'moved back to Review/CI: PR #1013 ready for review',
    );
    should(move(at('tested', [shipped, open(1013, { draft: true }), open(1014, { draft: true })]))?.reason).equal(
      'moved back to Review/CI: PR #1013, #1014 open',
    );
  });

  it('should ignore a PR closed unmerged, among several mixed PRs', () => {
    const closedOnly = at('tested', [shipped, pr(1009, { state: 'closed' })]);
    should(move(closedOnly, '4.110.0')).be.null();
    const mixed = at('tested', [shipped, pr(1009, { state: 'closed' }), open(1013), merged(1010, release('4.111.0'))]);
    should(move(mixed)?.reason).equal('moved back to Review/CI: PR #1013 ready for review');
  });

  it('should leave a card in review, a closed card and a dropped card where they are', () => {
    should(move(at('review', [shipped, open(1013)]))).be.null();
    should(move(at('closed', [shipped, open(1013)]))).be.null();
    const dropped = at('tested', [shipped, open(1013)], { dropped: { reason: 'gone', at: MERGED_AT } });
    should(move(dropped)).be.null();
  });

  it('should move a card with nothing merged forward only: an open PR alone has shipped nothing to pull back', () => {
    should(move(at('tested', [open(1013)]))).be.null();
    should(move(at('implement', [open(1013)]))).match({ lane: { id: 'review' }, backward: false });
  });

  it('should not count its own move back as the owner sending the card back', () => {
    const base = at('review', [shipped, pr(1013, { state: 'closed' })]);
    const pulled: BoardTaskEvent = {
      seq: 2,
      at: '2026-10-30T10:05:00Z',
      actor: { kind: 'daemon' },
      type: 'moved',
      from: 'tested',
      to: 'review',
      backward: true,
      reason: 'moved back to Review/CI: PR #1013 ready for review',
      auto: true,
      trigger: 'pr.ready',
    };
    // The new PR was abandoned: what shipped still ships, so the card goes on to the release.
    const subject = { ...base, history: [base.history[0] as BoardTaskEvent, pulled] };
    should(move(subject, '4.110.0')).match({ lane: { id: 'tested' }, trigger: 'release.running', backward: false });
  });

  it('should still keep a card the owner sent back where it is sent', () => {
    const base = at('implement', [shipped, open(1013)]);
    const sent: BoardTaskEvent = {
      seq: 2,
      at: '2026-10-30T10:05:00Z',
      actor: { kind: 'owner' },
      type: 'reopened',
      from: 'tested',
      to: 'implement',
      reason: 'not good',
      ask: { text: 'again', source: 'owner' },
    };
    const subject = { ...base, history: [base.history[0] as BoardTaskEvent, sent] };
    should(move(subject)).match({ lane: { id: 'review' }, backward: false });
    should(move({ ...subject, links: { ...subject.links, prs: [shipped] } })).be.null();
  });
});

describe('laneFromFacts: a card the owner sent back', () => {
  const sentBack = (kind: 'reopened' | 'moved', when: string): BoardTaskEvent =>
    kind === 'reopened'
      ? {
          seq: 2,
          at: when,
          actor: { kind: 'owner' },
          type: 'reopened',
          from: 'tested',
          to: 'implement',
          reason: 'not good',
          ask: { text: 'again', source: 'owner' },
        }
      : {
          seq: 2,
          at: when,
          actor: { kind: 'ferret', sessionId: 'lead' },
          type: 'moved',
          from: 'review',
          to: 'implement',
          backward: true,
          reason: 'needs more work',
        };
  const created = (subject: BoardTask): BoardTaskEvent => subject.history[0] as BoardTaskEvent;

  it.each(['reopened', 'moved'] as const)(
    'should not move it on a PR that merged before it was %s back, but on one that merges after',
    kind => {
      const base = at('implement', [merged(1)]);
      const before = { ...base, history: [created(base), sentBack(kind, '2026-10-30T09:45:00Z')] };
      should(verdict(before)).be.null();
      const after = { ...base, history: [created(base), sentBack(kind, '2026-10-30T08:00:00Z')] };
      should(verdict(after)).deepEqual(['merged', 'pr.merged']);
    },
  );

  it('should still follow an open PR on a card that was sent back', () => {
    const base = at('implement', [merged(1), open(2)]);
    const subject = { ...base, history: [created(base), sentBack('reopened', '2026-10-30T09:45:00Z')] };
    should(verdict(subject)).deepEqual(['review', 'pr.ready']);
  });

  it('should ignore a merge time it cannot read: such a PR still counts', () => {
    const base = at('implement', [pr(1, { state: 'merged', mergedAt: null })]);
    const subject = { ...base, history: [created(base), sentBack('reopened', '2026-10-30T09:45:00Z')] };
    should(verdict(subject)).deepEqual(['merged', 'pr.merged']);
  });
});

describe('laneFromFacts: gates are for decisions, not for facts', () => {
  it('should carry a card forward out of an owner-gated Plan/Design lane', () => {
    should(verdict(at('plan', [open(1)]))).deepEqual(['review', 'pr.ready']);
    should(verdict(at('plan', [merged(1)]))).deepEqual(['merged', 'pr.merged']);
  });

  it('should enter the owner-gated To test lane, because a fact put it there', () => {
    should(verdict(at('released', [merged(1, release('4.110.0'))]), '4.110.0')).deepEqual([
      'tested',
      'release.running',
    ]);
  });

  it('should never enter Closed in a lane set with a To test lane', () => {
    for (const prs of [[merged(1)], [merged(1, release('4.110.0'))]]) {
      const move = laneFromFacts(at('implement', prs), lanes(), 'design-first', { prs, runningVersion: '9.0.0' });
      should(move?.lane.category).not.equal('closed');
    }
  });

  it('should enter the closing lane a set without To test closes on, when its enterOn says so', () => {
    should(verdict(at('review', [merged(1, release('4.110.0'))]), null, lanes(PROJECT, 'pr-release'))).deepEqual([
      'released',
      'release.published',
    ]);
    should(verdict(at('review', [merged(1)]), null, lanes(PROJECT, 'pr'))).deepEqual(['merged', 'pr.merged']);
  });

  it('should not enter an owner-gated Closed lane even when the set has no To test lane', () => {
    const gated: LaneSet = {
      ...lanes(PROJECT, 'pr'),
      lanes: [
        { id: 'todo', name: 'Todo', category: 'backlog' },
        { id: 'doing', name: 'Doing', category: 'active', enterOn: ['work.started'] },
        { id: 'review', name: 'Review', category: 'review', enterOn: ['pr.opened', 'pr.ready'] },
        { id: 'done', name: 'Done', category: 'closed', enterOn: ['pr.merged'], ownerGate: true },
      ],
      variants: Object.fromEntries(
        (['design-first', 'quick'] as const).map(workflow => [workflow, ['todo', 'doing', 'review', 'done']]),
      ),
    };
    should(verdict(at('doing', [merged(1)]), null, gated)).be.null();
    should(verdict(at('doing', [open(1)]), null, gated)).deepEqual(['review', 'pr.ready']);
  });

  it('should fall back to the next fact down when the set has no lane for the one the facts name', () => {
    // `pr` has no Released lane: a released PR is a merged PR.
    should(verdict(at('review', [merged(1, release('4.110.0'))]), '4.110.0', lanes(PROJECT, 'pr'))).deepEqual([
      'merged',
      'pr.merged',
    ]);
  });

  it('should leave a workflow that skips the lane the facts name with no opinion', () => {
    // `quick` work in `writing` walks Research → Draft → Review → Published → Closed; nothing is for `release.*`.
    should(verdict(at('draft', [open(1)]), null, lanes(PROJECT, 'writing'))).deepEqual(['review', 'pr.opened']);
    should(verdict(at('draft', [merged(1)]), null, lanes(PROJECT, 'ops'))).be.null();
  });
});

describe('FACT_TRIGGERS', () => {
  it('should be the triggers PR facts fire, and none that a person or a ferret decides', () => {
    should([...FACT_TRIGGERS].sort()).deepEqual(
      ['ci.green', 'pr.merged', 'pr.opened', 'pr.ready', 'release.published', 'release.running'].sort(),
    );
  });
});
