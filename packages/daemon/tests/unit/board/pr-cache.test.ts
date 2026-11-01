import { describe, it } from 'bun:test';
import type { BoardTask, LaneSet, PrLink, ReleasedIn } from '@ferretry/protocol';
import should from 'should';
import {
  applyPrUpdate,
  BoardError,
  BoardIndex,
  BoardService,
  type CardContext,
  PR_POLL_LABEL_REFRESH_MS,
  type PrObservation,
  type PrUpdate,
  samePr,
} from '../../../src/lib/board/index.ts';
import { card, lanes, MemoryBoardStore, NOW, PROJECT, world } from './support.ts';

const URL = 'https://github.com/kirinnee/ferretry/pull/940';
const SHA = 'a'.repeat(40);
const MERGED_AT = '2026-10-30T09:00:00Z';
const RELEASE: ReleasedIn = { version: '4.110.0', tag: 'v4.110.0', at: '2026-10-30T09:30:00Z' };

const link = (overrides: Partial<PrLink> = {}): PrLink => ({
  url: URL,
  number: 940,
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

const observed = (overrides: Partial<PrObservation> = {}): PrObservation => ({
  url: URL,
  state: 'open',
  draft: false,
  checks: 'pending',
  mergedAt: null,
  mergeSha: null,
  ...overrides,
});

const merged = (overrides: Partial<PrObservation> = {}): PrObservation =>
  observed({ state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, checks: 'passing', ...overrides });

const update = (overrides: Partial<PrUpdate> = {}): PrUpdate => ({
  link: [],
  observed: [],
  releases: [],
  runningVersion: null,
  ...overrides,
});

const withPr = (pr: Partial<PrLink>, overrides: Partial<BoardTask> = {}): BoardTask =>
  card({
    laneId: 'implement',
    workflow: 'quick',
    links: { prs: [link(pr)], branch: null, commits: [], docs: [] },
    ...overrides,
  });

const context = (
  subject: BoardTask,
  overrides: Partial<CardContext> = {},
  laneSet: LaneSet = lanes(),
): CardContext => ({
  now: NOW,
  actor: { kind: 'daemon' },
  standing: 'daemon',
  laneSet,
  index: new BoardIndex([subject], 'machine-1'),
  laneSets: new Map([[PROJECT, laneSet]]),
  ...overrides,
});

const apply = (subject: BoardTask, change: Partial<PrUpdate>, overrides: Partial<CardContext> = {}) =>
  applyPrUpdate(subject, update(change), context(subject, overrides));

const moves = (subject: BoardTask | null) =>
  (subject?.history ?? []).flatMap(event => (event.type === 'moved' ? [[event.to, event.trigger, event.reason]] : []));
const notes = (subject: BoardTask | null) =>
  (subject?.history ?? []).flatMap(event => (event.type === 'note' ? [event.text] : []));

describe('samePr', () => {
  it('should match one PR in any case of its owner and repository, and nothing that is not a PR URL', () => {
    should(samePr(URL, 'https://github.com/KirinNee/Ferretry/pull/940')).be.true();
    should(samePr(URL, 'https://github.com/kirinnee/ferretry/pull/941')).be.false();
    should(samePr(URL, 'https://github.com/kirinnee/other/pull/940')).be.false();
    should(samePr(URL, 'not a url')).be.false();
  });
});

describe('applyPrUpdate', () => {
  it('should refuse anyone but the daemon', () => {
    const subject = withPr({});
    should(() => apply(subject, {}, { standing: 'owner', actor: { kind: 'ferret', sessionId: 'lead' } })).throw(
      BoardError,
    );
  });

  it('should change nothing when the poll learned nothing', () => {
    should(apply(withPr({}), {})).deepEqual({ task: null, nudges: [] });
    const fresh = withPr({ state: 'open', checks: 'pending', polledAt: NOW }, { laneId: 'review' });
    should(apply(fresh, { observed: [observed()] }).task).be.null();
  });

  it('should move a card to Review/CI when its PR opens, ready for review, with the trigger and reason recorded', () => {
    const { task } = apply(withPr({}), { observed: [observed()] });
    should(task?.laneId).equal('review');
    should(task?.links.prs[0]).match({ state: 'open', checks: 'pending', polledAt: NOW });
    should(moves(task)).deepEqual([['review', 'pr.opened', 'PR #940 opened']]);
    should(task?.history.at(-1)).match({ actor: { kind: 'daemon' }, auto: true });
  });

  it('should fire pr.opened for a draft and pr.ready once it leaves draft', () => {
    const draft = apply(withPr({}), { observed: [observed({ draft: true })] }).task as BoardTask;
    should(moves(draft)).deepEqual([['review', 'pr.opened', 'PR #940 opened']]);
    // Already in Review/CI, so ready moves nothing — but the cache records it.
    const ready = apply(draft, { observed: [observed()] }).task;
    should(ready?.links.prs[0]?.draft).be.false();
    should(moves(ready)).deepEqual(moves(draft));
    // A lane set whose ready lane is its own shows the trigger fire.
    const laneSet: LaneSet = {
      ...lanes(),
      lanes: lanes().lanes.map(lane =>
        lane.id === 'review'
          ? { ...lane, enterOn: ['pr.opened'] }
          : lane.id === 'merged'
            ? { ...lane, enterOn: ['pr.ready', 'pr.merged'] }
            : lane,
      ),
    };
    const later = applyPrUpdate(draft, update({ observed: [observed()] }), context(draft, {}, laneSet)).task;
    should(moves(later).at(-1)).deepEqual(['merged', 'pr.ready', 'PR #940 ready for review']);
  });

  it('should fire ci.green only when the checks turn green, for a lane set that uses it', () => {
    const laneSet: LaneSet = {
      ...lanes(),
      lanes: lanes().lanes.map(lane => (lane.id === 'merged' ? { ...lane, enterOn: ['ci.green', 'pr.merged'] } : lane)),
    };
    const open = withPr({ state: 'open', checks: 'pending', polledAt: NOW }, { laneId: 'review' });
    const green = applyPrUpdate(
      open,
      update({ observed: [observed({ checks: 'passing' })] }),
      context(open, {}, laneSet),
    );
    should(moves(green.task)).deepEqual([['merged', 'ci.green', 'PR #940 checks passed']]);
    const already = withPr({ state: 'open', checks: 'passing', polledAt: NOW }, { laneId: 'review' });
    should(
      applyPrUpdate(already, update({ observed: [observed({ checks: 'passing' })] }), context(already, {}, laneSet))
        .task,
    ).be.null();
  });

  it('should move a merged PR to Merged, caching the merge, and to Released when a release is found with it', () => {
    const open = withPr({ state: 'open', checks: 'passing', polledAt: NOW }, { laneId: 'review' });
    const { task } = apply(open, { observed: [merged()], releases: [{ url: URL, releasedIn: RELEASE }] });
    should(task?.links.prs[0]).match({ state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, releasedIn: RELEASE });
    should(moves(task)).deepEqual([
      ['merged', 'pr.merged', 'PR #940 merged'],
      ['released', 'release.published', 'PR #940 released in 4.110.0'],
    ]);
  });

  it('should take every trigger of one poll in the order a PR lives them, whatever order the links are in', () => {
    const second = 'https://github.com/kirinnee/ferretry/pull/941';
    const subject = card({
      laneId: 'implement',
      workflow: 'quick',
      links: { prs: [link({ url: second, number: 941 }), link()], branch: null, commits: [], docs: [] },
    });
    const { task } = apply(subject, { observed: [merged(), observed({ url: second })] });
    // #941 is still open beside the merged #940, so the facts end with the card back in review.
    should(moves(task)).deepEqual([
      ['review', 'pr.opened', 'PR #941 opened'],
      ['merged', 'pr.merged', 'PR #940 merged'],
      ['review', 'pr.ready', 'moved back to Review/CI: PR #941 ready for review'],
    ]);
  });

  it('should keep a card waiting at the To test gate for an open PR, and write down only the facts', () => {
    // A gate is passed only by the owner (docs/board.md § Gates ask the owner): the open PR is told on its gate item.
    const shipped = link({ state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, releasedIn: RELEASE, polledAt: NOW });
    const second = 'https://github.com/kirinnee/ferretry/pull/941';
    const subject = card({
      laneId: 'tested',
      workflow: 'quick',
      links: { prs: [shipped, link({ url: second, number: 941 })], branch: null, commits: [], docs: [] },
    });
    const { task } = apply(subject, {
      observed: [observed({ url: second, createdAt: '2026-10-30T10:00:00Z', checks: 'failing' })],
    });
    should(task?.laneId).equal('tested');
    should(task?.links.prs[1]).match({ state: 'open', createdAt: '2026-10-30T10:00:00Z' });
    should(moves(task)).be.empty();
    // The next poll agrees with the card: nothing more to write.
    should(
      applyPrUpdate(
        task as BoardTask,
        update({ observed: [observed({ url: second, createdAt: '2026-10-30T10:00:00Z', checks: 'failing' })] }),
        context(task as BoardTask),
      ).task,
    ).be.null();
  });

  it('should still pull a merged card back to review for an open PR where no gate holds it', () => {
    const shipped = link({ state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, polledAt: NOW });
    const second = 'https://github.com/kirinnee/ferretry/pull/939';
    const subject = card({
      laneId: 'merged',
      workflow: 'quick',
      links: { prs: [shipped, link({ url: second, number: 939 })], branch: null, commits: [], docs: [] },
    });
    const { task } = apply(subject, { observed: [observed({ url: second, createdAt: '2026-10-30T08:00:00Z' })] });
    should(task?.laneId).equal('review');
    should(task?.links.prs[1]?.createdAt).equal('2026-10-30T08:00:00Z');
    should(moves(task)).deepEqual([['review', 'pr.ready', 'moved back to Review/CI: PR #939 ready for review']]);
  });

  it('should learn when a cached PR was opened without changing anything else, and keep it when GitHub says nothing', () => {
    const subject = withPr({ state: 'open', checks: 'pending', polledAt: NOW }, { laneId: 'review' });
    const learned = apply(subject, { observed: [observed({ createdAt: '2026-10-30T08:00:00Z' })] }).task;
    should(learned?.links.prs[0]?.createdAt).equal('2026-10-30T08:00:00Z');
    should(moves(learned)).be.empty();
    const kept = apply(learned as BoardTask, { observed: [observed()] }).task;
    should(kept).be.null();
  });

  it('should fill a cached merge with its release later, and never rewrite a release once found', () => {
    const waiting = withPr(
      { state: 'merged', checks: 'passing', mergedAt: MERGED_AT, mergeSha: SHA, polledAt: NOW },
      { laneId: 'merged' },
    );
    const { task } = apply(waiting, { releases: [{ url: URL, releasedIn: RELEASE }] });
    should(task?.links.prs[0]?.releasedIn).deepEqual(RELEASE);
    should(task?.links.prs[0]?.polledAt).equal(NOW);
    should(moves(task).at(-1)).deepEqual(['released', 'release.published', 'PR #940 released in 4.110.0']);
    const later: ReleasedIn = { version: '4.111.0', tag: 'v4.111.0', at: NOW };
    const again = apply(task as BoardTask, { observed: [merged()], releases: [{ url: URL, releasedIn: later }] });
    should(again.task).be.null();
  });

  it('should not cache a release for a PR that is not merged', () => {
    should(apply(withPr({}), { releases: [{ url: URL, releasedIn: RELEASE }] }).task).be.null();
    const open = withPr({ state: 'open', checks: 'pending', polledAt: NOW }, { laneId: 'review' });
    should(apply(open, { observed: [observed()], releases: [{ url: URL, releasedIn: RELEASE }] }).task).be.null();
  });

  it('should move a released card to To test once this machine runs that release, and not before', () => {
    const released = withPr(
      { state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, releasedIn: RELEASE, polledAt: NOW },
      { laneId: 'released' },
    );
    should(apply(released, { runningVersion: '4.109.9' }).task).be.null();
    should(apply(released, { runningVersion: null }).task).be.null();
    const running = apply(released, { runningVersion: '4.110.0' }).task;
    should(moves(running)).deepEqual([
      ['tested', 'release.running', 'this machine runs 4.110.0, which includes 4.110.0'],
    ]);
    should(moves(apply(released, { runningVersion: '5.0.0' }).task)).have.length(1);
  });

  it('should fire release.running on the same poll that finds the release, when this machine already runs it', () => {
    const waiting = withPr(
      { state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, polledAt: NOW },
      { laneId: 'merged' },
    );
    const { task } = apply(waiting, { releases: [{ url: URL, releasedIn: RELEASE }], runningVersion: '4.114.0' });
    should(task?.laneId).equal('tested');
  });

  it('should never move a card the owner sent back, though its PR merged long ago', () => {
    const sentBack = withPr(
      { state: 'merged', checks: 'passing', mergedAt: MERGED_AT, mergeSha: SHA, releasedIn: RELEASE, polledAt: NOW },
      {
        laneId: 'implement',
        history: [
          { seq: 1, at: MERGED_AT, actor: { kind: 'daemon' }, type: 'created', laneId: 'implement' },
          {
            seq: 2,
            at: '2026-10-30T09:45:00Z',
            actor: { kind: 'owner' },
            type: 'moved',
            from: 'tested',
            to: 'implement',
            backward: true,
            reason: 'not good',
          },
        ],
      },
    );
    should(apply(sentBack, { observed: [merged()], runningVersion: '4.114.0' }).task).be.null();
  });

  it('should catch a stale card up to its facts on any poll, with no event to fire', () => {
    const merged940 = {
      state: 'merged',
      checks: 'passing',
      mergedAt: MERGED_AT,
      mergeSha: SHA,
      polledAt: NOW,
    } as const;
    const stale = withPr(merged940, { laneId: 'implement' });
    const caught = apply(stale, { observed: [merged()] }).task;
    should(moves(caught)).deepEqual([['merged', 'pr.merged', 'PR #940 merged']]);
    const released = withPr({ ...merged940, releasedIn: RELEASE }, { laneId: 'review' });
    should(moves(apply(released, {}).task)).deepEqual([
      ['released', 'release.published', 'PR #940 released in 4.110.0'],
    ]);
    should(moves(apply(released, { runningVersion: '4.110.0' }).task)).deepEqual([
      ['tested', 'release.running', 'this machine runs 4.110.0, which includes 4.110.0'],
    ]);
    const open = withPr({ state: 'open', checks: 'pending', polledAt: NOW }, { laneId: 'implement' });
    should(moves(apply(open, {}).task)).deepEqual([['review', 'pr.ready', 'PR #940 ready for review']]);
  });

  it('should never move a card out of the Plan or Design gate on a fact: only the owner passes it', () => {
    const planning = withPr({ state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, polledAt: NOW }, { laneId: 'plan' });
    const { task } = apply(planning, {});
    should(task === null || task.laneId === 'plan').be.true();
    should(moves(task)).be.empty();
  });

  it('should stop a fact at a gate on the way, and say so', () => {
    // A merged and released PR on a card still building: Released · to test is past nothing, but a gated lane
    // between the two stops it.
    const gated = lanes(PROJECT);
    const withReviewGate = {
      ...gated,
      lanes: gated.lanes.map(lane => (lane.id === 'review' ? { ...lane, ownerGate: true } : lane)),
    };
    const building = withPr(
      { state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, polledAt: NOW },
      { laneId: 'implement' },
    );
    const { task } = applyPrUpdate(building, update(), context(building, {}, withReviewGate));
    should(task?.laneId).equal('review');
    should(moves(task)).deepEqual([
      ['review', 'pr.merged', 'PR #940 merged; stopped at Review/CI, which waits for the owner'],
    ]);
  });

  it('should enter a closing lane on a fact only in a lane set with no To test lane', () => {
    const shipped = {
      state: 'merged',
      mergedAt: MERGED_AT,
      mergeSha: SHA,
      releasedIn: RELEASE,
      polledAt: NOW,
    } as const;
    const noVerify = lanes(PROJECT, 'pr-release');
    const closes = withPr(shipped, { laneId: 'review' });
    should(applyPrUpdate(closes, update(), context(closes, {}, noVerify)).task?.laneId).equal('released');
    const verify = withPr(shipped, { laneId: 'review' });
    should(apply(verify, { runningVersion: '4.110.0' }).task?.laneId).equal('tested');
    should(apply(withPr(shipped, { laneId: 'tested' }), { runningVersion: '4.110.0' }).task).be.null();
  });

  it('should never move backwards, but still record what GitHub said', () => {
    const tested = withPr({ state: 'open', checks: 'pending', polledAt: NOW }, { laneId: 'tested' });
    const { task } = apply(tested, { observed: [merged()] });
    should(task?.laneId).equal('tested');
    should(task?.links.prs[0]?.state).equal('merged');
  });

  it('should move a merged card even while it is blocked, and say what blocked it', () => {
    const blocker = card({ id: 'F18', laneId: 'implement' });
    const blocked = withPr(
      { state: 'open', checks: 'passing', polledAt: NOW },
      { id: 'F2', laneId: 'review', dependsOn: [{ task: { id: 'F18' }, until: 'shipped' }] },
    );
    const { task } = applyPrUpdate(
      blocked,
      update({ observed: [merged()] }),
      context(blocked, { index: new BoardIndex([blocker, blocked], 'machine-1') }),
    );
    should(moves(task)).deepEqual([['merged', 'pr.merged', 'PR #940 merged; pr.merged while blocked by &F18']]);
  });

  it('should not move a dropped card, but still record the facts', () => {
    const dropped = withPr({}, { dropped: { reason: 'superseded', at: NOW } });
    const { task } = apply(dropped, { observed: [merged()] });
    should(task?.laneId).equal('implement');
    should(task?.links.prs[0]?.state).equal('merged');
  });

  it('should note a PR closed unmerged and nudge the owner ferret, never moving the card back', () => {
    const open = withPr({ state: 'open', checks: 'pending', polledAt: NOW }, { laneId: 'review', assignee: 'child' });
    const { task, nudges } = apply(open, { observed: [observed({ state: 'closed' })] });
    should(task?.laneId).equal('review');
    should(notes(task)).deepEqual(['PR #940 was closed without merging']);
    should(nudges).deepEqual([
      {
        reason: 'closed-unmerged',
        sessionId: 'lead',
        message: '&F1 PR #940 was closed without merging. Reopen it, link its replacement, or drop the card.',
      },
    ]);
    should(apply(task as BoardTask, { observed: [observed({ state: 'closed' })] }).nudges).be.empty();
  });

  it('should nudge the assignee once when CI turns red, and keep the card in its lane', () => {
    const open = withPr({ state: 'open', checks: 'pending', polledAt: NOW }, { laneId: 'review', assignee: 'child' });
    const { task, nudges } = apply(open, { observed: [observed({ checks: 'failing' })] });
    should(task?.laneId).equal('review');
    should(task?.links.prs[0]?.checks).equal('failing');
    should(nudges).deepEqual([
      {
        reason: 'ci-failing',
        sessionId: 'child',
        message: '&F1 PR #940 CI is red. Fix it, or note on the card why it can stay red.',
      },
    ]);
    should(apply(task as BoardTask, { observed: [observed({ checks: 'failing' })] }).nudges).be.empty();
  });

  it('should refresh an unchanged PR label only once it is old, and leave an unobserved one alone', () => {
    const old = new Date(Date.parse(NOW) - PR_POLL_LABEL_REFRESH_MS).toISOString();
    const stale = withPr({ state: 'open', checks: 'pending', polledAt: old }, { laneId: 'review' });
    const { task } = apply(stale, { observed: [observed()] });
    should(task?.links.prs[0]?.polledAt).equal(NOW);
    should(task?.history).have.length(1);
    should(apply(stale, {}).task).be.null();
  });

  it('should link a PR a rule found, say why, and skip one already linked in any spelling', () => {
    const bare = card({ laneId: 'implement', workflow: 'quick' });
    const { task } = apply(bare, {
      link: [
        { url: URL, because: "its head branch feat/x is the card's branch" },
        { url: 'https://github.com/KirinNee/Ferretry/pull/940', because: 'again' },
        { url: 'https://example.com/not-a-pr', because: 'never' },
      ],
      observed: [observed()],
    });
    should(task?.links.prs.map(pr => pr.url)).deepEqual([URL]);
    should(task?.history.map(event => event.type)).deepEqual(['created', 'linked', 'note', 'moved']);
    should(notes(task)).deepEqual(["PR #940 linked automatically: its head branch feat/x is the card's branch"]);
    should(task?.laneId).equal('review');
  });

  it('should treat a lane it cannot find as no category, and move nothing on release.running', () => {
    const odd = withPr(
      { state: 'merged', mergedAt: MERGED_AT, mergeSha: SHA, releasedIn: RELEASE, polledAt: NOW },
      { laneId: 'gone' },
    );
    should(apply(odd, { runningVersion: '4.114.0' }).task).be.null();
  });
});

describe('BoardService.recordPullRequests', () => {
  it('should write the card once as the daemon and publish board.changed, handing the nudges back', async () => {
    const ports = world({
      store: new MemoryBoardStore([withPr({ state: 'open', polledAt: NOW }, { laneId: 'review' })]),
    });
    const service = new BoardService(ports);
    const outcome = await service.recordPullRequests('F1', update({ observed: [observed({ state: 'closed' })] }));
    should(outcome.nudges).have.length(1);
    should(ports.store.writes).have.length(1);
    should(ports.changes.events).deepEqual([{ sessionId: 'lead', event: { projectId: PROJECT, taskIds: ['F1'] } }]);
  });

  it('should write nothing and publish nothing when nothing changed', async () => {
    const ports = world({ store: new MemoryBoardStore([withPr({})]) });
    const outcome = await new BoardService(ports).recordPullRequests('F1', update());
    should(outcome).deepEqual({ task: null, nudges: [] });
    should(ports.store.writes).be.empty();
    should(ports.changes.events).be.empty();
  });

  it('should refuse a card that is not there', async () => {
    await should(new BoardService(world()).recordPullRequests('F9', update())).be.rejectedWith(BoardError);
  });

  it('should read every card with its board lanes in one snapshot', async () => {
    const ports = world({ store: new MemoryBoardStore([card()]) });
    const snapshot = await new BoardService(ports).snapshot();
    should(snapshot.cards.map(entry => entry.id)).deepEqual(['F1']);
    should([...snapshot.laneSets.keys()]).deepEqual([PROJECT]);
  });
});
