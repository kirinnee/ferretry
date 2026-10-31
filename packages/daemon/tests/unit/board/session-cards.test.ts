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
  type DelegationRequest,
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
  /** What a proposal answers; absent proposes nothing. */
  readonly proposed?: LaneSet | 'fail';
  readonly world?: Partial<ServiceWorld>;
  readonly adoption?: SessionCardsPorts['adoption'];
  /** The board refuses to move a card on the session's start. */
  readonly failTrigger?: boolean;
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
  const service = new BoardService(ports);
  const board: SessionCardsPorts['board'] =
    options.failTrigger === true
      ? {
          reserve: service.reserve.bind(service),
          spawn: service.spawn.bind(service),
          signalDone: service.signalDone.bind(service),
          snapshot: service.snapshot.bind(service),
          requireHandOver: service.requireHandOver.bind(service),
          handOver: service.handOver.bind(service),
          trigger: async () => {
            throw new Error('the board store is read-only');
          },
        }
      : service;
  const proposals: Array<readonly [BoardProjectId, string]> = [];
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
    diagnostics: { warn: message => warnings.push(message) },
    bin: 'fy',
    ...(options.adoption === undefined ? {} : { adoption: options.adoption }),
  };
  return { subject: new SessionCards(cardsPorts), ports, focus, proposals, warnings };
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
      'Your card is &F413 on the Ferretry board; the daemon moves it for you (`fy task note` adds progress).',
    );
    should(cardFooterLine('F413', 'Ferretry', 'fy', { id: 'F85' })).equal(
      'Your card is &F413 on the Ferretry board, under &F85; the daemon moves it for you (`fy task note` adds progress).',
    );
    should(cardFooterLine('F413', undefined, 'ferret')).equal(
      "Your card is &F413 on the project's board; the daemon moves it for you (`ferret task note` adds progress).",
    );
  });
});

describe('a session started with a brief', () => {
  it('should get its own card, asked by the owner, focused, and already in the lane work starts in', async () => {
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
      laneId: 'implement',
      projectId: PROJECT,
      workflow: 'quick',
    });
    should(opened.card).match({ id: 'F1', laneId: 'implement' });
    should(stored(ports, 'F1').history.at(-1)).match({
      type: 'moved',
      from: 'todo',
      to: 'implement',
      auto: true,
      trigger: 'work.started',
      actor: { kind: 'daemon', sessionId: 'worker' },
    });
    should(focus.focused.get('worker')).deepEqual({ id: 'F1' });
  });

  it('should keep the card in its first lane, say so, and still start when the move cannot be made', async () => {
    // Arrange
    const { subject, ports, warnings } = build({ failTrigger: true });

    // Act
    const opened = await subject.open({ sessionId: 'worker', brief: 'Move the theme switch' });

    // Assert
    should(opened.card).match({ id: 'F1', laneId: 'todo' });
    should(stored(ports, 'F1').laneId).equal('todo');
    should(warnings).deepEqual(['could not move &F1 to its working lane: the board store is read-only']);
  });

  it('should not pull a card back that is already past the lane work starts in', async () => {
    // Arrange
    const { subject, ports } = build({
      cards: [card({ id: 'F9', owner: 'lead', workflow: 'quick', laneId: 'merged' })],
    });
    const { delegation } = await subject.delegate('lead', { brief: 'Build it', card: 'F9' }, true);

    // Act
    const opened = await subject.open({ sessionId: 'child', brief: 'Build it', parent: 'lead', delegation });

    // Assert
    should(opened.card).match({ id: 'F9', laneId: 'merged' });
    should(stored(ports, 'F9').history.some(event => event.type === 'moved')).be.false();
  });

  it('should say a ferret asked when a ferret started it', async () => {
    // Arrange
    const { subject, ports } = build();

    // Act
    await subject.open({ sessionId: 'child', brief: 'Survey the agenda', parent: 'lead' });

    // Assert
    should(stored(ports, 'F1').ask).deepEqual({ text: 'Survey the agenda', source: 'session:lead' });
  });

  describe('the parent of the card a fy new makes', () => {
    const delegate = (subject: SessionCards, brief: string, extra: Partial<DelegationRequest> = {}) =>
      subject.delegate('lead', { brief, name: 'Build the board store', ...extra }, true);

    it("should put the card under the lead's anchor, owned by the lead and worked by the child", async () => {
      // Arrange
      const { subject, ports, focus } = build({ cards: [card({ id: 'F1', owner: 'lead', laneId: 'implement' })] });
      focus.anchors.set('lead', { id: 'F1' });
      focus.focused.set('lead', { id: 'F1' });

      // Act
      const { delegation } = await delegate(subject, 'Build the board store');
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
        existing: false,
        parent: { id: 'F1' },
        parentFrom: 'focus',
        project: 'Ferretry',
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
      should(focus.anchors.get('child')).deepEqual({ id: 'F2' });
      should(focus.focused.get('lead')).deepEqual({ id: 'F1' });
      should(stored(ports, 'F2').createdBy).deepEqual({ kind: 'daemon', sessionId: 'lead' });
    });

    it("should prefer the card the brief names over the lead's anchor", async () => {
      // Arrange
      const { subject, focus } = build({
        cards: [card({ id: 'F1', owner: 'lead' }), card({ id: 'F138', owner: 'lead' })],
      });
      focus.anchors.set('lead', { id: 'F1' });

      // Act
      const { delegation, notes } = await delegate(subject, 'Your card is &F138. Build the thing; see also &F1.');

      // Assert
      should(delegation).match({ parent: { id: 'F138' }, parentFrom: 'brief' });
      should(notes).be.empty();
    });

    it('should use the anchor when the brief names no card, and when the card it names is gone or dropped', async () => {
      // Arrange
      const { subject, focus } = build({
        cards: [
          card({ id: 'F1', owner: 'lead' }),
          card({ id: 'F7', owner: 'lead', dropped: { at: NOW, reason: 'x' } }),
        ],
      });
      focus.anchors.set('lead', { id: 'F1' });

      // Act
      const plain = await delegate(subject, 'Build the board store');
      const missing = await delegate(subject, 'see &F99 for background');
      const dropped = await delegate(subject, 'see &F7 for background');

      // Assert
      should(plain.delegation).match({ parent: { id: 'F1' }, parentFrom: 'focus' });
      should(missing.delegation).match({ parent: { id: 'F1' }, parentFrom: 'focus' });
      should(dropped.delegation).match({ parent: { id: 'F1' }, parentFrom: 'focus' });
    });

    it('should never use a card the lead merely touched last: no anchor means a top-level card, said once', async () => {
      // Arrange
      const { subject, ports, focus } = build({ cards: [card({ id: 'F1', owner: 'lead' })] });
      focus.focused.set('lead', { id: 'F1' });

      // Act
      const { delegation, notes } = await delegate(subject, 'Build the board store');
      const opened = await subject.open({ sessionId: 'child', brief: 'x', parent: 'lead', delegation });

      // Assert
      should(delegation?.parent).be.null();
      should(delegation).not.have.property('parentFrom');
      should(notes).deepEqual([
        "The sub-ferret's card has no parent, so it is at the top level of the board: `fy task reparent &F2 --parent <id>` moves it, and `fy task focus <id>` (or `--card <id>`) says where your sub-ferrets' cards go next time.",
      ]);
      should(opened.card?.parent).be.null();
      should(stored(ports, 'F2').parent).be.null();
    });

    it('should set an anchor only by choice: a focus, a create or a start does; a note does not', async () => {
      // Arrange
      const { ports, focus } = build({ cards: [card({ id: 'F1', owner: 'lead', assignee: null })] });
      const board = new BoardService({ ...ports, parents: new FakeParents({ child: 'lead' }) });
      const lead = { kind: 'ferret', sessionId: 'lead' } as const;

      // Act
      await board.act('F1', { action: 'note', text: 'a thought' }, lead);
      const touched = await focus.anchorOf('lead');
      await board.act('F1', { action: 'focus' }, lead);
      const focused = await focus.anchorOf('lead');

      // Assert
      should(touched).be.null();
      should(focused).deepEqual({ id: 'F1' });
    });
  });

  describe('a fy new that must not twin a card', () => {
    const request = { brief: 'Build the board store', name: 'build the board store!' };

    it("should assign the lead's own open card with the same title instead of making a second", async () => {
      // Arrange
      const { subject, ports, focus } = build({
        cards: [card({ id: 'F5', owner: 'lead', title: 'Build the Board Store', parent: { id: 'F1' } })],
      });

      // Act
      const { delegation, notes } = await subject.delegate('lead', request, true);
      const opened = await subject.open({ sessionId: 'child', brief: 'x', parent: 'lead', delegation });

      // Assert
      should(delegation).deepEqual({
        lead: 'lead',
        brief: 'Build the board store',
        id: 'F5',
        existing: true,
        parent: { id: 'F1' },
        project: 'Ferretry',
      });
      should(notes[0]).startWith('You already had &F5 ("Build the Board Store")');
      should(opened.card).match({ id: 'F5', owner: 'lead', assignee: 'child' });
      should([...ports.store.cards.keys()]).deepEqual(['F5']);
      should(focus.focused.get('child')).deepEqual({ id: 'F5' });
      should(focus.anchors.get('child')).deepEqual({ id: 'F5' });
      should(focus.focused.has('lead')).be.false();
    });

    it("should not reuse a card that is someone else's, already worked, closed, dropped or on another board", async () => {
      // Arrange
      const title = 'Build the Board Store';
      const { subject } = build({
        cards: [
          card({ id: 'F2', owner: 'stranger', title }),
          card({ id: 'F3', owner: 'lead', assignee: 'worker', title }),
          card({ id: 'F4', owner: 'lead', title, laneId: 'closed' }),
          card({ id: 'F5', owner: 'lead', title, dropped: { at: NOW, reason: 'x' } }),
          card({ id: 'F6', owner: 'lead', title, projectId: OTHER_PROJECT, laneId: 'todo' }),
        ],
      });

      // Act
      const { delegation } = await subject.delegate('lead', request, true);

      // Assert
      should(delegation).match({ id: 'F7', existing: false });
    });

    it('should not look for a twin when the child runs in another folder', async () => {
      // Arrange
      const { subject } = build({ cards: [card({ id: 'F5', owner: 'lead', title: 'Build the Board Store' })] });

      // Act
      const { delegation } = await subject.delegate('lead', request, false);

      // Assert
      should(delegation).match({ id: 'F6', existing: false });
    });
  });

  describe('a fy new --card', () => {
    it("should assign the lead's existing card to the child, keep its owner and parent, and make no second card", async () => {
      // Arrange
      const { subject, ports, focus } = build({
        cards: [
          card({ id: 'F9', owner: 'lead', title: 'Something else', parent: { id: 'F1' } }),
          card({ id: 'F1', owner: 'lead' }),
        ],
      });
      focus.focused.set('lead', { id: 'F1' });

      // Act
      const { delegation, refusal } = await subject.delegate('lead', { brief: 'Build it', card: 'F9' }, true);
      const opened = await subject.open({ sessionId: 'child', brief: 'Build it', parent: 'lead', delegation });

      // Assert
      should(refusal).be.undefined();
      should(delegation).match({ id: 'F9', existing: true, parent: { id: 'F1' }, project: 'Ferretry' });
      should(opened.card).match({ id: 'F9', owner: 'lead', assignee: 'child', title: 'Something else' });
      should(stored(ports, 'F9').history.find(event => event.type === 'assigned')).match({ to: 'child' });
      should(stored(ports, 'F9').history.at(-1)).match({
        type: 'moved',
        from: 'todo',
        to: 'plan',
        auto: true,
        trigger: 'work.started',
        actor: { kind: 'daemon', sessionId: 'child' },
      });
      should(opened.card).match({ laneId: 'plan' });
      should([...ports.store.cards.keys()].sort()).deepEqual(['F1', 'F9']);
      should(focus.focused.get('child')).deepEqual({ id: 'F9' });
      should(focus.anchors.get('child')).deepEqual({ id: 'F9' });
      should(focus.focused.get('lead')).deepEqual({ id: 'F1' });
    });

    it("should refuse, not start without a card, when the card is missing, dropped or not the lead's to give", async () => {
      // Arrange
      const { subject, ports } = build({
        cards: [
          card({ id: 'F2', owner: 'stranger', assignee: 'stranger' }),
          card({ id: 'F3', owner: 'lead', dropped: { at: NOW, reason: 'x' } }),
        ],
      });

      // Act
      const missing = await subject.delegate('lead', { brief: 'x', card: 'F99' }, true);
      const foreign = await subject.delegate('lead', { brief: 'x', card: 'F2' }, true);
      const dropped = await subject.delegate('lead', { brief: 'x', card: 'F3' }, true);

      // Assert
      should(missing.refusal).match(/no card &F99/u);
      should(foreign.refusal).be.a.String();
      should(dropped.refusal).match(/&F3 is dropped/u);
      should(missing.delegation).be.undefined();
      should(ports.store.writes).be.empty();
    });
  });

  it('should start without a card, and say why, when the card cannot be read', async () => {
    // Arrange
    const store = new MemoryBoardStore([card({ id: 'F9', owner: 'lead' })]);
    store.read = async () => {
      throw new TypeError('the board is unreadable');
    };
    const { subject } = build({ world: { store } });

    // Act
    const outcome = await subject.delegate('lead', { brief: 'x', card: 'F9' }, true);

    // Assert
    should(outcome.delegation).be.undefined();
    should(outcome.refusal).be.undefined();
    should(outcome.notes).deepEqual(['No card was made for the sub-ferret: the board is unreadable']);
  });

  it('should say where the card really is when the child runs on another board than the brief said', async () => {
    // Arrange
    const { subject, focus } = build({
      cards: [card({ id: 'F1', owner: 'lead' })],
      projects: { child: OTHER_PROJECT },
    });
    focus.anchors.set('lead', { id: 'F1' });
    const { delegation } = await subject.delegate('lead', { brief: 'x' }, true);

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

  it('should put the card of a start on the Unfiled board on the board of the repository it registers', async () => {
    // Arrange
    const adopted: string[] = [];
    const adoption = (proposed: boolean): SessionCardsPorts['adoption'] => ({
      adopt: async (sessionId, proposer) => {
        adopted.push(`${sessionId}:${proposer ?? sessionId}`);
        return { projectId: OTHER_PROJECT, proposed };
      },
    });
    const fresh = build({ projects: { worker: UNFILED_PROJECT_ID }, adoption: adoption(true) });
    const known = build({ projects: { worker: UNFILED_PROJECT_ID }, adoption: adoption(false) });

    // Act
    const opened = await fresh.subject.open({ sessionId: 'worker', brief: 'write notes' });
    const again = await known.subject.open({ sessionId: 'worker', brief: 'write notes' });

    // Assert
    should(adopted).deepEqual(['worker:worker', 'worker:worker']);
    should(opened.card?.projectId).equal(OTHER_PROJECT);
    should(opened.notes).deepEqual([
      'Home was registered as a project, so the card is on its board; its lanes were proposed for the owner to confirm (an agenda choice).',
    ]);
    should(again.notes).deepEqual(['Home was registered as a project, so the card is on its board.']);
    should(fresh.proposals).be.empty();
  });

  it('should keep a start on its board when registering does nothing or fails, and never ask for a filed one', async () => {
    // Arrange
    const asked: string[] = [];
    const recording = (prefix: string): SessionCardsPorts['adoption'] => ({
      adopt: async sessionId => {
        asked.push(`${prefix}${sessionId}`);
        return null;
      },
    });
    const nothing = build({
      projects: { worker: UNFILED_PROJECT_ID },
      adoption: recording(''),
    });
    const failing = build({
      projects: { worker: UNFILED_PROJECT_ID },
      adoption: { adopt: () => Promise.reject(new Error('registry is damaged')) },
    });
    const filed = build({ adoption: recording('filed:') });

    // Act
    const kept = await nothing.subject.open({ sessionId: 'worker', brief: 'x' });
    const fallen = await failing.subject.open({ sessionId: 'worker', brief: 'x' });
    const onBoard = await filed.subject.open({ sessionId: 'worker', brief: 'x' });

    // Assert
    should([kept.card?.projectId, fallen.card?.projectId, onBoard.card?.projectId]).deepEqual([
      UNFILED_PROJECT_ID,
      UNFILED_PROJECT_ID,
      PROJECT,
    ]);
    should(asked).deepEqual(['worker']);
    should(failing.warnings).containEql('could not register the repository of worker: registry is damaged');
  });

  it('should never fail a start: a board failure is a note', async () => {
    // Arrange
    const { subject, focus, warnings } = build({ world: { machineId: () => undefined } });
    focus.focused.set('lead', { id: 'F1' });

    // Act
    const opened = await subject.open({ sessionId: 'worker', brief: 'x' });
    const delegated = await subject.delegate('lead', { brief: 'x' }, true);

    // Assert
    should(opened.card).be.undefined();
    should(opened.notes[0]).startWith('No card was made for worker:');
    should(delegated.delegation).be.undefined();
    should(delegated.notes[0]).startWith('No card was made for the sub-ferret:');
    should(warnings).have.length(2);
  });
});

describe("a ferret's done on the board", () => {
  it('should note it and move the card, and tell nobody: the done reaches the lead through fy wait', async () => {
    // Arrange
    const { subject, ports, focus, warnings } = build({
      cards: [card({ id: 'F2', owner: 'lead', assignee: 'child', laneId: 'implement', workflow: 'quick' })],
    });
    focus.focused.set('child', { id: 'F2' });

    // Act
    const outcome = await subject.signalled('child', 'shipped it');

    // Assert
    should(outcome?.moved?.id).equal('review');
    should(stored(ports, 'F2').laneId).equal('review');
    should(stored(ports, 'F2').history.map(event => event.type)).containDeep(['note', 'moved']);
    should(warnings).be.empty();
  });

  it('should never fail the signal: no card or a refused write is only said', async () => {
    // Arrange
    const none = build();
    const refused = build({ cards: [card({ id: 'F1', owner: 'lead' })] });
    refused.focus.focused.set('stranger', { id: 'F1' });

    // Act
    const nothing = await none.subject.signalled('child', 'done');
    const forbidden = await refused.subject.signalled('stranger', 'done');

    // Assert
    should(nothing).be.null();
    should(forbidden).be.null();
    should(refused.warnings[0]).startWith("could not record stranger's done on its card: only");
  });
});
