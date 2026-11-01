import { describe, it } from 'bun:test';
import {
  type AgendaItem,
  type AgendaResponse,
  type BoardTask,
  type BoardTaskActionRequest,
  BoardTaskActionRequestSchema,
  type LaneSet,
  gateReference,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';
import should from 'should';
import { BoardGateCards } from '../../../src/adapters/board/board-gate-cards.ts';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../src/lib/agenda/index.ts';
import {
  type BoardCaller,
  BoardService,
  GATE_MOVED_ON,
  type GateAnswer,
  GateItems,
  gateEntry,
  gateOf,
  gateRaise,
  stageGateLanes,
} from '../../../src/lib/board/index.ts';
import { card, FakeDone, FakeReopen, lanes, MemoryBoardStore, NOW, PROJECT, world } from './support.ts';

/**
 * GATES ASK THE OWNER (docs/board.md § Gates ask the owner), over the REAL board and agenda services with their
 * stores in memory: a card entering a gate raises one item, leaving resolves it, and only the owner's answer moves
 * the card — first, through the board, before the item closes.
 */

/** Every session's agenda in memory: the state machine is real, the files are not. */
class Ledgers implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();

  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }

  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledgers.get(sessionId) ?? null);
    if (mutation.ok) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

/** `lead` started `child`, which started `grandchild`; the card is `child`'s, worked by `grandchild`. */
const LEADS: Readonly<Record<string, string>> = { child: 'lead', grandchild: 'child' };
const SESSIONS = new Set(['lead', 'child', 'grandchild', 'stranger']);

const HUMAN: AgendaActor = { kind: 'human' };
const OWNER: BoardCaller = { kind: 'owner' };

const external = (overrides: Partial<BoardTask> = {}): BoardTask => {
  const laneId = overrides.laneId ?? 'implement';
  return card({
    owner: 'child',
    assignee: 'grandchild',
    createdBy: { kind: 'ferret', sessionId: 'child' },
    ask: { text: 'make the gates ask me', source: 'owner' },
    summary: 'Gates raise one agenda item',
    howToTest: '1. Open the Inbox\n2. Answer the card',
    history: [{ seq: 1, at: NOW, actor: { kind: 'ferret', sessionId: 'child' }, type: 'created', laneId }],
    ...overrides,
    laneId,
  });
};

const internal = (overrides: Partial<BoardTask> = {}): BoardTask =>
  external({ ask: { text: 'tidy the logs', source: 'session:child' }, ...overrides });

/** Faults a case puts between the gates and their ports. */
interface Faults {
  /** Raising throws, instead of answering. */
  readonly raiseThrows?: boolean;
  /** The board refuses these actions. */
  readonly refuses?: readonly BoardTaskActionRequest['action'][];
  /** Telling the ferret throws. */
  readonly tellThrows?: boolean;
}

const fixture = (cards: readonly BoardTask[], faults: Faults = {}) => {
  const ledgers = new Ledgers();
  const warnings: string[] = [];
  const told: { readonly task: string; readonly message: string; readonly key: string }[] = [];
  const store = new MemoryBoardStore(cards);
  const reopen = new FakeReopen();
  const done = new FakeDone();
  let gates: GateItems | undefined;
  const board = new BoardService(
    world({ store, reopen, done, gates: { written: async id => await gates?.written(id) } }),
  );
  const agenda = new AgendaService(
    ledgers,
    { now: () => NOW },
    { has: async sessionId => SESSIONS.has(sessionId) },
    { raised: async () => undefined },
    undefined,
    undefined,
    { leadOf: async sessionId => LEADS[sessionId], addressOf: async sessionId => sessionId },
  );
  const cards_ = new BoardGateCards(board, { project: async () => ({ name: 'Ferretry' }) });
  gates = new GateItems({
    agenda: {
      list: async sessionId => await agenda.list(sessionId),
      raise: async (sessionId, request, actor) => {
        if (faults.raiseThrows === true) throw new Error('the agenda is unwritable');
        return await agenda.raise(sessionId, request, actor);
      },
      resolve: async (sessionId, id, actor, note) => await agenda.resolve(sessionId, id, actor, note),
      answer: async (sessionId, id, response, actor, note) => await agenda.answer(sessionId, id, response, actor, note),
    },
    board: {
      card: async id => await cards_.card(id),
      cards: async () => await cards_.cards(),
      act: async (id, request, caller) => {
        if (faults.refuses?.includes(request.action) === true)
          throw new Error(`the board refused the ${request.action}`);
        await cards_.act(id, request, caller);
      },
    },
    lanes: stageGateLanes,
    words: {
      told: async (task, message, key) => {
        if (faults.tellThrows === true) throw new Error('nobody to tell');
        told.push({ task: task.id, message, key });
      },
    },
    diagnostics: { warn: message => warnings.push(message) },
  });
  const open = (sessionId = 'grandchild'): AgendaItem[] => {
    const ledger = ledgers.ledgers.get(sessionId);
    return ledger === undefined
      ? []
      : ledger.entries.flatMap(entry => (entry.lifecycle === 'active' ? [entry.item] : []));
  };
  const closed = (sessionId = 'grandchild'): ResolvedAgendaItem[] => {
    const ledger = ledgers.ledgers.get(sessionId);
    return ledger === undefined
      ? []
      : ledger.entries.flatMap(entry => (entry.lifecycle === 'addressed' ? [entry.item] : []));
  };
  const answer = async (
    id: string,
    response: AgendaResponse,
    overrides: Partial<GateAnswer> = {},
  ): ReturnType<GateItems['answer']> =>
    await (gates as GateItems).answer({
      sessionId: 'grandchild',
      id: id as GateAnswer['id'],
      response,
      actor: HUMAN,
      caller: OWNER,
      ...overrides,
    });
  const move = async (to: string, caller: BoardCaller = OWNER, reason?: string) =>
    await board.act(
      'F1',
      BoardTaskActionRequestSchema.parse({ action: 'move', to, ...(reason === undefined ? {} : { reason }) }),
      caller,
    );
  return {
    agenda,
    board,
    gates: gates as GateItems,
    store,
    reopen,
    done,
    warnings,
    told,
    open,
    closed,
    answer,
    move,
    stored: (id = 'F1') => store.cards.get(id) as BoardTask,
  };
};

const choose = (choice: string): AgendaResponse => ({ kind: 'multiple-choice', choice });

describe('the gate policy', () => {
  it('finds the history entry that put the card in its lane', () => {
    const moved = external({
      laneId: 'tested',
      history: [
        { seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'todo' },
        {
          seq: 2,
          at: NOW,
          actor: { kind: 'daemon' },
          type: 'moved',
          from: 'todo',
          to: 'tested',
          backward: false,
          reason: null,
          auto: true,
          trigger: 'release.running',
        },
        { seq: 3, at: NOW, actor: { kind: 'owner' }, type: 'note', text: 'looks close' },
      ],
    });
    should(gateEntry(moved)).equal(2);
    should(gateEntry({ ...moved, laneId: 'closed' })).be.undefined();
  });

  it('asks only of an external card in a gate lane that is not dropped', () => {
    const laneSet = lanes(PROJECT);
    const at = (task: BoardTask, audience: 'external' | 'internal' = 'external') =>
      gateOf({ task, laneSet, audience, projectName: 'Ferretry' }, stageGateLanes);
    should(at(external({ laneId: 'tested' }))).match({
      cardId: 'F1',
      laneId: 'tested',
      entry: 1,
      projectName: 'Ferretry',
    });
    should(at(external({ laneId: 'plan' }))?.options.map(option => option.label)).eql(['OK to build']);
    should(at(external({ laneId: 'implement' }))).be.undefined();
    should(at(external({ laneId: 'tested' }), 'internal')).be.undefined();
    should(at(external({ laneId: 'tested', dropped: { reason: 'not needed', at: NOW } }))).be.undefined();
  });

  it('writes the item from the card: its title, the lane’s ask and the gate’s options', () => {
    const task = external({ laneId: 'tested' });
    const gate = gateOf({ task, laneSet: lanes(PROJECT), audience: 'external' }, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');
    const raise = gateRaise(gate, task);
    should(raise).match({
      source: 'task',
      sourceRef: 'gate:F1:tested:1',
      title: 'Board store',
      kind: 'choice',
      subject: 'Try it: Open the Inbox',
      task: { id: 'F1' },
      premise: 'Gates raise one agenda item',
      context: null,
      body: '1. Open the Inbox\n2. Answer the card',
    });
    should(raise).not.have.property('steps');
    const long = gateRaise(gate, { ...task, howToTest: `1. ${'x'.repeat(9000)}`, summary: '' });
    should(long.body?.length).equal(8000);
    should(long.body?.endsWith('…')).be.true();
    should(long).not.have.property('premise');
    should(gateRaise(gate, { ...task, howToTest: '' })).not.have.property('body');
    should(raise.ask.options.map(option => option.label)).eql(['Done', 'Not good']);
    should(raise.answers).eql([
      { direction: 'left', label: 'Done', does: 'choose' },
      { direction: 'right', label: 'Not good', does: 'choose' },
    ]);
    const plan = gateOf(
      { task: external({ laneId: 'plan' }), laneSet: lanes(PROJECT), audience: 'external' },
      stageGateLanes,
    );
    should(gateRaise(plan as NonNullable<typeof plan>, external({ laneId: 'plan' })).subject).equal(
      'OK to build? Gates raise one agenda item',
    );
  });
});

describe('a card entering and leaving a gate', () => {
  it('raises exactly one gate item when a trigger moves the card into a gate lane', async () => {
    // Arrange
    const world = fixture([external()]);

    // Act — a fact moves it, then two more writes find it still there
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');
    await world.board.act('F1', BoardTaskActionRequestSchema.parse({ action: 'note', text: 'shipped' }), {
      kind: 'ferret',
      sessionId: 'child',
    });

    // Assert — on the assignee's agenda, raised by the daemon
    const items = world.open();
    should(items).have.length(1);
    should(items[0]).match({
      raisedBy: 'daemon',
      sourceRef: 'gate:F1:tested:2',
      kind: 'choice',
      task: { id: 'F1' },
      gate: {
        cardId: 'F1',
        laneId: 'tested',
        laneName: 'To test',
        entry: 2,
        projectId: PROJECT,
        projectName: 'Ferretry',
      },
    });
    should(world.open('child')).be.empty();
  });

  it('raises one item when the owner moves a card into a gate lane', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'todo' })]);

    // Act
    await world.move('plan');

    // Assert
    should(world.open().map(item => item.sourceRef)).eql(['gate:F1:plan:2']);
  });

  it('raises nothing for an internal card: its lead passes the gate', async () => {
    // Arrange
    const world = fixture([internal()]);

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    should(world.open()).be.empty();
    should(world.open('child')).be.empty();
  });

  it('resolves the open gate item quietly when the card leaves the gate some other way', async () => {
    // Arrange
    const world = fixture([external()]);
    await world.board.trigger('F1', 'release.running');

    // Act — the owner closes it on the Board
    await world.move('closed');

    // Assert
    should(world.open()).be.empty();
    should(world.closed()).have.length(1);
    should(world.closed()[0]).match({ resolvedBy: 'daemon', resolutionNote: GATE_MOVED_ON, disposition: 'done' });
  });

  it('raises a new item, and closes the old, when the card leaves and comes back', async () => {
    // Arrange
    const world = fixture([external()]);
    await world.board.trigger('F1', 'release.running');

    // Act
    await world.move('implement', OWNER, 'one more fix');
    await world.board.trigger('F1', 'release.running');

    // Assert
    should(world.open().map(item => item.sourceRef)).eql([`gate:F1:tested:${String(world.stored().history.length)}`]);
    should(world.closed().map(item => item.sourceRef)).eql(['gate:F1:tested:2']);
  });

  it('raises on the owner ferret’s agenda when the assignee has none', async () => {
    // Arrange
    const world = fixture([external({ assignee: 'gone' })]);

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    should(world.open('child').map(item => item.sourceRef)).eql(['gate:F1:tested:2']);
  });

  it('backfills one item for every external card already waiting at a gate, once', async () => {
    // Arrange
    const world = fixture([
      external({ id: 'F1', laneId: 'tested' }),
      internal({ id: 'F2', laneId: 'tested' }),
      external({ id: 'F3', laneId: 'implement' }),
    ]);

    // Act
    const first = await world.gates.backfill();
    const second = await world.gates.backfill();

    // Assert
    should(first).equal(1);
    should(second).equal(0);
    should(world.open().map(item => item.sourceRef)).eql(['gate:F1:tested:1']);
  });

  it('never raises the same entry again once the owner said Not needed', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'tested' })]);
    await world.gates.backfill();
    const [item] = world.open();

    // Act — the owner dismisses it; the card stays, and later writes find it still in the lane
    const dismissed = await world.agenda.dismiss('grandchild', (item as AgendaItem).id, HUMAN);
    await world.gates.written('F1');
    await world.gates.backfill();

    // Assert
    should(dismissed.ok).be.true();
    should(world.stored().laneId).equal('tested');
    should(world.open()).be.empty();
  });
});

describe('answering a gate item', () => {
  const atGate = async (laneId = 'tested', overrides: Partial<BoardTask> = {}) => {
    const world = fixture([external({ laneId, ...overrides })]);
    await world.gates.backfill();
    const item = world.open()[0];
    if (item === undefined) throw new Error('expected a gate item');
    return { world, item };
  };

  it('Done closes the card as the owner, then answers the item, and the ferret hears it once', async () => {
    // Arrange
    const { world, item } = await atGate();

    // Act
    const outcome = await world.answer(item.id, choose('Done'));

    // Assert
    should(outcome).match({ handled: true, mutation: { ok: true, change: 'answered' } });
    should(world.stored().laneId).equal('closed');
    should(world.stored().history.at(-1)).match({
      type: 'moved',
      to: 'closed',
      reason: 'Done (from the Inbox)',
      actor: { kind: 'owner' },
    });
    should(world.done.notices.map(notice => notice.task.id)).eql(['F1']);
    should(world.open()).be.empty();
    should(world.closed()[0]).match({
      id: item.id,
      resolvedBy: 'human',
      response: { kind: 'multiple-choice', choice: 'Done' },
    });
  });

  it('records the admin token’s answer as the admin token on the card', async () => {
    // Arrange
    const { world, item } = await atGate();

    // Act
    await world.answer(item.id, choose('Done'), { caller: { kind: 'owner', via: 'admin-token' } });

    // Assert
    should(world.stored().history.at(-1)).match({ actor: { kind: 'owner' }, actorVia: 'admin-token' });
  });

  it('OK to build moves the card on to the next lane', async () => {
    // Arrange
    const { world, item } = await atGate('plan');

    // Act
    await world.answer(item.id, choose('OK to build'));

    // Assert
    should(world.stored().laneId).equal('implement');
    should(world.open()).be.empty();
  });

  it('Not good without words is refused and changes nothing', async () => {
    // Arrange
    const { world, item } = await atGate();

    // Act
    const outcome = await world.answer(item.id, choose('Not good'));

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'invalid' } });
    should(world.stored().laneId).equal('tested');
    should(world.open().map(each => each.id)).eql([item.id]);
  });

  it('Not good with words reopens the card, tells the ferret, and opens ONE follow-up on its turn', async () => {
    // Arrange
    const { world, item } = await atGate();

    // Act
    const outcome = await world.answer(item.id, choose('Not good'), { note: 'the badge still counts it twice' });

    // Assert — the owner's Not good path: back to the rework lane, the words a clarification, the ladder told
    should(outcome).match({ handled: true, mutation: { ok: true } });
    const task = world.stored();
    should(task.laneId).equal('implement');
    should(task.clarifications.at(-1)).match({
      text: 'the badge still counts it twice',
      source: `owner (Inbox, !${item.id})`,
    });
    should(world.reopen.notices).have.length(1);
    should(world.reopen.notices[0]?.reason).startWith('the badge still counts it twice — talk it over on !A2');
    // … the gate item answered, and one conversation on the ferret's turn, about the card
    const open = world.open();
    should(open).have.length(1);
    should(open[0]).match({
      id: 'A2',
      raisedBy: 'daemon',
      kind: 'reply',
      sourceRef: 'gate-followup:F1:1',
      task: { id: 'F1' },
      waitingOn: 'ferret',
      waitingFor: 'discussion',
    });
    should(world.closed()[0]).match({
      id: item.id,
      response: { choice: 'Not good' },
      resolutionNote: 'the badge still counts it twice',
    });
  });

  it('takes the owner’s own words as Not good', async () => {
    // Arrange
    const { world, item } = await atGate();

    // Act
    await world.answer(item.id, { kind: 'other', answer: 'it crashes on open' });

    // Assert
    should(world.stored().laneId).equal('implement');
    should(world.stored().clarifications.at(-1)?.text).equal('it crashes on open');
  });

  it('closes the follow-up when the card comes back to the gate', async () => {
    // Arrange
    const { world, item } = await atGate();
    await world.answer(item.id, choose('Not good'), { note: 'still broken' });

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    const open = world.open();
    should(open).have.length(1);
    should(open[0]?.gate?.laneId).equal('tested');
    should(world.closed().find(each => each.sourceRef === 'gate-followup:F1:1')).match({ resolvedBy: 'daemon' });
  });

  it('Not yet leaves the card where it is: quiet without words, told to the ferret with them', async () => {
    // Arrange
    const quiet = await atGate('plan');
    const said = await atGate('plan');

    // Act
    await quiet.world.answer(quiet.item.id, choose('Not yet'));
    await said.world.answer(said.item.id, choose('Not yet'), { note: 'wait for the design review' });

    // Assert
    should(quiet.world.stored().laneId).equal('plan');
    should(quiet.world.told).be.empty();
    should(quiet.world.open()).be.empty();
    should(said.world.stored().laneId).equal('plan');
    should(said.world.stored().clarifications.at(-1)?.text).equal('wait for the design review');
    should(said.world.told).eql([
      {
        task: 'F1',
        message: '&F1: the owner is not ready to move it on yet: wait for the design review',
        key: `gate-not-yet-F1-${said.item.id}`,
      },
    ]);
  });

  it('leaves the item open with the reason when the board refuses the move', async () => {
    // Arrange — it waits on a card that has not shipped, which only the owner's override passes
    const { world, item } = await atGate('tested', {
      dependsOn: [{ task: { id: 'F9' }, until: 'shipped' }],
    });
    world.store.cards.set('F9', external({ id: 'F9', laneId: 'implement' }));

    // Act
    const outcome = await world.answer(item.id, choose('Done'));

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'not-moved' } });
    should(world.stored().laneId).equal('tested');
    should(world.open().map(each => each.id)).eql([item.id]);
  });

  it('closes an item whose card already moved on, and moves nothing', async () => {
    // Arrange — the card was moved where no write told the gates
    const { world, item } = await atGate();
    world.store.cards.set('F1', { ...world.stored(), laneId: 'implement' });

    // Act
    const outcome = await world.answer(item.id, choose('Done'));

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.stored().laneId).equal('implement');
    should(world.closed()[0]).match({ id: item.id, resolutionNote: GATE_MOVED_ON });
  });

  it('refuses a ferret, a lead and the daemon, and moves nothing', async () => {
    // Arrange
    const { world, item } = await atGate();
    const actors: readonly AgendaActor[] = [
      { kind: 'agent', sessionId: 'grandchild', name: null },
      { kind: 'agent', sessionId: 'child', name: null, overSubFerret: true },
      { kind: 'daemon', cause: 'system' },
    ];

    // Act
    const outcomes = await Promise.all(
      actors.map(async actor => await world.answer(item.id, choose('Done'), { actor })),
    );

    // Assert
    for (const outcome of outcomes) should(outcome).match({ handled: true, refused: { code: 'forbidden' } });
    should(world.stored().laneId).equal('tested');
    should(world.open().map(each => each.id)).eql([item.id]);
  });

  it('refuses a device the grants do not let move cards, before the board is touched', async () => {
    // Arrange
    const { world, item } = await atGate();

    // Act
    const outcome = await world.answer(item.id, choose('Done'), { permitted: () => 'this device may not move cards' });

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'forbidden', message: 'this device may not move cards' } });
    should(world.stored().laneId).equal('tested');
  });

  it('leaves every other item to the ordinary answer', async () => {
    // Arrange
    const world = fixture([external()]);
    await world.agenda.raise(
      'grandchild',
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Which colour?',
        why: 'The badge needs one.',
        howToResolve: 'Pick one.',
        kind: 'choice',
        ask: { kind: 'multiple-choice', options: [{ label: 'Red' }, { label: 'Blue' }] },
        premise: 'A badge.',
        context: 'On the Board.',
      },
      { kind: 'agent', sessionId: 'grandchild', name: null },
    );

    // Act
    const outcome = await world.answer('A1', choose('Red'));

    // Assert
    should(outcome).eql({ handled: false });
  });
});

describe('who may close a gate item on the agenda itself', () => {
  const raised = async () => {
    const world = fixture([external({ laneId: 'tested' })]);
    await world.gates.backfill();
    return { world, item: world.open()[0] as AgendaItem };
  };

  it('refuses its own ferret every verb that would close or reword it', async () => {
    // Arrange
    const { world, item } = await raised();
    const ferret: AgendaActor = { kind: 'agent', sessionId: 'grandchild', name: null };

    // Act
    const tries = [
      await world.agenda.answer('grandchild', item.id, choose('Done'), ferret),
      await world.agenda.resolve('grandchild', item.id, ferret, 'tested it myself'),
      await world.agenda.dismiss('grandchild', item.id, ferret),
      await world.agenda.edit('grandchild', item.id, { subject: 'Try it now' }, ferret),
      await world.agenda.surface('grandchild', item.id, ferret),
    ];

    // Assert
    for (const attempt of tries) should(attempt).match({ ok: false, error: { code: 'forbidden' } });
    should(world.open().map(each => each.id)).eql([item.id]);
  });

  it('refuses a lead over the sub-ferret whose agenda holds it', async () => {
    // Arrange — `child` started `grandchild`, so it may clear grandchild's own items, but not a gate
    const { world, item } = await raised();
    const lead: AgendaActor = { kind: 'agent', sessionId: 'child', name: null };

    // Act
    const tries = [
      await world.agenda.dismiss('grandchild', item.id, lead),
      await world.agenda.resolve('grandchild', item.id, lead, 'done'),
      await world.agenda.edit('grandchild', item.id, { subject: 'Try it now' }, lead),
    ];

    // Assert
    for (const attempt of tries) should(attempt).match({ ok: false, error: { code: 'forbidden' } });
  });

  it('refuses the daemon an answer, and lets it close the item quietly', async () => {
    // Arrange
    const { world, item } = await raised();
    const daemon: AgendaActor = { kind: 'daemon', cause: 'system' };

    // Act
    const answered = await world.agenda.answer('grandchild', item.id, choose('Done'), daemon);
    const resolved = await world.agenda.resolve('grandchild', item.id, daemon, GATE_MOVED_ON);

    // Assert
    should(answered).match({ ok: false, error: { code: 'forbidden' } });
    should(resolved).match({ ok: true, change: 'resolved' });
  });

  it('lets the card’s ferret close and hand back its follow-up conversation', async () => {
    // Arrange — a lead's own card, so the conversation is on the lead's agenda
    const world = fixture([
      external({ laneId: 'tested', owner: 'lead', assignee: null, createdBy: { kind: 'ferret', sessionId: 'lead' } }),
    ]);
    await world.gates.backfill();
    const item = world.open('lead')[0] as AgendaItem;
    await world.answer(item.id, choose('Not good'), { note: 'too slow', sessionId: 'lead' });
    const followup = world.open('lead')[0] as AgendaItem;
    const ferret: AgendaActor = { kind: 'agent', sessionId: 'lead', name: null };

    // Act
    const handed = await world.agenda.edit('lead', followup.id, { subject: 'Is 200 ms fast enough?' }, ferret);
    const closed = await world.agenda.resolve('lead', followup.id, ferret, 'agreed on 200 ms');

    // Assert
    should(followup.sourceRef).equal('gate-followup:F1:1');
    should(handed).match({ ok: true, change: 'refreshed' });
    should(closed).match({ ok: true, change: 'resolved' });
  });

  it('leaves a sub-ferret’s follow-up to its lead, as every agenda item of a sub-ferret is', async () => {
    // Arrange
    const { world, item } = await raised();
    await world.answer(item.id, choose('Not good'), { note: 'too slow' });
    const followup = world.open()[0] as AgendaItem;

    // Act
    const own = await world.agenda.resolve(
      'grandchild',
      followup.id,
      { kind: 'agent', sessionId: 'grandchild', name: null },
      'ok',
    );
    const lead = await world.agenda.resolve(
      'grandchild',
      followup.id,
      { kind: 'agent', sessionId: 'child', name: null },
      'ok',
    );

    // Assert
    should(own).match({ ok: false, error: { code: 'forbidden' } });
    should(lead).match({ ok: true, change: 'resolved' });
  });

  it('refuses a ferret a raise that carries a gate, a gate reference or a discussion start', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'tested' })]);
    // A lead: a sub-ferret raises nothing at all, so it never reaches the gate rule
    const ferret: AgendaActor = { kind: 'agent', sessionId: 'lead', name: null };
    const base = {
      source: 'agent-raised' as const,
      sourceRef: null,
      subject: 'Try it',
      why: 'It shipped.',
      howToResolve: 'Choose.',
      kind: 'choice' as const,
      ask: { kind: 'multiple-choice' as const, options: [{ label: 'Not good' }, { label: 'Done' }] },
      premise: 'It shipped.',
      context: 'On the Mac.',
    };
    const gate = {
      cardId: 'F1',
      laneId: 'tested',
      laneName: 'To test',
      entry: 1,
      projectId: PROJECT,
      options: [{ id: 'done', label: 'Done', outcome: 'close' as const }],
    };

    // Act
    const tries = [
      await world.agenda.raise('lead', { ...base, gate }, ferret),
      await world.agenda.raise('lead', { ...base, sourceRef: gateReference(gate) }, ferret),
      await world.agenda.raise('lead', { ...base, discussion: true }, ferret),
    ];

    // Assert
    for (const attempt of tries) should(attempt).match({ ok: false, error: { code: 'forbidden' } });
    should(world.open('lead')).be.empty();
  });
});

describe('when a port fails', () => {
  it('warns and changes nothing when the agenda cannot be written, on a write and at boot', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'tested' })], { raiseThrows: true });

    // Act
    await world.gates.written('F1');
    const raised = await world.gates.backfill();

    // Assert
    should(raised).equal(0);
    should(world.warnings).have.length(2);
    should(world.warnings[0]).containEql('could not follow it: the agenda is unwritable');
    should(world.warnings[1]).containEql('could not be raised: the agenda is unwritable');
  });

  it('warns when none of the card’s sessions can hold its gate item', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'tested', owner: 'ghost', assignee: 'gone' })]);

    // Act
    const raised = await world.gates.backfill();

    // Assert
    should(raised).equal(0);
    should(world.warnings[0]).match(/^no gate item for &F1 in To test: gone: .*; ghost: /u);
  });

  it('reopens without a follow-up when the ferret’s agenda cannot hold one', async () => {
    // Arrange — the assignee is gone; the gate item sits on the owner ferret's agenda
    const world = fixture([external({ laneId: 'tested', assignee: 'gone' })]);
    await world.gates.backfill();
    const item = world.open('child')[0] as AgendaItem;

    // Act
    const outcome = await world.answer(item.id, choose('Not good'), { sessionId: 'child', note: 'still broken' });

    // Assert
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored().laneId).equal('implement');
    should(world.reopen.notices[0]?.reason).equal('still broken');
    should(world.warnings[0]).startWith('no follow-up conversation for &F1');
  });

  it('closes the follow-up again when the board refuses the reopen', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'tested' })], { refuses: ['reopen'] });
    await world.gates.backfill();
    const item = world.open()[0] as AgendaItem;

    // Act
    const outcome = await world.answer(item.id, choose('Not good'), { note: 'still broken' });

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'not-moved' } });
    should(world.open().map(each => each.id)).eql([item.id]);
    should(world.closed().map(each => each.sourceRef)).eql(['gate-followup:F1:1']);
  });

  it('still closes Not yet when the words cannot be kept or told, and says so', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'plan' })], { refuses: ['clarify'], tellThrows: true });
    await world.gates.backfill();
    const item = world.open()[0] as AgendaItem;

    // Act
    const outcome = await world.answer(item.id, choose('Not yet'), { note: 'after the review' });

    // Assert
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.warnings).eql([
      "the owner's words on &F1 were not kept: &F1 was not moved: the board refused the clarify",
      "could not tell &F1's ferret: nobody to tell",
    ]);
  });
});

describe('answers a gate does not take', () => {
  const at = async (laneId: string) => {
    const world = fixture([external({ laneId })]);
    await world.gates.backfill();
    return { world, item: world.open()[0] as AgendaItem };
  };

  it('refuses words alone at a gate that has no Not good', async () => {
    const { world, item } = await at('plan');
    should(await world.answer(item.id, { kind: 'other', answer: 'not this way' })).match({
      handled: true,
      refused: { code: 'invalid', message: `${item.id} is answered with one of its options: OK to build` },
    });
  });

  it('refuses an answer of another shape, and an option the gate does not have', async () => {
    const { world, item } = await at('tested');
    should(await world.answer(item.id, { kind: 'permission', decision: 'approve' })).match({
      handled: true,
      refused: { code: 'invalid' },
    });
    should(await world.answer(item.id, choose('Ship it'))).match({
      handled: true,
      refused: { code: 'invalid', message: `${item.id} has no option Ship it` },
    });
    should(world.stored().laneId).equal('tested');
  });
});

describe('the gate lanes from the workflow model', () => {
  const laneSet = lanes(PROJECT);

  it('says why an option leads nowhere', () => {
    should(stageGateLanes.outcomeLane(laneSet, 'design-first', 'implement', 'done')).match({
      ok: false,
      message: 'implement does not wait on the owner any more',
    });
    should(stageGateLanes.outcomeLane(laneSet, 'design-first', 'tested', 'ship')).match({
      ok: false,
      message: 'tested has no option ship any more',
    });
    should(stageGateLanes.outcomeLane(laneSet, 'design-first', 'gone', 'done')).match({
      ok: false,
      message: 'that lane is not on this board any more',
    });
    const last: LaneSet = {
      ...laneSet,
      lanes: laneSet.lanes
        .map(lane => (lane.id === 'closed' ? { ...lane, ownerGate: false } : lane))
        .filter(lane => lane.id !== 'closed')
        .concat([{ id: 'closed', name: 'Closed', category: 'closed', ownerGate: true }]),
    };
    const planLast: LaneSet = {
      ...last,
      variants: { ...last.variants, 'design-first': ['todo', 'plan'] },
    };
    should(stageGateLanes.outcomeLane(planLast, 'design-first', 'plan', 'ok')).match({
      ok: false,
      message: 'plan has no lane after it',
    });
  });

  it('reads a refile as the entry into the lane it landed in, and no entry without one', () => {
    const refiled = external({
      laneId: 'tested',
      history: [
        { seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'todo' },
        {
          seq: 2,
          at: NOW,
          actor: { kind: 'daemon' },
          type: 'refiled',
          fromProject: PROJECT,
          toProject: PROJECT,
          toLane: 'tested',
          reason: null,
        },
      ],
    });
    should(gateEntry(refiled)).equal(2);
    should(
      gateEntry({
        laneId: 'tested',
        history: [{ seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'note', text: 'hi' }],
      }),
    ).be.undefined();
  });
});

describe('a PR open while the card waits at its gate', () => {
  const openPr = {
    url: 'https://github.com/kirinnee/ferretry/pull/941',
    number: 941,
    repo: 'kirinnee/ferretry',
    state: 'open' as const,
    draft: false,
    checks: 'pending' as const,
    mergedAt: null,
    mergeSha: null,
    releasedIn: null,
    polledAt: NOW,
  };

  it('says so on the gate item, and stops saying so when the PR closes, without a second item', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'tested' })]);
    await world.gates.backfill();
    const [item] = world.open();

    // Act — the PR opens, then is closed, while the card stays at the gate
    world.store.cards.set('F1', { ...world.stored(), links: { ...world.stored().links, prs: [openPr] } });
    await world.gates.written('F1');
    const told = world.open();
    world.store.cards.set('F1', {
      ...world.stored(),
      links: { ...world.stored().links, prs: [{ ...openPr, state: 'closed' }] },
    });
    await world.gates.written('F1');

    // Assert
    should(told).have.length(1);
    should(told[0]).match({ id: item?.id, context: `A new PR is open for this card: ${openPr.url}` });
    should(world.open()).have.length(1);
    should(world.open()[0]).match({ id: item?.id, context: null });
    should(world.stored().laneId).equal('tested');
  });

  it('closes the card normally when the owner answers Done while the PR is open', async () => {
    // Arrange
    const world = fixture([
      external({ laneId: 'tested', links: { prs: [openPr], branch: null, commits: [], docs: [] } }),
    ]);
    await world.gates.backfill();
    const [item] = world.open();

    // Act
    const outcome = await world.answer((item as AgendaItem).id, choose('Done'));

    // Assert
    should(item?.context).equal(`A new PR is open for this card: ${openPr.url}`);
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored().laneId).equal('closed');
    should(world.open()).be.empty();
  });
});
