import { describe, it } from 'bun:test';
import {
  type BoardProjectId,
  type Card,
  type LaneSet,
  MAX_CARD_BRIEF_LENGTH,
  UNFILED_PROJECT_ID,
} from '../../../contract/index.ts';
import should from 'should';
import {
  askOf,
  BoardService,
  cardFooterLine,
  cardOrigin,
  cardTitle,
  type DelegationRequest,
  ownerDelegation,
  FerretCards,
  type FerretCardsPorts,
} from '../../../daemon/lib/board/index.ts';
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
  readonly cards?: readonly Card[];
  /** Where each session works; absent means PROJECT. */
  readonly projects?: Readonly<Record<string, BoardProjectId>>;
  /** What a proposal answers; absent proposes nothing. */
  readonly proposed?: LaneSet | 'fail';
  readonly world?: Partial<ServiceWorld>;
  readonly adoption?: FerretCardsPorts['adoption'];
  /** The board refuses to move a card on the session's start. */
  readonly failTrigger?: boolean;
  /** The boards that are off; absent means every board is on. */
  readonly off?: readonly BoardProjectId[];
  /** The board a child started in each folder works on; absent means PROJECT. */
  readonly folders?: Readonly<Record<string, BoardProjectId>>;
  /** Replaces the lookup of a board's name. */
  readonly nameOf?: FerretCardsPorts['projects']['nameOf'];
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
  const board: FerretCardsPorts['board'] =
    options.failTrigger === true
      ? {
          reserve: service.reserve.bind(service),
          spawn: service.spawn.bind(service),
          signalDone: service.signalDone.bind(service),
          snapshot: service.snapshot.bind(service),
          requireHandOver: service.requireHandOver.bind(service),
          handOver: service.handOver.bind(service),
          assignForOwner: service.assignForOwner.bind(service),
          mayAdoptUnder: service.mayAdoptUnder.bind(service),
          trigger: async () => {
            throw new Error('the board store is read-only');
          },
        }
      : service;
  const proposals: Array<readonly [BoardProjectId, string]> = [];
  const warnings: string[] = [];
  const cardsPorts: FerretCardsPorts = {
    board,
    lanes: lanesSource,
    starts: { projectForStart: async ({ cwd }) => options.folders?.[cwd] ?? PROJECT },
    switches: { isOn: async projectId => !(options.off ?? []).includes(projectId) },
    proposer: {
      propose: async (projectId, ferret) => {
        proposals.push([projectId, ferret]);
        if (options.proposed === 'fail') throw new Error('the lane store is read-only');
        return options.proposed ?? null;
      },
    },
    projects: { nameOf: options.nameOf ?? (async projectId => NAMES[projectId] ?? projectId) },
    focus,
    diagnostics: { warn: message => warnings.push(message) },
    bin: 'fy',
    ...(options.adoption === undefined ? {} : { adoption: options.adoption }),
  };
  return { subject: new FerretCards(cardsPorts), ports, focus, proposals, warnings };
};

const stored = (ports: ServiceWorld, id: string): Card => ports.store.cards.get(id) as Card;

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
    should(askOf('z'.repeat(MAX_CARD_BRIEF_LENGTH + 1), 'owner').text.length).equal(MAX_CARD_BRIEF_LENGTH);
  });

  it('should name the card and its board in the footer line', () => {
    // Act / Assert
    should(cardFooterLine('F413', 'Ferretry', 'fy')).equal(
      'Your card is &F413 on the Ferretry board; the daemon moves it for you (`fy card note` adds progress).',
    );
    should(cardFooterLine('F413', 'Ferretry', 'fy', { id: 'F85' })).equal(
      'Your card is &F413 on the Ferretry board, under &F85; the daemon moves it for you (`fy card note` adds progress).',
    );
    should(cardFooterLine('F413', undefined, 'ferret')).equal(
      "Your card is &F413 on the project's board; the daemon moves it for you (`ferret card note` adds progress).",
    );
  });
});

describe('a session started with a brief', () => {
  it('should get its own card, asked by the owner, focused, and already in the lane work starts in', async () => {
    // Arrange
    const { subject, ports, focus } = build();

    // Act
    const opened = await subject.open({ ferret: 'worker', name: 'Theme switch', brief: 'Move the theme switch' });

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
      actor: { kind: 'daemon' },
    });
    should(focus.focused.get('worker')).deepEqual({ id: 'F1' });
  });

  it('should keep the card in its first lane, say so, and still start when the move cannot be made', async () => {
    // Arrange
    const { subject, ports, warnings } = build({ failTrigger: true });

    // Act
    const opened = await subject.open({ ferret: 'worker', brief: 'Move the theme switch' });

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
    const opened = await subject.open({ ferret: 'child', brief: 'Build it', parent: 'lead', delegation });

    // Assert
    should(opened.card).match({ id: 'F9', laneId: 'merged' });
    should(stored(ports, 'F9').history.some(event => event.type === 'moved')).be.false();
  });

  it('should say a ferret asked when a ferret started it', async () => {
    // Arrange
    const { subject, ports } = build();

    // Act
    await subject.open({ ferret: 'child', brief: 'Survey the agenda', parent: 'lead' });

    // Assert
    should(stored(ports, 'F1').ask).deepEqual({ text: 'Survey the agenda', source: 'session:lead' });
  });

  describe("a ferret's job is never the owner's ask", () => {
    const OWNER_MESSAGE =
      'Review the Insights screenshots for the timezone picker on phone and desktop, light and dark';
    const ownerSaid = { world: { ownerWords: { said: async () => [OWNER_MESSAGE] } } };

    it("should file a fy new no lead was recorded for as the ferrets' own work: private, top level, never person-asked", async () => {
      // Arrange: the boundary took the caller for a person, so the start has no parent and no delegation
      const { subject, ports } = build();

      // Act
      await subject.open({ ferret: 'cordie', brief: 'Read-only review of the screenshots', viaPack: true });

      // Assert
      const made = stored(ports, 'F1');
      should(made.ask).deepEqual({ text: 'Read-only review of the screenshots', source: 'fy new' });
      should(made).match({ askedBy: 'agent', visibility: 'private', parent: null });
      should(cardOrigin(made, { startedByFerret: () => false })).equal('agent');
    });

    it('should keep a fy new card agent-asked and private when its brief quotes the owner, now and after a reboot', async () => {
      // Arrange: the lead is a top-level ferret that talks to the owner, and its brief repeats their message
      const { subject, ports } = build(ownerSaid);
      const { delegation } = await subject.delegate('lead', { brief: OWNER_MESSAGE, name: 'Screenshots' }, true);

      // Act
      await subject.open({ ferret: 'child', brief: OWNER_MESSAGE, parent: 'lead', delegation, viaPack: true });

      // Assert
      should(stored(ports, 'F1')).match({ askedBy: 'agent', visibility: 'private' });
      should(cardOrigin(stored(ports, 'F1'), { startedByFerret: () => false })).equal('agent');
    });

    it("should still make the owner's own New session their ask: public, person-asked", async () => {
      // Arrange
      const { subject, ports } = build(ownerSaid);

      // Act
      await subject.open({ ferret: 'worker', brief: OWNER_MESSAGE });

      // Assert
      should(stored(ports, 'F1').ask.source).equal('owner');
      should(stored(ports, 'F1')).match({ askedBy: 'person', visibility: 'public' });
    });
  });

  describe('on a board that is off', () => {
    it('should make no card for a start, and say nothing', async () => {
      // Arrange
      const { subject, ports, focus, warnings } = build({ off: [PROJECT] });

      // Act
      const opened = await subject.open({ ferret: 'worker', brief: 'Survey the agenda' });

      // Assert
      should(opened).deepEqual({ notes: [] });
      should([...ports.store.cards.keys()]).deepEqual([]);
      should(focus.focused.get('worker')).be.undefined();
      should(warnings).deepEqual([]);
    });

    it('should make no card for a fy new whose lead holds none, and say how to hand one', async () => {
      // Arrange
      const { subject, ports } = build({ off: [PROJECT] });

      // Act
      const outcome = await subject.delegate('lead', { brief: 'Build it', name: 'Build it' }, true);
      const opened = await subject.open({ ferret: 'child', brief: 'Build it', parent: 'lead' });

      // Assert
      should(outcome).deepEqual({
        notes: [
          'No card was made for the helper: the Ferretry board is off and you hold no card for this work. `fy new --card <id>` hands it one.',
        ],
      });
      should(opened).deepEqual({ notes: [] });
      should([...ports.store.cards.keys()]).deepEqual([]);
    });

    it("should name the lead's board when the child runs elsewhere", async () => {
      // Arrange
      const { subject } = build({ off: [OTHER_PROJECT], projects: { lead: OTHER_PROJECT } });

      // Act
      const outcome = await subject.delegate('lead', { brief: 'Build it', name: 'Build it' }, false);

      // Assert
      should(outcome.delegation).be.undefined();
      should(outcome.notes[0]).startWith('No card was made for the helper: the Home board is off');
    });

    it("should still make the helper's card under the card its lead holds", async () => {
      // Arrange
      const { subject, focus } = build({ off: [PROJECT], cards: [card({ id: 'F1', owner: 'lead' })] });
      focus.anchors.set('lead', { id: 'F1' });

      // Act
      const { delegation } = await subject.delegate('lead', { brief: 'Build it', name: 'Build it' }, true);
      const opened = await subject.open({ ferret: 'child', brief: 'Build it', parent: 'lead', delegation });

      // Assert
      should(delegation).match({ id: 'F2', existing: false, parent: { id: 'F1' } });
      should(opened.card).match({ id: 'F2', owner: 'lead', assignee: 'child' });
    });

    it("should make no card under a card the brief merely names: somebody else's, closed or dropped", async () => {
      // Arrange
      const cards = [
        card({ id: 'F1', owner: 'stranger' }),
        card({ id: 'F2', owner: 'lead', laneId: 'closed' }),
        card({ id: 'F3', owner: 'lead', dropped: { reason: 'superseded', at: NOW } }),
      ];
      const { subject, ports, focus } = build({ off: [PROJECT], cards });
      focus.anchors.set('lead', { id: 'F2' });

      // Act
      const outcomes = [];
      for (const brief of ['Fix &F1 for the owner', 'Finish &F2', 'Redo &F3']) {
        outcomes.push(await subject.delegate('lead', { brief, name: 'Build it' }, true));
      }

      // Assert
      for (const outcome of outcomes) {
        should(outcome.notes[0]).startWith('No card was made for the helper: the Ferretry board is off');
      }
      should(ports.store.cards.size).equal(3);
    });

    it("should ask the board a fy new --cwd child will work on, not the lead's", async () => {
      // Arrange: the lead works on Ferretry (on) and holds F1 there; the child runs in a folder whose board is off.
      const { subject, ports, focus } = build({
        off: [OTHER_PROJECT],
        folders: { '/work/other': OTHER_PROJECT },
        cards: [card({ id: 'F1', owner: 'lead' })],
      });

      // Act
      const bare = await subject.delegate('lead', { brief: 'Build it', name: 'Build it' }, false, '/work/other');
      focus.anchors.set('lead', { id: 'F1' });
      const underFerretryCard = await subject.delegate(
        'lead',
        { brief: 'Build it under &F1', name: 'Build it' },
        false,
        '/work/other',
      );

      // Assert
      for (const outcome of [bare, underFerretryCard]) {
        should(outcome.delegation).be.undefined();
        should(outcome.notes[0]).startWith('No card was made for the helper: the Home board is off');
      }
      should(ports.store.cards.size).equal(1);
    });

    it("should make a fy new --cwd card under a card the lead holds on the child's own board", async () => {
      // Arrange
      const { subject } = build({
        off: [OTHER_PROJECT],
        folders: { '/work/other': OTHER_PROJECT },
        cards: [card({ id: 'F1', owner: 'lead', projectId: OTHER_PROJECT, laneId: 'todo' })],
      });

      // Act
      const { delegation } = await subject.delegate(
        'lead',
        { brief: 'Part of &F1', name: 'Build it' },
        false,
        '/work/other',
      );

      // Assert
      should(delegation).match({ id: 'F2', existing: false, parent: { id: 'F1' } });
    });

    it('should make no card when the child lands on a board that is off, whatever the start guessed', async () => {
      // Arrange: the delegation was made for Ferretry, under F1; the child landed on the Home board, which is off.
      const { subject, ports } = build({
        off: [OTHER_PROJECT],
        projects: { child: OTHER_PROJECT },
        cards: [card({ id: 'F1', owner: 'lead' })],
      });
      const delegation = { lead: 'lead', brief: 'Build it', id: 'F2', existing: false, parent: { id: 'F1' } };

      // Act
      const opened = await subject.open({ ferret: 'child', brief: 'Build it', parent: 'lead', delegation });

      // Assert
      should(opened).deepEqual({
        notes: ['No card was made for the helper: the Home board is off and you hold no card on it for this work.'],
      });
      should([...ports.store.cards.keys()]).deepEqual(['F1']);
    });
  });

  describe('the parent of the card a fy new makes', () => {
    const delegate = (subject: FerretCards, brief: string, extra: Partial<DelegationRequest> = {}) =>
      subject.delegate('lead', { brief, name: 'Build the board store', ...extra }, true);

    it("should put the card under the lead's anchor, owned by the lead and worked by the child", async () => {
      // Arrange
      const { subject, ports, focus } = build({ cards: [card({ id: 'F1', owner: 'lead', laneId: 'implement' })] });
      focus.anchors.set('lead', { id: 'F1' });
      focus.focused.set('lead', { id: 'F1' });

      // Act
      const { delegation } = await delegate(subject, 'Build the board store');
      const opened = await subject.open({
        ferret: 'child',
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
      should(stored(ports, 'F2').createdBy).deepEqual({ kind: 'daemon' });
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
      const opened = await subject.open({ ferret: 'child', brief: 'x', parent: 'lead', delegation });

      // Assert
      should(delegation?.parent).be.null();
      should(delegation).not.have.property('parentFrom');
      should(notes).deepEqual([
        "The helper's card has no parent, so it is at the top level of the board: `fy card reparent &F2 --parent <id>` moves it, and `fy card focus <id>` (or `--card <id>`) says where your helpers' cards go next time.",
      ]);
      should(opened.card?.parent).be.null();
      should(stored(ports, 'F2').parent).be.null();
    });

    it('should set an anchor only by choice: a focus, a create or a start does; a note does not', async () => {
      // Arrange
      const { ports, focus } = build({ cards: [card({ id: 'F1', owner: 'lead', assignee: null })] });
      const board = new BoardService({ ...ports, parents: new FakeParents({ child: 'lead' }) });
      const lead = { kind: 'ferret', ferret: 'lead' } as const;

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
      const opened = await subject.open({ ferret: 'child', brief: 'x', parent: 'lead', delegation });

      // Assert
      should(delegation).deepEqual({
        lead: 'lead',
        brief: 'Build the board store',
        id: 'F5',
        existing: true,
        parent: { id: 'F1' },
        held: { owner: 'lead', assignee: null },
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

  describe('the owner starting a ferret on a card', () => {
    it("should assign the card to the new ferret as the owner's act, keep its owner and parent, and focus and anchor it", async () => {
      // Arrange
      const { subject, ports, focus } = build({
        cards: [
          card({ id: 'F9', owner: 'lead', assignee: 'worker', parent: { id: 'F1' } }),
          card({ id: 'F1', owner: 'lead' }),
        ],
      });
      focus.focused.set('worker', { id: 'F9' });

      // Act
      const delegation = ownerDelegation(stored(ports, 'F9'));
      const opened = await subject.open({ ferret: 'child', brief: 'take over', delegation });

      // Assert
      should(opened.card).match({ id: 'F9', owner: 'lead', assignee: 'child', laneId: 'plan' });
      should(opened.card?.parent).deepEqual({ id: 'F1' });
      should(stored(ports, 'F9').history.find(event => event.type === 'assigned')).match({
        to: 'child',
        actor: { kind: 'owner' },
      });
      should(focus.focused.get('child')).deepEqual({ id: 'F9' });
      should(focus.anchors.get('child')).deepEqual({ id: 'F9' });
      should([...ports.store.cards.keys()].sort()).deepEqual(['F1', 'F9']);
    });

    it('should make no card, and leave the ferret alone, when the card was dropped after the owner chose it', async () => {
      // Arrange
      const { subject, ports } = build({
        cards: [card({ id: 'F9', owner: 'lead', dropped: { at: NOW, reason: 'x' } })],
      });

      // Act
      const opened = await subject.open({
        ferret: 'child',
        brief: 'take over',
        delegation: ownerDelegation(stored(ports, 'F9')),
      });

      // Assert
      should(opened.card).be.undefined();
      should(stored(ports, 'F9').assignee).be.null();
    });
  });
  describe('a fy new --card', () => {
    it("should assign the lead's existing card to the child, keep its owner and parent, and make no second card", async () => {
      // Arrange
      const { subject, ports, focus } = build({
        cards: [
          card({ id: 'F9', owner: 'lead', title: 'Something else', parent: { id: 'F1' }, workflow: 'design-first' }),
          card({ id: 'F1', owner: 'lead' }),
        ],
      });
      focus.focused.set('lead', { id: 'F1' });

      // Act
      const { delegation, refusal } = await subject.delegate('lead', { brief: 'Build it', card: 'F9' }, true);
      const opened = await subject.open({ ferret: 'child', brief: 'Build it', parent: 'lead', delegation });

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
        actor: { kind: 'daemon' },
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

  describe('a fy start --card', () => {
    it("should assign the lead's existing card to the new session and journal it, with no second card", async () => {
      // Arrange
      const { subject, ports, focus } = build({
        cards: [card({ id: 'F9', owner: 'lead', title: 'Something else' })],
      });

      // Act
      const { delegation, refusal } = await subject.startOn('lead', 'F9');
      const opened = await subject.open({ ferret: 'child', brief: 'Build it', parent: 'lead', delegation });

      // Assert
      should(refusal).be.undefined();
      should(opened.card).match({ id: 'F9', owner: 'lead', assignee: 'child', title: 'Something else' });
      should(stored(ports, 'F9').history.find(event => event.type === 'assigned')).match({
        from: null,
        to: 'child',
        actor: { kind: 'ferret', name: 'lead', ferret: 'lead' },
      });
      should([...ports.store.cards.keys()]).deepEqual(['F9']);
      should(focus.focused.get('child')).deepEqual({ id: 'F9' });
    });

    it('should refuse a card its caller may not hand down, and write nothing', async () => {
      // Arrange
      const { subject, ports } = build({
        cards: [
          card({ id: 'F2', owner: 'stranger', assignee: 'stranger' }),
          card({ id: 'F3', owner: 'sibling', assignee: 'sibling' }),
        ],
      });

      // Act
      const foreign = await subject.startOn('lead', 'F2');
      const sideways = await subject.startOn('lead', 'F3');
      const missing = await subject.startOn('lead', 'F99');

      // Assert
      should(foreign.delegation).be.undefined();
      should(foreign.refusal).be.a.String();
      should(sideways.delegation).be.undefined();
      should(missing.refusal).match(/no card &F99/u);
      should(ports.store.writes).be.empty();
    });

    it("should let the owner's start take any card that exists, as the owner's act", async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });

      // Act
      const { delegation, refusal } = await subject.startOn(undefined, 'F9');
      const missing = await subject.startOn(undefined, 'F99');
      const opened = await subject.open({ ferret: 'child', brief: 'Build it', delegation });

      // Assert
      should(refusal).be.undefined();
      should(delegation).match({ id: 'F9', byOwner: true });
      should(missing.refusal).match(/no card &F99/u);
      should(opened.card).match({ id: 'F9', owner: 'lead', assignee: 'child' });
      should(stored(ports, 'F9').history.find(event => event.type === 'assigned')?.actor).match({ kind: 'owner' });
    });
  });

  describe('a fy start --card that cannot be honoured', () => {
    const stopper = () => {
      const stopped: string[] = [];
      return { stopped, stop: async (reason: string) => void stopped.push(reason) };
    };

    it('should refuse a dropped or closed card up front, for a lead and for the owner, and write nothing', async () => {
      // Arrange
      const { subject, ports } = build({
        cards: [
          card({ id: 'F3', owner: 'lead', dropped: { at: NOW, reason: 'superseded' } }),
          card({ id: 'F4', owner: 'lead', laneId: 'closed' }),
        ],
      });

      // Act
      const outcomes = [
        await subject.startOn('lead', 'F3'),
        await subject.startOn('lead', 'F4'),
        await subject.startOn(undefined, 'F3'),
        await subject.startOn(undefined, 'F4'),
      ];

      // Assert
      for (const outcome of outcomes) should(outcome.delegation).be.undefined();
      should(outcomes.map(outcome => outcome.refusal)).match([
        /&F3 is dropped/u,
        /&F4 is closed/u,
        /&F3 is dropped/u,
        /&F4 is closed/u,
      ]);
      should(ports.store.writes).be.empty();
    });

    it('should refuse a start that is not an ordinary ferret, whatever the card', async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });

      // Act
      const byLead = await subject.startOn('lead', 'F9', false);
      const byOwner = await subject.startOn(undefined, 'F9', false);

      // Assert
      should(byLead.delegation).be.undefined();
      should(byLead.refusal).match(/ordinary ferret/u);
      should(byOwner.refusal).match(/ordinary ferret/u);
      should(ports.store.writes).be.empty();
    });

    it('should refuse, not fail, when the board cannot be read', async () => {
      // Arrange
      const store = new MemoryBoardStore([card({ id: 'F9', owner: 'lead' })]);
      store.read = async () => {
        throw new TypeError('the board is unreadable');
      };
      const { subject } = build({ world: { store } });

      // Act
      const outcome = await subject.startOn(undefined, 'F9');

      // Assert
      should(outcome.delegation).be.undefined();
      should(outcome.refusal).match(/the board is unreadable/u);
    });

    it('should hand the card over and stop nothing when it is still open', async () => {
      // Arrange
      const { subject, ports, focus } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const { delegation } = await subject.startOn('lead', 'F9');

      // Act
      const taken = await subject.takeOver(delegation as NonNullable<typeof delegation>, 'child', stop);

      // Assert
      should(taken.refusal).be.undefined();
      should(taken.opened?.card).match({ id: 'F9', assignee: 'child' });
      should(stopped).be.empty();
      should(focus.focused.get('child')).deepEqual({ id: 'F9' });
      should(stored(ports, 'F9').assignee).equal('child');
    });

    it('should stop the session and leave the card alone when it was dropped after the preflight', async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const { delegation } = await subject.startOn('lead', 'F9');
      ports.store.cards.set('F9', card({ id: 'F9', owner: 'lead', dropped: { at: NOW, reason: 'changed course' } }));

      // Act
      const taken = await subject.takeOver(delegation as NonNullable<typeof delegation>, 'child', stop);

      // Assert
      should(taken.opened).be.undefined();
      should(taken.refusal).match(/&F9 could not be handed to the new session: .*&F9 is dropped/u);
      should(stopped).deepEqual([taken.refusal]);
      should(stored(ports, 'F9').assignee).be.null();
      should(ports.store.writes).be.empty();
    });

    it('should stop the session when the owner’s card was closed after the preflight', async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const { delegation } = await subject.startOn(undefined, 'F9');
      ports.store.cards.set('F9', card({ id: 'F9', owner: 'lead', laneId: 'closed' }));

      // Act
      const taken = await subject.takeOver(delegation as NonNullable<typeof delegation>, 'child', stop);

      // Assert
      should(taken.refusal).match(/&F9 is closed/u);
      should(stopped).have.length(1);
      should(ports.store.writes).be.empty();
    });

    it('should stop the session when the card was reassigned away from the lead after the preflight', async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const { delegation } = await subject.startOn('lead', 'F9');
      ports.store.cards.set('F9', card({ id: 'F9', owner: 'stranger', assignee: 'stranger' }));

      // Act
      const taken = await subject.takeOver(delegation as NonNullable<typeof delegation>, 'child', stop);

      // Assert
      should(taken.opened).be.undefined();
      should(taken.refusal).be.a.String();
      should(stopped).have.length(1);
      should(stored(ports, 'F9').assignee).equal('stranger');
      should(ports.store.writes).be.empty();
    });

    it('should stop the second of two starts racing for a lead’s card, and keep the first one’s assignment', async () => {
      // Arrange: both starts judge the card while the lead alone holds it.
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const first = await subject.startOn('lead', 'F9');
      const second = await subject.startOn('lead', 'F9');

      // Act
      const winner = await subject.takeOver(first.delegation as NonNullable<typeof first.delegation>, 'child-a', stop);
      const loser = await subject.takeOver(second.delegation as NonNullable<typeof second.delegation>, 'child-b', stop);

      // Assert
      should(winner.refusal).be.undefined();
      should(loser.opened).be.undefined();
      should(loser.refusal).match(
        /&F9 could not be handed to the new session: .*&F9 changed hands .*nothing was assigned/u,
      );
      should(stopped).deepEqual([loser.refusal]);
      should(stored(ports, 'F9').assignee).equal('child-a');
      should(ports.store.cards.get('F9')?.history.filter(event => event.type === 'assigned')).have.length(1);
    });

    it('should stop the second of two owner starts racing for a card, though the owner may always assign', async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const first = await subject.startOn(undefined, 'F9');
      const second = await subject.startOn(undefined, 'F9');

      // Act
      const winner = await subject.takeOver(first.delegation as NonNullable<typeof first.delegation>, 'child-a', stop);
      const loser = await subject.takeOver(second.delegation as NonNullable<typeof second.delegation>, 'child-b', stop);

      // Assert
      should(winner.refusal).be.undefined();
      should(loser.refusal).match(/&F9 changed hands/u);
      should(stopped).have.length(1);
      should(stored(ports, 'F9').assignee).equal('child-a');
    });

    it('should stop a start when only the assignee changed after the preflight, the lead still owning the card', async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const { delegation } = await subject.startOn('lead', 'F9');
      ports.store.cards.set('F9', card({ id: 'F9', owner: 'lead', assignee: 'other-child' }));

      // Act
      const taken = await subject.takeOver(delegation as NonNullable<typeof delegation>, 'child', stop);

      // Assert
      should(taken.refusal).match(/&F9 changed hands since you chose it \(now held by other-child\)/u);
      should(stopped).have.length(1);
      should(stored(ports, 'F9').assignee).equal('other-child');
      should(ports.store.writes).be.empty();
    });

    it('should stop a start when the owner started it and only the assignee changed after the preflight', async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const { delegation } = await subject.startOn(undefined, 'F9');
      ports.store.cards.set('F9', card({ id: 'F9', owner: 'lead', assignee: 'other-child' }));

      // Act
      const taken = await subject.takeOver(delegation as NonNullable<typeof delegation>, 'child', stop);

      // Assert
      should(taken.refusal).match(/&F9 changed hands/u);
      should(stopped).have.length(1);
      should(stored(ports, 'F9').assignee).equal('other-child');
    });

    it('should start the session, naming no board, when the board’s name cannot be looked up after the card is assigned', async () => {
      // Arrange: the name is read for the preflight, then the lookup fails once the card has been assigned.
      let failing = false;
      const { subject, ports, warnings } = build({
        cards: [card({ id: 'F9', owner: 'lead' })],
        nameOf: async projectId => {
          if (failing) throw new Error('the project registry is unreadable');
          return NAMES[projectId] ?? projectId;
        },
      });
      const { stopped, stop } = stopper();
      const { delegation } = await subject.startOn('lead', 'F9');
      failing = true;

      // Act
      const taken = await subject.takeOver(delegation as NonNullable<typeof delegation>, 'child', stop);

      // Assert
      should(taken.refusal).be.undefined();
      should(taken.opened?.card).match({ id: 'F9', assignee: 'child', laneId: 'plan' });
      should(taken.opened?.project).be.undefined();
      should(stopped).be.empty();
      should(stored(ports, 'F9').assignee).equal('child');
      should(warnings).deepEqual(['could not name the board of &F9: the project registry is unreadable']);
    });

    it('should refuse a delegation that was never judged, rather than assign on a guess', async () => {
      // Arrange
      const { subject, ports } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { stopped, stop } = stopper();
      const { delegation } = await subject.startOn('lead', 'F9');
      const { held: _held, ...unjudged } = delegation as NonNullable<typeof delegation>;

      // Act
      const taken = await subject.takeOver(unjudged, 'child', stop);

      // Assert
      should(taken.refusal).match(/&F9 was not judged before it was handed over/u);
      should(stopped).have.length(1);
      should(ports.store.writes).be.empty();
    });

    it('should still refuse, and say the stop failed, when the session cannot be stopped', async () => {
      // Arrange
      const { subject, ports, warnings } = build({ cards: [card({ id: 'F9', owner: 'lead' })] });
      const { delegation } = await subject.startOn('lead', 'F9');
      ports.store.cards.set('F9', card({ id: 'F9', owner: 'lead', dropped: { at: NOW, reason: 'x' } }));

      // Act
      const taken = await subject.takeOver(delegation as NonNullable<typeof delegation>, 'child', async () => {
        throw new Error('tmux would not answer');
      });

      // Assert
      should(taken.refusal).be.a.String();
      should(warnings.join('\n')).match(/could not stop child after a refused card: tmux would not answer/u);
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
    should(outcome.notes).deepEqual(['No card was made for the helper: the board is unreadable']);
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
    const opened = await subject.open({ ferret: 'child', brief: 'x', parent: 'lead', delegation });

    // Assert
    should(opened.card?.projectId).equal(OTHER_PROJECT);
    should(opened.notes).deepEqual([
      'The brief said &F2 is on the Ferretry board; it is on the Home board, where the helper runs.',
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
      projectOf: async (ferret: string) => await stored.projectOf(ferret),
      laneSet: async (projectId: BoardProjectId) => (proposedYet ? await stored.laneSet(projectId) : null),
    };
    const subject = new FerretCards({
      board: new BoardService(world({ lanes: projectLanes })),
      lanes: projectLanes,
      starts: { projectForStart: async () => BARE_PROJECT },
      switches: { isOn: async () => true },
      proposer: {
        propose: async (projectId, ferret) => {
          proposals.push([projectId, ferret]);
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
    const opened = await subject.open({ ferret: 'worker', brief: 'write notes' });

    // Assert
    should(proposals).deepEqual([[BARE_PROJECT, 'worker']]);
    should(opened.card?.projectId).equal(BARE_PROJECT);
    should(opened.notes).deepEqual(['Notes had no lanes, so they were proposed for the owner to confirm (an ask).']);
  });

  it('should fall back to the Unfiled board, saying how to move the card, when proposing fails', async () => {
    // Arrange
    const quiet = build({ projects: { worker: BARE_PROJECT } });
    const failing = build({ projects: { worker: BARE_PROJECT }, proposed: 'fail' });

    // Act
    const opened = await quiet.subject.open({ ferret: 'worker', brief: 'write notes' });
    const afterFailure = await failing.subject.open({ ferret: 'worker', brief: 'write notes' });

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
    const adoption = (proposed: boolean): FerretCardsPorts['adoption'] => ({
      adopt: async (ferret, proposer) => {
        adopted.push(`${ferret}:${proposer ?? ferret}`);
        return { projectId: OTHER_PROJECT, proposed };
      },
    });
    const fresh = build({ projects: { worker: UNFILED_PROJECT_ID }, adoption: adoption(true) });
    const known = build({ projects: { worker: UNFILED_PROJECT_ID }, adoption: adoption(false) });

    // Act
    const opened = await fresh.subject.open({ ferret: 'worker', brief: 'write notes' });
    const again = await known.subject.open({ ferret: 'worker', brief: 'write notes' });

    // Assert
    should(adopted).deepEqual(['worker:worker', 'worker:worker']);
    should(opened.card?.projectId).equal(OTHER_PROJECT);
    should(opened.notes).deepEqual([
      'Home was registered as a project, so the card is on its board; its lanes were proposed for the owner to confirm (an ask).',
    ]);
    should(again.notes).deepEqual(['Home was registered as a project, so the card is on its board.']);
    should(fresh.proposals).be.empty();
  });

  it('should keep a start on its board when registering does nothing or fails, and never ask for a filed one', async () => {
    // Arrange
    const asked: string[] = [];
    const recording = (prefix: string): FerretCardsPorts['adoption'] => ({
      adopt: async ferret => {
        asked.push(`${prefix}${ferret}`);
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
    const kept = await nothing.subject.open({ ferret: 'worker', brief: 'x' });
    const fallen = await failing.subject.open({ ferret: 'worker', brief: 'x' });
    const onBoard = await filed.subject.open({ ferret: 'worker', brief: 'x' });

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
    const opened = await subject.open({ ferret: 'worker', brief: 'x' });
    const delegated = await subject.delegate('lead', { brief: 'x' }, true);

    // Assert
    should(opened.card).be.undefined();
    should(opened.notes[0]).startWith('No card was made for worker:');
    should(delegated.delegation).be.undefined();
    should(delegated.notes[0]).startWith('No card was made for the helper:');
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
