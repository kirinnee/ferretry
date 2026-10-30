import { describe, it } from 'bun:test';
import {
  type BoardProjectId,
  type BoardTask,
  type LaneSet,
  MAX_BOARD_BRIEF_LENGTH,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import should from 'should';
import {
  askOf,
  BoardService,
  cardFooterLine,
  cardTitle,
  type QuietItem,
  type SessionCardFacts,
  SessionCards,
  type SessionCardsPorts,
} from '../../../src/lib/board/index.ts';
import {
  card,
  FakeFocus,
  FakeLanes,
  FakeParents,
  lanes,
  MemoryBoardStore,
  NOW,
  OTHER_PROJECT,
  PROJECT,
  type ServiceWorld,
  world,
} from './support.ts';

const BARE_PROJECT = '33333333-3333-4333-8333-333333333333';
const NAMES: Readonly<Record<string, string>> = {
  [PROJECT]: 'Ferretry',
  [OTHER_PROJECT]: 'Home',
  [BARE_PROJECT]: 'Notes',
  [UNFILED_PROJECT_ID]: 'Unfiled',
};

interface Options {
  readonly cards?: readonly BoardTask[];
  /** Where each session works; absent means PROJECT. */
  readonly projects?: Readonly<Record<string, BoardProjectId>>;
  readonly facts?: Readonly<Record<string, SessionCardFacts>>;
  /** What a proposal answers; absent proposes nothing. */
  readonly proposed?: LaneSet | 'fail';
  readonly pendingFails?: boolean;
  readonly world?: Partial<ServiceWorld>;
}

const build = (options: Options = {}) => {
  const lanesSource = new FakeLanes(
    new Map([
      [PROJECT, lanes(PROJECT)],
      [OTHER_PROJECT, lanes(OTHER_PROJECT, 'pr')],
      [UNFILED_PROJECT_ID, lanes(UNFILED_PROJECT_ID, 'quick')],
    ]),
    new Map(Object.entries(options.projects ?? {})),
  );
  const focus = new FakeFocus();
  const ports = world({
    store: new MemoryBoardStore(options.cards ?? []),
    lanes: lanesSource,
    focus,
    ...options.world,
  });
  const board = new BoardService(ports);
  const proposals: Array<readonly [BoardProjectId, string]> = [];
  const pending: Array<readonly [string, readonly QuietItem[]]> = [];
  const warnings: string[] = [];
  const cardsPorts: SessionCardsPorts = {
    board,
    lanes: lanesSource,
    proposer: {
      propose: async (projectId, sessionId) => {
        proposals.push([projectId, sessionId]);
        if (options.proposed === 'fail') throw new Error('the lane store is read-only');
        return options.proposed ?? null;
      },
    },
    projects: { nameOf: async projectId => NAMES[projectId] ?? projectId },
    focus,
    parents: new FakeParents({ child: 'lead' }),
    sessions: { facts: async sessionId => options.facts?.[sessionId] },
    pending: {
      append: async (sessionId, items) => {
        if (options.pendingFails === true) throw new Error('pending context is full');
        pending.push([sessionId, items]);
      },
    },
    clock: { now: () => NOW },
    diagnostics: { warn: message => warnings.push(message) },
    bin: 'fy',
  };
  return { subject: new SessionCards(cardsPorts), ports, focus, proposals, pending, warnings };
};

const stored = (ports: ServiceWorld, id: string): BoardTask => ports.store.cards.get(id) as BoardTask;

describe('what a start card is called and asks', () => {
  it("should take the session's name, else the brief's own title", () => {
    // Act / Assert
    should(cardTitle('board-u7 spawn and signal cards now please', 'ignored')).equal('board-u7 Spawn and Signal Cards');
    should(cardTitle(undefined, '# Fix the tunnel credit burst\nmore')).equal('Fix the Tunnel Credit Burst');
    should(cardTitle(undefined, 'You are a ferret.')).match(/^Task [0-9a-z]{4}$/u);
  });

  it('should keep the ask verbatim, cut only at the field', () => {
    // Act / Assert
    should(askOf('  exactly this  ', 'owner')).deepEqual({ text: '  exactly this  ', source: 'owner' });
    should(askOf('z'.repeat(MAX_BOARD_BRIEF_LENGTH + 1), 'owner').text.length).equal(MAX_BOARD_BRIEF_LENGTH);
  });

  it('should name the card and its board in the footer line', () => {
    // Act / Assert
    should(cardFooterLine('F413', 'Ferretry', 'fy')).equal(
      'Your card is &F413 on the Ferretry board; move it as you work (`fy task …`).',
    );
    should(cardFooterLine('F413', undefined, 'ferret')).equal(
      "Your card is &F413 on the project's board; move it as you work (`ferret task …`).",
    );
  });
});

describe('a session started with a brief', () => {
  it('should get its own card in the first backlog lane, asked by the owner, and be focused on it', async () => {
    // Arrange
    const { subject, ports, focus } = build();

    // Act
    const opened = await subject.open({ sessionId: 'worker', name: 'Theme switch', brief: 'Move the theme switch' });

    // Assert
    should(opened.notes).be.empty();
    should(opened.project).equal('Ferretry');
    should(stored(ports, 'F1')).match({
      title: 'Theme Switch',
      brief: 'Move the theme switch',
      ask: { text: 'Move the theme switch', source: 'owner' },
      owner: 'worker',
      assignee: null,
      parent: null,
      laneId: 'todo',
      projectId: PROJECT,
      workflow: 'quick',
    });
    should(focus.focused.get('worker')).deepEqual({ id: 'F1' });
  });

  it('should say a ferret asked when a ferret started it', async () => {
    // Arrange
    const { subject, ports } = build();

    // Act
    await subject.open({ sessionId: 'child', brief: 'Survey the agenda', parent: 'lead' });

    // Assert
    should(stored(ports, 'F1').ask).deepEqual({ text: 'Survey the agenda', source: 'session:lead' });
  });

  it("should put a fy new's card under the lead's focus card, owned by the lead and worked by the child", async () => {
    // Arrange
    const { subject, ports, focus } = build({ cards: [card({ id: 'F1', owner: 'lead', laneId: 'implement' })] });
    focus.focused.set('lead', { id: 'F1' });

    // Act
    const { delegation } = await subject.delegate('lead', 'Build the board store', true);
    const opened = await subject.open({
      sessionId: 'child',
      brief: 'Build the board store\n\n---\nfooter',
      parent: 'lead',
      delegation,
    });

    // Assert
    should(delegation).deepEqual({
      lead: 'lead',
      brief: 'Build the board store',
      id: 'F2',
      parent: { id: 'F1' },
      project: 'Ferretry',
      notes: [],
    });
    should(opened.card).match({
      id: 'F2',
      owner: 'lead',
      assignee: 'child',
      parent: { id: 'F1' },
      brief: 'Build the board store',
      ask: { text: 'Build the board store', source: 'session:lead' },
    });
    should(focus.focused.get('child')).deepEqual({ id: 'F2' });
    should(focus.focused.get('lead')).deepEqual({ id: 'F1' });
    should(stored(ports, 'F2').createdBy).deepEqual({ kind: 'daemon', sessionId: 'lead' });
  });

  it('should make the lead a card from its own session first when it has none, and say so', async () => {
    // Arrange
    const { subject, ports, focus } = build({
      facts: { lead: { name: 'Board design', prompt: 'design it', latestOwnerMessage: 'flesh out the board' } },
    });

    // Act
    const { delegation, notes } = await subject.delegate('lead', 'Build it', true);

    // Assert
    should(delegation).match({ id: 'F2', parent: { id: 'F1' }, leadCard: 'F1' });
    should(notes).deepEqual([
      'You had no card, so &F1 was made for you from your session ("Board Design") on the Ferretry board; your sub-ferret\'s card sits under it.',
    ]);
    should(stored(ports, 'F1')).match({
      title: 'Board Design',
      owner: 'lead',
      assignee: null,
      brief: 'design it',
      ask: { text: 'flesh out the board', source: 'owner' },
    });
    should(focus.focused.get('lead')).deepEqual({ id: 'F1' });
  });

  it("should ask with the lead's own brief, else its title, when no owner message was recorded", async () => {
    // Arrange
    const briefed = build({ facts: { lead: { prompt: 'Survey the boards', parent: 'root' } } });
    const bare = build({ facts: { lead: { name: 'Quick chat' } } });

    // Act
    await briefed.subject.delegate('lead', 'x', true);
    await bare.subject.delegate('lead', 'x', true);

    // Assert
    should(stored(briefed.ports, 'F1').ask).deepEqual({ text: 'Survey the boards', source: 'session:root' });
    should(stored(bare.ports, 'F1').ask).deepEqual({ text: 'Quick Chat', source: 'owner' });
  });

  it('should make no card for a lead the daemon does not hold, and not name a board a named folder may miss', async () => {
    // Arrange
    const unknown = build();
    const focused = build({ cards: [card({ id: 'F1', owner: 'lead' })] });
    focused.focus.focused.set('lead', { id: 'F1' });

    // Act
    const none = await unknown.subject.delegate('ghost', 'x', true);
    const elsewhere = await focused.subject.delegate('lead', 'x', false);

    // Assert
    should(none).deepEqual({ notes: ['there is no session ghost to make a card for'] });
    should(elsewhere.delegation).not.have.property('project');
  });

  it('should say where the card really is when the child runs on another board than the brief said', async () => {
    // Arrange
    const { subject, focus } = build({
      cards: [card({ id: 'F1', owner: 'lead' })],
      projects: { child: OTHER_PROJECT },
    });
    focus.focused.set('lead', { id: 'F1' });
    const { delegation } = await subject.delegate('lead', 'x', true);

    // Act
    const opened = await subject.open({ sessionId: 'child', brief: 'x', parent: 'lead', delegation });

    // Assert
    should(opened.card?.projectId).equal(OTHER_PROJECT);
    should(opened.notes).deepEqual([
      'The brief said &F2 is on the Ferretry board; it is on the Home board, where the sub-ferret runs.',
    ]);
  });

  it('should propose lanes as the card owner for a project that has none, and land the card on its board', async () => {
    // Arrange: the project has lanes only once they are proposed.
    let proposedYet = false;
    const proposals: Array<readonly [BoardProjectId, string]> = [];
    const stored = new FakeLanes(
      new Map([[BARE_PROJECT, lanes(BARE_PROJECT, 'pr')]]),
      new Map([['worker', BARE_PROJECT]]),
    );
    const projectLanes = {
      projectOf: async (sessionId: string) => await stored.projectOf(sessionId),
      laneSet: async (projectId: BoardProjectId) => (proposedYet ? await stored.laneSet(projectId) : null),
    };
    const subject = new SessionCards({
      board: new BoardService(world({ lanes: projectLanes })),
      lanes: projectLanes,
      proposer: {
        propose: async (projectId, sessionId) => {
          proposals.push([projectId, sessionId]);
          proposedYet = true;
          return lanes(BARE_PROJECT, 'pr');
        },
      },
      projects: { nameOf: async projectId => NAMES[projectId] ?? projectId },
      focus: new FakeFocus(),
      parents: new FakeParents(),
      sessions: { facts: async () => undefined },
      pending: { append: async () => undefined },
      clock: { now: () => NOW },
      diagnostics: { warn: () => undefined },
      bin: 'fy',
    });

    // Act
    const opened = await subject.open({ sessionId: 'worker', brief: 'write notes' });

    // Assert
    should(proposals).deepEqual([[BARE_PROJECT, 'worker']]);
    should(opened.card?.projectId).equal(BARE_PROJECT);
    should(opened.notes).deepEqual([
      'Notes had no lanes, so they were proposed for the owner to confirm (an agenda choice).',
    ]);
  });

  it('should fall back to the Unfiled board, saying how to move the card, when proposing fails', async () => {
    // Arrange
    const quiet = build({ projects: { worker: BARE_PROJECT } });
    const failing = build({ projects: { worker: BARE_PROJECT }, proposed: 'fail' });

    // Act
    const opened = await quiet.subject.open({ sessionId: 'worker', brief: 'write notes' });
    const afterFailure = await failing.subject.open({ sessionId: 'worker', brief: 'write notes' });

    // Assert
    const hint =
      'Notes has no lanes yet, so the card is on the Unfiled board: propose them with `fy board lanes propose --template <template>`, then refile the card to Notes.';
    should(opened.card?.projectId).equal(UNFILED_PROJECT_ID);
    should(opened.notes).deepEqual([hint]);
    should(quiet.warnings).deepEqual([`&F1: ${hint}`]);
    should(afterFailure.card?.projectId).equal(UNFILED_PROJECT_ID);
    should(failing.warnings[0]).equal('could not propose lanes for Notes: the lane store is read-only');
  });

  it('should never fail a start: a board failure is a note', async () => {
    // Arrange
    const { subject, focus, warnings } = build({ world: { machineId: () => undefined } });
    focus.focused.set('lead', { id: 'F1' });

    // Act
    const opened = await subject.open({ sessionId: 'worker', brief: 'x' });
    const delegated = await subject.delegate('lead', 'x', true);

    // Assert
    should(opened.card).be.undefined();
    should(opened.notes[0]).startWith('No card was made for worker:');
    should(delegated.delegation).be.undefined();
    should(delegated.notes[0]).startWith('No card was made for the sub-ferret:');
    should(warnings).have.length(2);
  });
});

describe("a ferret's done on the board", () => {
  it("should tell the card's owner, when it is the lead, through its pending context", async () => {
    // Arrange
    const { subject, ports, focus, pending } = build({
      cards: [card({ id: 'F2', owner: 'lead', assignee: 'child', laneId: 'implement', workflow: 'quick' })],
    });
    focus.focused.set('child', { id: 'F2' });

    // Act
    const outcome = await subject.signalled('child', 'shipped it');

    // Assert
    should(outcome?.moved?.id).equal('review');
    should(stored(ports, 'F2').laneId).equal('review');
    should(pending).deepEqual([['lead', [{ key: 'F2:done', text: '&F2 → Review/CI · done: shipped it', at: NOW }]]]);
  });

  it("should tell the session's own parent when it owns its card, and nobody when it has none", async () => {
    // Arrange
    const owned = build({ cards: [card({ id: 'F2', owner: 'child', laneId: 'todo' })] });
    owned.focus.focused.set('child', { id: 'F2' });
    const top = build({ cards: [card({ id: 'F1', owner: 'lead', laneId: 'todo' })] });
    top.focus.focused.set('lead', { id: 'F1' });

    // Act
    await owned.subject.signalled('child', undefined);
    await top.subject.signalled('lead', 'done');

    // Assert
    should(owned.pending).deepEqual([['lead', [{ key: 'F2:done', text: '&F2 signalled done', at: NOW }]]]);
    should(top.pending).be.empty();
  });

  it('should never fail the signal: no card, a refused write or a lost quiet line is only said', async () => {
    // Arrange
    const none = build();
    const refused = build({ cards: [card({ id: 'F1', owner: 'lead' })] });
    refused.focus.focused.set('stranger', { id: 'F1' });
    const lost = build({ cards: [card({ id: 'F2', owner: 'lead', assignee: 'child' })], pendingFails: true });
    lost.focus.focused.set('child', { id: 'F2' });

    // Act
    const nothing = await none.subject.signalled('child', 'done');
    const forbidden = await refused.subject.signalled('stranger', 'done');
    const told = await lost.subject.signalled('child', 'done');

    // Assert
    should(nothing).be.null();
    should(forbidden).be.null();
    should(refused.warnings[0]).startWith("could not record stranger's done on its card: only");
    should(told?.task.id).equal('F2');
    should(lost.warnings).deepEqual(['could not tell lead that &F2 is done: pending context is full']);
  });
});
