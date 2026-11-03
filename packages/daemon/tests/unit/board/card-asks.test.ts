import { describe, it } from 'bun:test';
import {
  agendaState,
  type AgendaItem,
  type AgendaResponse,
  type BoardTask,
  type BoardTaskActionRequest,
  BoardTaskActionRequestSchema,
  gateReference,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';
import should from 'should';
import { BoardGateCards } from '../../../src/adapters/board/board-gate-cards.ts';
import { StoreBoardAttachments } from '../../../src/adapters/board/board-attachments.ts';
import {
  type AgendaActor,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  parseAgendaLedger,
} from '../../../src/lib/agenda/index.ts';
import {
  type BoardCaller,
  BoardService,
  type GateAnswer,
  GateItems,
  gateOf,
  cardAgendaRaise,
  stageGateLanes,
} from '../../../src/lib/board/index.ts';
import { card, FakeDone, FakeReopen, lanes, MemoryBoardStore, NOW, world } from './support.ts';

/**
 * CARD ASKS (docs/board.md § Cards show progress; docs/agenda.md § Card asks), over the REAL board and agenda services
 * with their stores in memory: a card entering a gate puts ONE card ask on the agenda that carries it — never a
 * standalone gate item —, leaving withdraws it, and only the owner's answer moves the card, first, through the board,
 * before the answer is recorded and the agenda rests.
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

/** The ferrets &F291 passed through, in order, each change of hands raising its gate again before B138. */
const F291_FERRETS = ['coleson', 'khristina', 'dyani', 'rayce', 'avary'] as const;

/** `lead` started `child`, which started `grandchild`; the card is `child`'s, worked by `grandchild`. */
const LEADS: Readonly<Record<string, string>> = { child: 'lead', grandchild: 'child' };
const SESSIONS = new Set(['lead', 'child', 'grandchild', 'stranger', 'peer', 'other', ...F291_FERRETS]);

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
  /** Listing every session throws this many times, then answers. */
  readonly listAllThrows?: number;
  /** The board cannot be read: asking for a card throws. */
  readonly boardThrows?: boolean;
  /** These sessions' agendas cannot be read. */
  readonly unreadable?: readonly string[];
  /** Resolving an item on these sessions' agendas throws. */
  readonly resolveThrows?: readonly string[];
  /** The duplicates sweep already ran. */
  readonly swept?: boolean;
  /** The agenda home of these sessions; every other session is its own. */
  readonly homes?: Readonly<Record<string, string>>;
  /** The instant the gates read as now; the agenda's own clock stays at NOW. */
  readonly gatesNow?: string;
  /** This daemon cannot carry files with an answer (no carrier is wired). */
  readonly noCarrier?: boolean;
  /** Carrying a file throws. */
  readonly carryThrows?: boolean;
  /** The real attachment store behind both the board's file check and the carrier, instead of stand-ins that accept any id. */
  readonly attachmentStore?: StoreBoardAttachments;
}

/** The duplicates sweep's marker, in memory. */
class Marker {
  readonly records: { readonly at: string; readonly closed: readonly string[] }[] = [];
  constructor(private readonly already: boolean) {}

  async ran(): Promise<boolean> {
    return this.already || this.records.length > 0;
  }

  async record(at: string, closed: readonly string[]): Promise<void> {
    this.records.push({ at, closed });
  }
}

const fixture = (cards: readonly BoardTask[], faults: Faults = {}) => {
  const ledgers = new Ledgers();
  const warnings: string[] = [];
  const told: { readonly task: string; readonly message: string; readonly key: string }[] = [];
  const marker = new Marker(faults.swept ?? true);
  let listAllThrows = faults.listAllThrows ?? 0;
  const store = new MemoryBoardStore(cards);
  const reopen = new FakeReopen();
  const done = new FakeDone();
  const carried: Array<readonly [string, string, readonly string[]]> = [];
  let gates: GateItems | undefined;
  const board = new BoardService(
    world({
      store,
      reopen,
      done,
      gates: { written: async id => await gates?.written(id) },
      attachments: faults.attachmentStore ?? {
        describe: async (_session, ids) => ids.map(id => ({ id, filename: `${id}.png`, mime: 'image/png' })),
      },
    }),
  );
  const homes = {
    of: async (sessionId: string) => {
      const home = faults.homes?.[sessionId];
      if (home === '!') throw new Error('unreadable');
      return home ?? sessionId;
    },
  };
  const agenda = new AgendaService(
    ledgers,
    { now: () => NOW },
    { has: async sessionId => SESSIONS.has(sessionId) },
    { raised: async () => undefined },
    undefined,
    undefined,
    { leadOf: async sessionId => LEADS[sessionId], addressOf: async sessionId => sessionId },
    undefined,
    homes,
    // Whether a card is asking already: the gates, read lazily as the daemon wires them.
    { asking: async ref => await gates?.asking(ref.id) },
  );
  const cards_ = new BoardGateCards(board, { project: async () => ({ name: 'Ferretry' }) });
  const buildGates = (): GateItems =>
    new GateItems({
      agenda: {
        list: async sessionId => {
          if (faults.unreadable?.includes(sessionId) === true) throw new Error('the agenda is unreadable');
          return await agenda.list(sessionId);
        },
        raise: async (sessionId, request, actor) => {
          if (faults.raiseThrows === true) throw new Error('the agenda is unwritable');
          return await agenda.raise(sessionId, request, actor);
        },
        resolve: async (sessionId, id, actor, note) => {
          if (faults.resolveThrows?.includes(sessionId) === true) throw new Error('the agenda is unwritable');
          return await agenda.resolve(sessionId, id, actor, note);
        },
        answer: async (sessionId, id, response, actor) => await agenda.answer(sessionId, id, response, actor),
        cardAsk: async (sessionId, id, operation) => await agenda.cardAsk(sessionId, id, operation),
      },
      board: {
        card: async id => {
          if (faults.boardThrows === true) throw new Error('the board is unreadable');
          return await cards_.card(id);
        },
        cards: async () => await cards_.cards(),
        act: async (id, request, caller, expect) => {
          if (faults.refuses?.includes(request.action) === true)
            throw new Error(`the board refused the ${request.action}`);
          await cards_.act(id, request, caller, expect);
        },
      },
      lanes: stageGateLanes,
      homes,
      sessions: {
        all: async () => {
          if (listAllThrows > 0) {
            listAllThrows -= 1;
            throw new Error('the sessions cannot be listed');
          }
          return [...new Set([...SESSIONS, ...ledgers.ledgers.keys()])];
        },
      },
      ...(faults.noCarrier === true
        ? {}
        : {
            files: faults.attachmentStore ?? {
              carry: async (from: string, to: string, ids: readonly string[]) => {
                if (faults.carryThrows === true) throw new Error('the copy failed');
                carried.push([from, to, ids]);
                return ids;
              },
            },
          }),
      marker,
      now: () => faults.gatesNow ?? NOW,
      words: {
        told: async (task, message, key) => {
          if (faults.tellThrows === true) throw new Error('nobody to tell');
          told.push({ task: task.id, message, key });
        },
      },
      diagnostics: { warn: message => warnings.push(message) },
    });
  gates = buildGates();
  /** A daemon that stopped and started: every ledger read back from its stored form, and a GateItems built anew. */
  const restart = (): GateItems => {
    for (const [sessionId, ledger] of ledgers.ledgers) {
      const reloaded = parseAgendaLedger(JSON.parse(JSON.stringify(ledger)), sessionId);
      if (reloaded === null) throw new Error(`the ledger of ${sessionId} did not read back`);
      ledgers.ledgers.set(sessionId, reloaded);
    }
    gates = buildGates();
    return gates;
  };
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
    ledgers,
    board,
    marker,
    get gates(): GateItems {
      return gates as GateItems;
    },
    restart,
    store,
    reopen,
    done,
    carried,
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

const AGENT: AgendaActor = { kind: 'agent', sessionId: 'lead', name: 'Ada' };
const DAEMON: AgendaActor = { kind: 'daemon', cause: 'system' };

/** A ferret's own thread about the card, on the owner's turn. */
const threadAbout = (cardId: string) => ({
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Can you look at the badge?',
  why: 'It changed.',
  premise: 'The badge changed.',
  context: 'It is on the card.',
  howToResolve: 'Say what you think.',
  ask: { kind: 'open-question' as const },
  kind: 'reply' as const,
  task: { id: cardId },
});

/** A card of `lead`'s own, which the owner asked for: its agenda home is `lead`. */
const leads = (overrides: Partial<BoardTask> = {}): BoardTask =>
  external({ owner: 'lead', assignee: null, createdBy: { kind: 'ferret', sessionId: 'lead' }, ...overrides });

const openOf = (world: ReturnType<typeof fixture>, sessionId: string, id: string): AgendaItem => {
  const found = world.open(sessionId).find(item => item.id === id);
  if (found === undefined) throw new Error(`${id} is not open on ${sessionId}`);
  return found;
};

/** A card at To test with its ask on a new agenda of its ferret (`grandchild`); the agenda and its ask's reference. */
const atTest = async (faults: Faults = {}) => {
  const world = fixture([external()], faults);
  await world.board.trigger('F1', 'release.running');
  const [item] = world.open();
  if (item === undefined) throw new Error('expected a card agenda');
  return { world, item, reference: 'gate:F1:tested:2' };
};

describe('a card at a gate asks on its agenda, never on its own', () => {
  it('opens ONE agenda named after the card, carrying its How to test and Done / Not good (DoD 6)', async () => {
    // Arrange
    const world = fixture([external()]);

    // Act — a fact moves it in, then two more writes find it still there
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');
    await world.gates.backfill();

    // Assert — one agenda, on the assignee's home, with the ask inside it and no standalone gate item
    const items = world.open();
    should(items).have.length(1);
    const [item] = items as [AgendaItem];
    should(item.gate).be.undefined();
    should(item).match({
      raisedBy: 'daemon',
      sourceRef: 'card-agenda:F1',
      kind: 'reply',
      task: { id: 'F1' },
      title: external().title,
      stage: 'test',
    });
    should(item.cardAsks).have.length(1);
    should(item.cardAsks?.[0]).match({
      gate: { cardId: 'F1', laneId: 'tested', entry: 2, options: [{ label: 'Done' }, { label: 'Not good' }] },
      howToTest: '1. Open the Inbox\n2. Answer the card',
    });
    should(item.cardAsks?.[0]?.answer).be.undefined();
    should(item.gateAttached).eql(item.cardAsks?.[0]?.gate);
    should(agendaState(item).state).equal('needs-you');
    should(world.open('child')).be.empty();
  });

  it('asks OK to build at a plan gate, at stage plan', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'todo' })]);

    // Act
    await world.move('plan');

    // Assert
    const [item] = world.open() as [AgendaItem];
    should(item.stage).equal('plan');
    should(item.cardAsks?.map(ask => ask.gate.options.map(option => option.label))).eql([['OK to build']]);
  });

  it('asks nothing for an internal card: its lead passes the gate', async () => {
    // Arrange
    const world = fixture([internal()]);

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    should(world.open()).be.empty();
    should(world.open('child')).be.empty();
  });

  it('puts the ask on the open agenda that already carries the card, and opens none', async () => {
    // Arrange — the ferret's thread about the card, then the card reaches the gate
    const world = fixture([leads()]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok) throw new Error(raised.error.message);

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    const items = world.open('lead');
    should(items.map(item => item.id)).eql([raised.item?.id]);
    should(items[0]?.cardAsks?.map(ask => ask.gate.cardId)).eql(['F1']);
    should(items[0]?.stage).equal('test');
  });

  it('else puts it on the agenda that carries the parent card', async () => {
    // Arrange — the parent's thread; the sub-card reaches its plan gate
    const world = fixture([leads(), leads({ id: 'F2', laneId: 'todo', parent: { id: 'F1' } })]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok) throw new Error(raised.error.message);

    // Act
    await world.board.act('F2', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);

    // Assert
    const items = world.open('lead');
    should(items).have.length(1);
    should(items[0]?.cardAsks?.map(ask => ask.gate.cardId)).eql(['F2']);
  });

  it('wakes a snoozed agenda that carries the card: the ask is a blocker', async () => {
    // Arrange — the owner snoozed the ferret's thread about the card
    const world = fixture([leads()]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    await world.agenda.snooze('lead', raised.item.id, '2030-01-01T00:00:00.000Z', HUMAN);
    should(agendaState(openOf(world, 'lead', raised.item.id)).state).equal('snoozed');

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    should(agendaState(openOf(world, 'lead', raised.item.id)).state).equal('needs-you');
  });

  it('withdraws the ask when the card leaves the gate some other way, and keeps the agenda', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act — the owner closes it on the Board
    await world.move('closed');

    // Assert
    const after = openOf(world, 'grandchild', item.id);
    should(after.cardAsks).be.undefined();
    should(after.gateAttached).be.undefined();
  });

  it('asks the next entry on the same agenda when the card comes back to the gate', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act
    await world.move('implement', OWNER, 'one more fix');
    await world.board.trigger('F1', 'release.running');

    // Assert — still one agenda; the old entry's ask went, the new one is open
    const items = world.open();
    should(items.map(each => each.id)).eql([item.id]);
    should(items[0]?.cardAsks?.map(ask => ask.gate.entry)).eql([4]);
  });

  it('never asks an entry again once the owner set its agenda aside', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act — Not needed, then more writes
    await world.agenda.dismiss('grandchild', item.id, HUMAN);
    await world.gates.written('F1');
    await world.gates.backfill();

    // Assert
    should(world.open()).be.empty();
  });

  it('tells where the card is asking, for the add refusal', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act
    const asking = await world.gates.asking('F1');

    // Assert
    should(asking).eql({ sessionId: 'grandchild', id: item.id });
  });
});

describe('answering a card ask', () => {
  it('Done closes the card as the owner, records the answer, and RESTS the agenda on its ferret', async () => {
    // Arrange
    const { world, item, reference } = await atTest();

    // Act
    const outcome = await world.answer(item.id, choose('Done'), { cardAsk: reference });

    // Assert — the card moved first, the agenda is open and resting, never closed by the answer
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored().laneId).equal('closed');
    const after = openOf(world, 'grandchild', item.id);
    should(after.cardAsks?.[0]?.answer).match({ response: choose('Done') });
    should(after.cardAsks?.[0]?.answer?.receipt).match(/^[0-9a-f]{64}$/u);
    should(after.gateAttached).be.undefined();
    should(agendaState(after)).match({ state: 'resting', sub: 'waiting-on-ferret' });
    should(world.closed()).be.empty();
    should(world.told.map(each => each.message)).containDeep([
      `&F1: the owner said Done on !${item.id}. Mark !${item.id} done once nothing more is expected.`,
    ]);
  });

  it('OK to build moves the card on to the next lane', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'todo' })]);
    await world.move('plan');
    const [item] = world.open() as [AgendaItem];

    // Act
    await world.answer(item.id, choose('OK to build'), { cardAsk: 'gate:F1:plan:2' });

    // Assert
    should(world.stored().laneId).equal('implement');
  });

  it('Not good with words reopens the card and keeps the talk on the same agenda', async () => {
    // Arrange
    const { world, item, reference } = await atTest();

    // Act
    await world.answer(item.id, choose('Not good'), { cardAsk: reference, note: 'still flickers' });

    // Assert — reopened once, no second item
    should(world.stored().laneId).equal('implement');
    should(world.reopen.notices).have.length(1);
    should(world.open().map(each => each.id)).eql([item.id]);
    should(openOf(world, 'grandchild', item.id).cardAsks?.[0]?.answer?.note).equal('still flickers');
  });

  it('refuses Not good without words, and moves nothing', async () => {
    // Arrange
    const { world, item, reference } = await atTest();

    // Act
    const outcome = await world.answer(item.id, choose('Not good'), { cardAsk: reference });

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'invalid' } });
    should(world.stored().laneId).equal('tested');
    should(openOf(world, 'grandchild', item.id).cardAsks?.[0]?.answer).be.undefined();
  });

  it('Not yet leaves the card and the ask open, rests the agenda, and tells the ferret the words', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'todo' })]);
    await world.move('plan');
    const [item] = world.open() as [AgendaItem];

    // Act
    await world.answer(item.id, choose('Not yet'), { cardAsk: 'gate:F1:plan:2', note: 'after the demo' });

    // Assert
    should(world.stored().laneId).equal('plan');
    const after = openOf(world, 'grandchild', item.id);
    should(after.cardAsks?.[0]?.answer).be.undefined();
    should(after.cardAsks?.[0]?.notYet).match({ note: 'after the demo' });
    should(agendaState(after).state).equal('resting');
    should(world.told.map(each => each.message)).containDeep([
      '&F1: the owner is not ready to move it on yet: after the demo',
    ]);
  });

  it('refuses a ferret, a lead and the daemon, and moves nothing', async () => {
    // Arrange
    const { world, item, reference } = await atTest();

    // Act
    const outcomes = [
      await world.answer(item.id, choose('Done'), {
        cardAsk: reference,
        actor: { kind: 'agent', sessionId: 'grandchild', name: null },
      }),
      await world.answer(item.id, choose('Done'), {
        cardAsk: reference,
        actor: { kind: 'agent', sessionId: 'child', name: null, overSubFerret: true },
      }),
      await world.answer(item.id, choose('Done'), { cardAsk: reference, actor: DAEMON }),
    ];

    // Assert
    for (const outcome of outcomes) should(outcome).match({ handled: true, refused: { code: 'forbidden' } });
    should(world.stored().laneId).equal('tested');
  });

  it('refuses a device the grants do not let move cards, before the board is touched', async () => {
    // Arrange
    const { world, item, reference } = await atTest();

    // Act
    const outcome = await world.answer(item.id, choose('Done'), {
      cardAsk: reference,
      permitted: () => 'this device may not use the agent fleet, so it may not move a card',
    });

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'forbidden' } });
    should(world.stored().laneId).equal('tested');
  });

  it('refuses an answer to an ask whose card moved on, withdraws it, and moves nothing', async () => {
    // Arrange — a stale tab: the card was moved back on the Board after the ask went up
    const { world, item, reference } = await atTest();
    await world.move('implement', OWNER, 'one more fix');

    // Act
    const outcome = await world.answer(item.id, choose('Done'), { cardAsk: reference });

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.stored().laneId).equal('implement');
  });

  it('takes the same answer again as the one it already recorded, and closes the card once', async () => {
    // Arrange
    const { world, item, reference } = await atTest();
    await world.answer(item.id, choose('Done'), { cardAsk: reference });

    // Act — the response was lost, so the same answer comes again
    const again = await world.answer(item.id, choose('Done'), { cardAsk: reference });

    // Assert
    should(again).match({ handled: true, mutation: { ok: true, changed: false } });
    should(world.done.notices).have.length(1);
  });

  it('refuses the same choice with other words as a stale tab, never a success that drops them', async () => {
    // Arrange
    const { world, item, reference } = await atTest();
    await world.answer(item.id, choose('Not good'), { cardAsk: reference, note: 'flickers' });

    // Act
    const other = await world.answer(item.id, choose('Not good'), { cardAsk: reference, note: 'it is fine now' });

    // Assert
    should(other).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.reopen.notices).have.length(1);
  });

  it('answers the shown ask for an app that predates card asks (gate: true, no ask named)', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act
    const outcome = await world.answer(item.id, choose('Done'), { gate: true });

    // Assert
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored().laneId).equal('closed');
  });

  it('never spends an older app’s retried answer on an ask that took the answered one’s place', async () => {
    // Arrange — the thread carries F1's ask; the owner answers it, then F2's ask takes its place
    const world = fixture([leads(), leads({ id: 'F2' })]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    await world.board.trigger('F1', 'release.running');
    await world.answer(id, choose('Done'), { sessionId: 'lead', gate: true });
    await world.board.trigger('F2', 'release.running');
    const f2 = gateOf({ task: world.stored('F2'), laneSet: lanes(), audience: 'external' }, stageGateLanes);
    if (f2 === undefined) throw new Error('expected F2 at its gate');
    await world.agenda.cardAsk('lead', id, { kind: 'attach', ask: { gate: f2 } });
    should(openOf(world, 'lead', id).gateAttached?.cardId).equal('F2');

    // Act — the first tap's response was lost, and the old app sends it again
    const retried = await world.answer(id, choose('Done'), { sessionId: 'lead', gate: true });

    // Assert — refused, F2 untouched; naming the ask answers it
    should(retried).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.stored('F2').laneId).equal('tested');
    const named = await world.answer(id, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F2:tested:2' });
    should(named).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F2').laneId).equal('closed');
  });

  it('leaves an answer that names no card ask to the agenda’s own ask', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act
    const outcome = await world.answer(item.id, { kind: 'open-question', answer: 'looks good' });

    // Assert
    should(outcome).eql({ handled: false });
    should(world.stored().laneId).equal('tested');
  });
});

describe('an agenda with an open card ask is the owner’s to answer', () => {
  it('refuses its ferret done, dismiss and rest while the ask is open, and allows done after the answer', async () => {
    // Arrange — the lead's own card: its agenda is on the lead's board, which it works as its own
    const world = fixture([leads()]);
    await world.board.trigger('F1', 'release.running');
    const [item] = world.open('lead') as [AgendaItem];

    // Act
    const done = await world.agenda.resolve('lead', item.id, AGENT, 'all good');
    const dismissed = await world.agenda.dismiss('lead', item.id, AGENT);
    const rested = await world.agenda.rest('lead', item.id, 'looking at it', AGENT);
    await world.answer(item.id, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F1:tested:2' });
    const after = await world.agenda.resolve('lead', item.id, AGENT, 'released and tried');

    // Assert
    for (const refused of [done, dismissed, rested]) should(refused).match({ ok: false, error: { code: 'invalid' } });
    should(after).match({ ok: true, change: 'resolved' });
  });

  it('refuses the owner a bare done, and keeps Not needed theirs', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act
    const bare = await world.agenda.resolve('grandchild', item.id, HUMAN);
    const notNeeded = await world.agenda.dismiss('grandchild', item.id, HUMAN);

    // Assert
    should(bare).match({ ok: false, error: { code: 'invalid' } });
    should(notNeeded).match({ ok: true, change: 'dismissed' });
    should(world.stored().laneId).equal('tested');
  });

  it('refuses a ferret a raise that carries a card ask', async () => {
    // Arrange
    const world = fixture([leads()]);
    const gate = gateOf({ task: leads({ laneId: 'tested' }), laneSet: lanes(), audience: 'external' }, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');

    // Act
    const raised = await world.agenda.raise('lead', { ...threadAbout('F1'), cardAsks: [{ gate, at: NOW }] }, AGENT);

    // Assert
    should(raised).match({ ok: false, error: { code: 'forbidden' } });
  });

  it('refuses a ferret’s second ask about a card that is asking, pointing to the agenda that carries it', async () => {
    // Arrange — the card's own agenda is on the ferret's own board
    const world = fixture([leads()]);
    await world.board.trigger('F1', 'release.running');
    const [carrier] = world.open('lead') as [AgendaItem];

    // Act
    const second = await world.agenda.raise('lead', threadAbout('F1'), AGENT);

    // Assert
    should(second).match({ ok: false, error: { code: 'invalid' } });
    if (second.ok) return;
    should(second.error.message).containEql(`already asks the owner on !${carrier.id}, which carries the card`);
    should(second.error.message).containEql(`fy agenda edit ${carrier.id}`);
  });
});

describe('open gate items from before card asks', () => {
  /** A standalone gate item as an older daemon raised it, straight into the ledger. */
  const legacyGateItem = async (world: ReturnType<typeof fixture>, sessionId: string, task: BoardTask) => {
    const gate = gateOf({ task, laneSet: lanes(), audience: 'external', projectName: 'Ferretry' }, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');
    const labels = gate.options.map(option => option.label);
    const raised = await world.agenda.raise(
      sessionId,
      {
        source: 'task',
        sourceRef: gateReference(gate),
        title: task.title,
        kind: 'choice',
        subject: 'Try it: Open the Inbox',
        why: `&${task.id} reached To test, which waits on you.`,
        howToResolve: 'Choose Done or Not good; the card moves when you answer.',
        body: task.howToTest ?? undefined,
        ask: { kind: 'multiple-choice', options: labels.map(label => ({ label })) },
        task: { id: task.id },
        gate,
      },
      DAEMON,
    );
    if (!raised.ok || raised.item === undefined) throw new Error('expected a legacy gate item');
    return raised.item;
  };

  it('reads an open gate item as its card’s agenda, losslessly, and its answer moves the card', async () => {
    // Arrange — the card waits at To test with an older daemon's gate item
    const task = external({
      laneId: 'tested',
      history: [
        { seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'implement' },
        {
          seq: 2,
          at: NOW,
          actor: { kind: 'daemon' },
          type: 'moved',
          from: 'implement',
          to: 'tested',
          backward: false,
          reason: null,
          auto: true,
          trigger: 'release.running',
        },
      ],
    });
    const world = fixture([task]);
    const legacy = await legacyGateItem(world, 'grandchild', task);

    // Act — the daemon restarts on the new shape
    world.restart();
    await world.gates.backfill();

    // Assert — the same item, now the card's agenda carrying the ask; no gate item is left
    const items = world.open();
    should(items.map(item => item.id)).eql([legacy.id]);
    should(items[0]?.gate).be.undefined();
    should(items[0]).match({
      sourceRef: 'card-agenda:F1',
      kind: 'reply',
      stage: 'test',
      waitingSince: legacy.waitingSince,
    });
    should(items[0]?.cardAsks?.[0]).match({ gate: legacy.gate, howToTest: task.howToTest });
    const answered = await world.answer(legacy.id, choose('Done'), { cardAsk: 'gate:F1:tested:2' });
    should(answered).match({ handled: true, mutation: { ok: true } });
    should(world.stored().laneId).equal('closed');
  });

  it('merges a gate item and a thread on the same card into ONE agenda', async () => {
    // Arrange — an older daemon left both open on the lead's board
    const task = leads({
      laneId: 'tested',
      history: [{ seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'tested' }],
    });
    const world = fixture([task]);
    const thread = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!thread.ok || thread.item === undefined) throw new Error('expected a thread');
    const legacy = await legacyGateItem(world, 'lead', task);

    // Act
    world.restart();

    // Assert
    should(world.open('lead').map(item => item.id)).eql([thread.item.id]);
    should(openOf(world, 'lead', thread.item.id).cardAsks?.map(ask => ask.gate.cardId)).eql(['F1']);
    should(world.closed('lead').find(item => item.id === legacy.id)?.resolutionNote).equal(
      `its card's ask is now on !${thread.item.id}`,
    );
  });
});

describe('the new agenda for a card', () => {
  it('is written from the card: its title, the lane’s ask line, its How to test and the ask itself', () => {
    // Arrange
    const task = external({
      laneId: 'tested',
      history: [{ seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'tested' }],
    });
    const gate = gateOf({ task, laneSet: lanes(), audience: 'external' }, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');

    // Act
    const request = cardAgendaRaise(gate, task, NOW);

    // Assert
    should(request).match({
      source: 'task',
      sourceRef: 'card-agenda:F1',
      kind: 'reply',
      ask: { kind: 'open-question' },
      subject: 'Try it: Open the Inbox',
      task: { id: 'F1' },
      stage: 'test',
      cardAsks: [{ gate, at: NOW, howToTest: '1. Open the Inbox\n2. Answer the card' }],
    });
    should(request.gate).be.undefined();
  });
});
