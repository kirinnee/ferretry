import { describe, it } from 'bun:test';
import {
  agendaState,
  type AgendaItem,
  type AgendaResponse,
  type BoardTask,
  type BoardTaskActionRequest,
  type LaneSet,
  BoardTaskActionRequestSchema,
  gateReference,
  MAX_AGENDA_BODY_LENGTH,
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
  gateEntry,
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
  /** Raising on these sessions is refused, as a full agenda refuses it. */
  readonly raiseRefuses?: readonly string[];
  /** Every card-ask write is refused. */
  readonly cardAskRefuses?: boolean;
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
  /** An item the gates' reads stop seeing after this many reads: one pruned, or closed and gone, mid-answer. */
  let vanishing: { id: string; after: number } | undefined;
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
          const listed = await agenda.list(sessionId);
          if (vanishing === undefined || !listed.ok) return listed;
          if (vanishing.after > 0) {
            vanishing.after -= 1;
            return listed;
          }
          const gone = vanishing.id;
          return {
            ...listed,
            value: {
              ...listed.value,
              items: listed.value.items.filter(each => each.id !== gone),
              resolved: listed.value.resolved.filter(each => each.id !== gone),
            },
          };
        },
        raise: async (sessionId, request, actor) => {
          if (faults.raiseThrows === true) throw new Error('the agenda is unwritable');
          if (faults.raiseRefuses?.includes(sessionId) === true)
            return { ok: false, error: { code: 'invalid', message: 'the agenda is full' } } as AgendaMutation;
          return await agenda.raise(sessionId, request, actor);
        },
        resolve: async (sessionId, id, actor, note) => {
          if (faults.resolveThrows?.includes(sessionId) === true) throw new Error('the agenda is unwritable');
          return await agenda.resolve(sessionId, id, actor, note);
        },
        answer: async (sessionId, id, response, actor) => await agenda.answer(sessionId, id, response, actor),
        cardAsk: async (sessionId, id, operation) =>
          faults.cardAskRefuses === true
            ? ({ ok: false, error: { code: 'invalid', message: 'the agenda refused it' } } as AgendaMutation)
            : await agenda.cardAsk(sessionId, id, operation),
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
    vanish: (id: string, after: number) => {
      vanishing = { id, after };
    },
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

  it('closes the daemon-opened card agenda when its last ask is withdrawn and nobody talked on it', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act — the owner closes the card on the Board
    await world.move('closed');

    // Assert — nothing is left in Needs you
    should(world.open()).be.empty();
    should(world.closed().map(each => each.id)).eql([item.id]);
  });

  it('rests the card agenda, waiting on its ferret, when its last ask is withdrawn after the owner talked on it', async () => {
    // Arrange — the owner said something on the card's agenda
    const { world, item } = await atTest();
    const talked = await world.agenda.answer(
      'grandchild',
      item.id,
      { kind: 'open-question', answer: 'looks odd' },
      HUMAN,
    );
    if (!talked.ok) throw new Error(talked.error.message);

    // Act
    await world.move('closed');

    // Assert — it stays, with no ask, and is not in Needs you
    const after = openOf(world, 'grandchild', item.id);
    should(after.cardAsks).be.undefined();
    should(after.gateAttached).be.undefined();
    should(agendaState(after).state).equal('resting');
  });

  it('leaves a ferret’s thread as it was when the ask it carried is withdrawn', async () => {
    // Arrange — the ask rides the lead's thread
    const world = fixture([leads()]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    await world.board.trigger('F1', 'release.running');

    // Act
    await world.move('closed');

    // Assert — the thread is still open and carries no ask
    const after = openOf(world, 'lead', raised.item.id);
    should(after.cardAsks).be.undefined();
    should(agendaState(after).state).equal('needs-you');
  });

  it('puts a thread back on the owner’s turn when the ask that woke it is withdrawn, though it holds an older answer', async () => {
    // Arrange — the lead's thread carries the plan asks of F2 and F3; the owner answers F2, so it holds an answered ask
    const world = fixture([
      leads(),
      leads({ id: 'F2', laneId: 'todo', parent: { id: 'F1' } }),
      leads({ id: 'F3', laneId: 'todo', parent: { id: 'F1' } }),
    ]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    for (const each of ['F2', 'F3'])
      await world.board.act(each, BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);
    await world.answer(id, choose('OK to build'), { sessionId: 'lead', gate: true });
    should(agendaState(openOf(world, 'lead', id)).state).equal('needs-you');

    // Act — the owner drags F3 back on the Board
    await world.board.act(
      'F3',
      BoardTaskActionRequestSchema.parse({ action: 'move', to: 'todo', reason: 'not yet' }),
      OWNER,
    );

    // Assert — the lead's question is still the owner's to answer; the answered ask stays
    const after = openOf(world, 'lead', id);
    should(agendaState(after).state).equal('needs-you');
    should(after.cardAsks?.map(ask => ask.gate.cardId)).eql(['F2']);
  });

  it('puts a resting thread back to rest when the ask that woke it is withdrawn, and keeps it out of Needs you', async () => {
    // Arrange — the lead took the thread on without asking anything yet
    const world = fixture([leads()]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    const rested = await world.agenda.rest('lead', id, 'looking into it', AGENT);
    if (!rested.ok) throw new Error(rested.error.message);
    const before = agendaState(openOf(world, 'lead', id)).state;
    should(before).not.equal('needs-you');
    await world.board.trigger('F1', 'release.running');
    should(agendaState(openOf(world, 'lead', id)).state).equal('needs-you');

    // Act
    await world.move('closed');

    // Assert — back where it was
    const after = openOf(world, 'lead', id);
    should(after.cardAsks).be.undefined();
    should(agendaState(after).state).equal(before);
  });

  it('leaves a thread as it is when it moved on since the ask woke it', async () => {
    // Arrange — the owner snoozes the thread after the ask woke it
    const world = fixture([leads()]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    await world.board.trigger('F1', 'release.running');
    await world.agenda.snooze('lead', id, '2030-01-01T00:00:00.000Z', HUMAN);

    // Act
    await world.move('closed');

    // Assert — the snooze stands
    should(agendaState(openOf(world, 'lead', id)).state).equal('snoozed');
  });

  it('asks the next entry on a fresh agenda when the card comes back to the gate', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act
    await world.move('implement', OWNER, 'one more fix');
    await world.board.trigger('F1', 'release.running');

    // Assert — the old entry's agenda closed with its ask; the new one is open, alone
    const items = world.open();
    should(items).have.length(1);
    should(items[0]?.id).not.equal(item.id);
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

  it('never spends an older app’s double tap on the next of two OPEN asks, whenever it was put on', async () => {
    // Arrange — the parent's thread carries two sub-cards' plan asks, both already open
    const world = fixture([
      leads(),
      leads({ id: 'F2', laneId: 'todo', parent: { id: 'F1' } }),
      leads({ id: 'F3', laneId: 'todo', parent: { id: 'F1' } }),
    ]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    for (const each of ['F2', 'F3'])
      await world.board.act(each, BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);
    should(openOf(world, 'lead', id).cardAsks?.map(ask => ask.gate.cardId)).eql(['F2', 'F3']);

    // Act — the first tap, then the same tap again: a retry, or a double tap
    const first = await world.answer(id, choose('OK to build'), { sessionId: 'lead', gate: true });
    const again = await world.answer(id, choose('OK to build'), { sessionId: 'lead', gate: true });

    // Assert — F2 moved on; F3, which the owner never saw, did not
    should(first).match({ handled: true, mutation: { ok: true } });
    should(again).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.stored('F2').laneId).not.equal('todo');
    should(world.stored('F3').laneId).equal('plan');
    should(
      openOf(world, 'lead', id)
        .cardAsks?.filter(ask => ask.answer === undefined)
        .map(ask => ask.gate.cardId),
    ).eql(['F3']);
  });

  const twoOpenPlanAsks = async () => {
    const world = fixture([
      leads(),
      leads({ id: 'F2', laneId: 'todo', parent: { id: 'F1' } }),
      leads({ id: 'F3', laneId: 'todo', parent: { id: 'F1' } }),
    ]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    for (const each of ['F2', 'F3'])
      await world.board.act(each, BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);
    return { world, id: raised.item.id };
  };

  it('refuses an older app’s answer just after the shown ask changed to another card’s, and moves nothing', async () => {
    // Arrange — two open asks, F2's shown; the owner drags F2 on, so the mirror is F3's now
    const { world, id } = await twoOpenPlanAsks();
    await world.board.act(
      'F2',
      BoardTaskActionRequestSchema.parse({ action: 'move', to: 'implement', reason: 'one more fix' }),
      OWNER,
    );
    should(openOf(world, 'lead', id).gateAttached?.cardId).equal('F3');

    // Act — a phone that still draws F2's ask taps OK to build
    const outcome = await world.answer(id, choose('OK to build'), { sessionId: 'lead', gate: true });

    // Assert — the owner has not seen F3's ask; nothing moves
    should(outcome).match({ handled: true, refused: { code: 'moved-on' } });
    should((outcome as { refused: { message: string } }).refused.message).containEql('two minutes');
    should(world.stored('F3').laneId).equal('plan');
  });

  it('takes an older app’s answer to the shown ask once two minutes have passed since it changed', async () => {
    // Arrange — the same change, read three minutes later
    const world = fixture(
      [
        leads(),
        leads({ id: 'F2', laneId: 'todo', parent: { id: 'F1' } }),
        leads({ id: 'F3', laneId: 'todo', parent: { id: 'F1' } }),
      ],
      { gatesNow: '2026-10-30T10:03:00.000Z' },
    );
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    for (const each of ['F2', 'F3'])
      await world.board.act(each, BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);
    await world.board.act(
      'F2',
      BoardTaskActionRequestSchema.parse({ action: 'move', to: 'implement', reason: 'one more fix' }),
      OWNER,
    );

    // Act
    const outcome = await world.answer(raised.item.id, choose('OK to build'), { sessionId: 'lead', gate: true });

    // Assert
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F3').laneId).not.equal('plan');
  });

  it('does not delay the first tap on an ask that came to a bare agenda', async () => {
    // Arrange — one ask appears from nothing; nothing replaced another
    const world = fixture([leads(), leads({ id: 'F2', laneId: 'todo', parent: { id: 'F1' } })]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    await world.board.act('F2', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);
    should(openOf(world, 'lead', raised.item.id).gateAttachedChangedAt).be.undefined();

    // Act
    const outcome = await world.answer(raised.item.id, choose('OK to build'), { sessionId: 'lead', gate: true });

    // Assert
    should(outcome).match({ handled: true, mutation: { ok: true } });
  });

  it('reads an older app’s lost-response retry of the first of two answers as that answer, not a conflict with the second', async () => {
    // Arrange — A (F1) answered Done, then B (F2) answered Not good, on one thread, within two minutes
    const world = fixture([leads(), leads({ id: 'F2' })]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    await world.board.trigger('F1', 'release.running');
    await world.board.trigger('F2', 'release.running');
    const lead = { sessionId: 'lead' };
    await world.answer(id, choose('Done'), { ...lead, cardAsk: 'gate:F1:tested:2' });
    await world.answer(id, choose('Not good'), { ...lead, cardAsk: 'gate:F2:tested:2', note: 'it broke' });
    should(openOf(world, 'lead', id).gateAttached).be.undefined();

    // Act — the first tap's response was lost, and the old app sends it again
    const retried = await world.answer(id, choose('Done'), { ...lead, gate: true });

    // Assert — the repeat of A's answer comes back unchanged
    should(retried).match({ handled: true, mutation: { ok: true, changed: false } });
  });

  it('takes an older app’s exact repeat once nothing is left to show, open agenda or closed', async () => {
    // Arrange — the lead's own card: answered without naming the ask, then marked done by the lead
    const world = fixture([leads()]);
    await world.board.trigger('F1', 'release.running');
    const [item] = world.open('lead') as [AgendaItem];
    const lead = { sessionId: 'lead', gate: true as const };
    await world.answer(item.id, choose('Done'), lead);

    // Act — the lost response's retry on the resting agenda, then again after it closed, then a different answer
    const resting = await world.answer(item.id, choose('Done'), lead);
    const closed = await world.agenda.resolve('lead', item.id, AGENT, 'the owner tried it');
    if (!closed.ok) throw new Error(closed.error.message);
    const after = await world.answer(item.id, choose('Done'), lead);
    const other = await world.answer(item.id, choose('Not good'), { ...lead, note: 'it broke' });

    // Assert
    should(resting).match({ handled: true, mutation: { ok: true, changed: false } });
    should(after).match({ handled: true, mutation: { ok: true, changed: false } });
    should(other).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.done.notices).have.length(1);
  });

  it('puts the ask again when the owner sets aside a ferret’s thread that carried it', async () => {
    // Arrange — the ask rides the lead's thread
    const world = fixture([leads()]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    await world.board.trigger('F1', 'release.running');

    // Act — Not needed on the thread drops the thread, not the ask
    await world.agenda.dismiss('lead', raised.item.id, HUMAN);
    await world.gates.written('F1');

    // Assert — the card's own agenda now carries it
    const items = world.open('lead');
    should(items).have.length(1);
    should(items[0]?.sourceRef).equal('card-agenda:F1');
    should(items[0]?.cardAsks?.map(ask => ask.gate.cardId)).eql(['F1']);
  });

  it('refuses a plain answer to an open gate item the migration could not lift, and moves nothing', async () => {
    // Arrange — a gate item from before card asks, as the ledger still holds it
    const { world, item } = await atTest();
    const gate = item.cardAsks?.[0]?.gate;
    const ledger = world.ledgers.ledgers.get('grandchild');
    if (gate === undefined || ledger === undefined) throw new Error('expected a card ask');
    const { cardAsks: _asks, gateAttached: _attached, ...bare } = item;
    world.ledgers.ledgers.set('grandchild', {
      ...ledger,
      entries: ledger.entries.map(entry =>
        entry.lifecycle === 'active' ? { ...entry, item: { ...bare, gate } } : entry,
      ),
    });

    // Act
    const outcome = await world.answer(item.id, choose('Done'));

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'not-moved' } });
    should(world.stored().laneId).equal('tested');
    should(world.open().map(each => each.id)).eql([item.id]);
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

  it('takes a repeat of the answer that closed an old gate item, and refuses another', async () => {
    // Arrange — an older daemon's gate item, answered and closed before card asks
    const task = external({ laneId: 'tested' });
    const world = fixture([task]);
    const plain = await legacyGateItem(world, 'grandchild', task);
    const receipted = await legacyGateItem(world, 'child', { ...task, id: 'F2' });
    await world.agenda.answer('grandchild', plain.id, choose('Done'), HUMAN);
    await world.agenda.answer('child', receipted.id, choose('Done'), HUMAN, null, 'board', 'f'.repeat(64));

    // Act
    const same = await world.answer(plain.id, choose('Done'), { gate: true });
    const other = await world.answer(plain.id, choose('Not good'), { gate: true, note: 'it broke' });
    const unmatched = await world.answer(receipted.id, choose('Done'), { sessionId: 'child', gate: true });

    // Assert
    should(same).match({ handled: true, mutation: { ok: true } });
    should(other).match({ handled: true, refused: { code: 'moved-on' } });
    should(unmatched).match({ handled: true, refused: { code: 'moved-on' } });
    await world.gates.written('F1');
    should(world.open()).be.empty();
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
  it('never carries a cut-off How to test: too long for a body, the ask points at the card', () => {
    // Arrange
    const task = external({ laneId: 'tested', howToTest: `1. ${'x'.repeat(MAX_AGENDA_BODY_LENGTH + 1000)}` });
    const gate = gateOf({ task, laneSet: lanes(), audience: 'external' }, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');

    // Act
    const steps = cardAgendaRaise(gate, task, NOW).cardAsks?.[0]?.howToTest;

    // Assert
    should(steps).match(
      /^How to test is 201,003 characters, too long to show here \(the most is 200,000\)\. Open the card \(/u,
    );
    should(steps).not.match(/x{10}/u);
  });

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

describe('the gate engine, edge by edge', () => {
  it('says which open item carries an unanswered card ask', async () => {
    // Arrange
    const { world, item, reference } = await atTest();

    // Act + Assert
    should(await world.gates.isGate('grandchild', item.id)).be.true();
    should(await world.gates.isGate('grandchild', 'A99')).be.false();
    await world.answer(item.id, choose('Done'), { cardAsk: reference });
    should(await world.gates.isGate('grandchild', item.id)).be.false();
  });

  it('asks for every card already at a gate on a sweep, and nothing for the rest', async () => {
    // Arrange — the cards were written without the gates looking
    const world = fixture([external({ laneId: 'tested' }), external({ id: 'F2' })]);

    // Act
    const attached = await world.gates.sweep();

    // Assert
    should(attached).equal(1);
    should(
      world
        .open()
        .flatMap(item => item.cardAsks ?? [])
        .map(ask => ask.gate.cardId),
    ).eql(['F1']);
  });

  it('looks at nothing for a card that is gone or a board that cannot be read', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'tested' })], { boardThrows: true });

    // Act
    await world.gates.written('F404');
    await world.gates.written('F1');

    // Assert
    should(world.open()).be.empty();
  });

  it('says so, and goes on, when the duplicates sweep or one card fails at boot', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'tested' })], { swept: false, listAllThrows: 1, raiseThrows: true });

    // Act
    const attached = await world.gates.backfill();

    // Assert
    should(attached).equal(0);
    should(world.warnings.some(each => each.startsWith('the sweep of duplicate gate items failed'))).be.true();
    should(world.warnings.some(each => each.startsWith('the ask of &F1 could not be put'))).be.true();
  });

  it('puts a sub-card’s ask on the newest agenda about its parent when none is on the card’s home', async () => {
    // Arrange — two ferrets each talk about the parent, neither on the sub-card's home
    const world = fixture([leads(), leads({ id: 'F2', laneId: 'todo', parent: { id: 'F1' } })]);
    for (const sessionId of ['other', 'peer']) {
      const raised = await world.agenda.raise(sessionId, threadAbout('F1'), { kind: 'agent', sessionId, name: null });
      if (!raised.ok) throw new Error(raised.error.message);
    }

    // Act
    await world.board.act('F2', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);

    // Assert — the tie goes to the later session
    should(world.open('peer')[0]?.cardAsks?.map(ask => ask.gate.cardId)).eql(['F2']);
    should(world.open('other')[0]?.cardAsks).be.undefined();
    should(world.open('lead')).be.empty();
  });

  it('closes an earlier round’s Not good conversation, from before card asks, once the card is back at the gate', async () => {
    // Arrange — an older daemon's follow-up of round 1, answered by the owner and resting
    const world = fixture([external()]);
    const followup = await world.agenda.raise(
      'grandchild',
      {
        source: 'task',
        sourceRef: 'gate-followup:F1:1',
        subject: 'Not good: the badge counts twice',
        why: 'The owner said Not good.',
        premise: 'It was tested.',
        context: 'On the Mac.',
        howToResolve: 'Reply.',
        kind: 'reply',
        ask: { kind: 'open-question' },
        task: { id: 'F1' },
      },
      DAEMON,
    );
    if (!followup.ok || followup.item === undefined) throw new Error('expected a follow-up');
    await world.agenda.answer('grandchild', followup.item.id, { kind: 'open-question', answer: 'see above' }, HUMAN);

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    should(world.closed().find(item => item.id === followup.item?.id)?.resolutionNote).match(/^the card is back in /u);
  });

  it('refuses an answer to an item that is nowhere, or to an ask its agenda no longer carries', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act + Assert
    should(await world.answer('A99', choose('Done'), { cardAsk: 'gate:F1:tested:2' })).match({
      handled: true,
      refused: { code: 'moved-on' },
    });
    should(await world.answer(item.id, choose('Done'), { cardAsk: 'gate:F1:tested:9' })).match({
      handled: true,
      refused: { code: 'moved-on' },
    });
    should(world.stored().laneId).equal('tested');
  });

  it('withdraws an ask whose card left the gate unseen, and moves nothing', async () => {
    // Arrange — the card left without the gates hearing of it
    const { world, item, reference } = await atTest();
    world.store.cards.set('F1', { ...world.stored(), laneId: 'implement' });

    // Act
    const outcome = await world.answer(item.id, choose('Done'), { cardAsk: reference });

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.open()).be.empty();
    should(world.closed().map(each => each.id)).eql([item.id]);
  });

  it('takes a repeat of the answer once its ferret marked the agenda done, and refuses anything else', async () => {
    // Arrange — the lead's own card: answered, then closed by the lead
    const world = fixture([leads()]);
    await world.board.trigger('F1', 'release.running');
    const [item] = world.open('lead') as [AgendaItem];
    const reference = 'gate:F1:tested:2';
    const lead = { sessionId: 'lead' };
    await world.answer(item.id, choose('Done'), { ...lead, cardAsk: reference });
    const closed = await world.agenda.resolve('lead', item.id, AGENT, 'the owner tried it');
    if (!closed.ok) throw new Error(closed.error.message);

    // Act
    const same = await world.answer(item.id, choose('Done'), { ...lead, cardAsk: reference });
    const other = await world.answer(item.id, choose('Not good'), { ...lead, cardAsk: reference, note: 'it broke' });
    const ferret = await world.answer(item.id, choose('Done'), { ...lead, cardAsk: reference, actor: AGENT });
    const device = await world.answer(item.id, choose('Done'), {
      ...lead,
      cardAsk: reference,
      permitted: () => 'no grant',
    });

    // Assert
    should(same).match({ handled: true, mutation: { ok: true, changed: false } });
    should(other).match({ handled: true, refused: { code: 'moved-on' } });
    should(ferret).match({ handled: true, refused: { code: 'forbidden' } });
    should(device).match({ handled: true, refused: { code: 'forbidden', message: 'no grant' } });
    should(world.done.notices).have.length(1);
  });

  it('says so when an agenda refuses the ask, and when no agenda takes a new one', async () => {
    // Arrange — the ferret's thread refuses the ask, and every home refuses a new agenda
    const world = fixture([leads()], { cardAskRefuses: true, raiseRefuses: ['lead'] });
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok) throw new Error(raised.error.message);

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    should(world.warnings.some(each => each.startsWith('could not attach a card ask on !'))).be.true();
    should(world.warnings.some(each => each.startsWith('no agenda for &F1 in '))).be.true();
  });

  it('says so when a card’s ask cannot follow a write', async () => {
    // Arrange
    const world = fixture([external()], { raiseThrows: true });

    // Act
    await world.board.trigger('F1', 'release.running');

    // Assert
    should(world.warnings.some(each => each.startsWith('the ask of &F1 could not follow it'))).be.true();
  });

  it('spends an older app’s double tap once: the second comes back unchanged', async () => {
    // Arrange
    const { world, item } = await atTest();

    // Act — both taps arrive together and run one after the other
    const [first, second] = await Promise.all([
      world.answer(item.id, choose('Done'), { gate: true }),
      world.answer(item.id, choose('Done'), { gate: true }),
    ]);

    // Assert
    should(first).match({ handled: true, mutation: { ok: true } });
    should(second).match({ handled: true, mutation: { ok: true, changed: false } });
    should(world.done.notices).have.length(1);
  });

  it('refuses an answer to an agenda that is gone by the time it runs', async () => {
    // Arrange — answered and closed, then pruned between the answer's lookup and its turn
    const world = fixture([leads()]);
    await world.board.trigger('F1', 'release.running');
    const [item] = world.open('lead') as [AgendaItem];
    await world.answer(item.id, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F1:tested:2' });
    const closed = await world.agenda.resolve('lead', item.id, AGENT, 'the owner tried it');
    if (!closed.ok) throw new Error(closed.error.message);
    world.vanish(item.id, 1);

    // Act
    const outcome = await world.answer(item.id, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F1:tested:2' });

    // Assert
    should(outcome).match({
      handled: true,
      refused: { code: 'moved-on', message: `${item.id} is closed, so nothing was moved` },
    });
  });

  it('writes nothing when the card moved between the check and the write', async () => {
    // Arrange
    const { world } = await atTest();

    // Act — the answer's write expects an entry the card has since left and come back from
    await world.move('implement', OWNER, 'one more fix');
    await world.board.trigger('F1', 'release.running');
    const error = await world.board
      .act('F1', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'closed' }), OWNER, {
        laneId: 'tested',
        entry: 2,
      })
      .then(
        () => undefined,
        (thrown: unknown) => thrown as Error,
      );

    // Assert
    should(error?.message).containEql('has moved on from the gate the answer was about');
    should(world.stored().laneId).equal('tested');
  });
});

describe('the gate lanes from the workflow model', () => {
  const laneSet = lanes();

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
        .filter(lane => lane.id !== 'closed')
        .concat([{ id: 'closed', name: 'Closed', category: 'closed', ownerGate: true }]),
    };
    const planLast: LaneSet = { ...last, variants: { ...last.variants, 'design-first': ['todo', 'plan'] } };
    should(stageGateLanes.outcomeLane(planLast, 'design-first', 'plan', 'ok')).match({
      ok: false,
      message: 'plan has no lane after it',
    });
  });

  it('reads the entry that put a card in its lane: a move, a refile, and none past a note alone', () => {
    const moved = external({
      laneId: 'tested',
      history: [
        { seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'todo' },
        {
          seq: 2,
          at: NOW,
          actor: { kind: 'daemon' },
          type: 'refiled',
          fromProject: external().projectId,
          toProject: external().projectId,
          toLane: 'tested',
          reason: null,
        },
        { seq: 3, at: NOW, actor: { kind: 'owner' }, type: 'note', text: 'looks close' },
      ],
    });
    should(gateEntry(moved)).equal(2);
    should(gateEntry({ ...moved, laneId: 'closed' })).be.undefined();
    should(
      gateEntry({
        laneId: 'tested',
        history: [{ seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'note', text: 'hi' }],
      }),
    ).be.undefined();
  });
});

describe('a Not good with files', () => {
  const PICTURE = `att_${'c'.repeat(64)}`;
  const files = (from: string) => ({ attachments: { from, ids: [PICTURE] } });
  const atGate = async (faults: Faults = {}, laneId = 'tested') => {
    const world = fixture([external({ laneId })], faults);
    await world.gates.backfill();
    const item = world.open()[0] as AgendaItem;
    const ask = item.cardAsks?.[0];
    if (ask === undefined) throw new Error('expected a card ask');
    return { world, item, cardAsk: gateReference(ask.gate) };
  };

  it('moves the files to the card’s ferret, then reopens naming them where the ferret holds them', async () => {
    const { world, item, cardAsk } = await atGate();

    const outcome = await world.answer(item.id, choose('Not good'), {
      cardAsk,
      note: 'still flickers',
      ...files('grandchild'),
    });

    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.carried).eql([['grandchild', 'grandchild', [PICTURE]]]);
    should(world.stored().laneId).equal('implement');
    should(world.reopen.notices[0]?.attachments).eql({ from: 'grandchild', ids: [PICTURE] });
  });

  it('takes the owner’s own words as a Not good that brings files', async () => {
    const { world, item, cardAsk } = await atGate();

    const outcome = await world.answer(
      item.id,
      { kind: 'other', answer: 'it flickers' },
      { cardAsk, ...files('grandchild') },
    );

    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.reopen.notices[0]?.attachments).eql({ from: 'grandchild', ids: [PICTURE] });
  });

  it('refuses files on an answer that is not a Not good, from another session, or where none can be carried', async () => {
    const { world, item, cardAsk } = await atGate();
    const { world: bare, item: bareItem, cardAsk: bareAsk } = await atGate({ noCarrier: true });

    const done = await world.answer(item.id, choose('Done'), { cardAsk, ...files('grandchild') });
    const elsewhere = await world.answer(item.id, choose('Not good'), {
      cardAsk,
      note: 'still flickers',
      ...files('stranger'),
    });
    const uncarried = await bare.answer(bareItem.id, choose('Not good'), {
      cardAsk: bareAsk,
      note: 'still flickers',
      ...files('grandchild'),
    });

    should(done).match({ handled: true, refused: { code: 'invalid' } });
    should(elsewhere).match({ handled: true, refused: { code: 'invalid' } });
    should(uncarried).match({ handled: true, refused: { code: 'invalid' } });
    should((uncarried as { refused: { message: string } }).refused.message).containEql('cannot carry files');
    should(world.carried).be.empty();
    should(world.stored().laneId).equal('tested');
  });

  it('leaves the card and its ask alone when a file cannot be carried', async () => {
    const { world, item, cardAsk } = await atGate({ carryThrows: true });

    const outcome = await world.answer(item.id, choose('Not good'), {
      cardAsk,
      note: 'still flickers',
      ...files('grandchild'),
    });

    should(outcome).match({ handled: true, refused: { code: 'not-moved' } });
    should((outcome as { refused: { message: string } }).refused.message).containEql('the copy failed');
    should(world.stored().laneId).equal('tested');
    should(world.reopen.notices).be.empty();
    should(world.open()[0]?.cardAsks?.[0]?.answer).be.undefined();
  });

  it('still records the answer when its ferret cannot be told, and says so', async () => {
    const { world, item, cardAsk } = await atGate({ tellThrows: true });

    const outcome = await world.answer(item.id, choose('Done'), { cardAsk });

    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.warnings.some(each => each.startsWith('could not tell &F1'))).be.true();
  });
});

describe('the one-time sweep of duplicate gate items (&B138)', () => {
  const ASKED: Readonly<Record<string, string>> = {
    dyani: '2026-10-24T10:00:00.000Z',
    avary: '2026-10-28T10:00:00.000Z',
  };

  /** &F291 as an older daemon left it: one gate asked twice, on dyani's and on avary's agenda. */
  const f291 = async (faults: Faults = {}) => {
    const task = external({ id: 'F291', laneId: 'tested', owner: 'lead', assignee: 'avary' });
    const world = fixture([task], { swept: false, ...faults });
    const gate = gateOf({ task, laneSet: lanes(), audience: 'external', projectName: 'Ferretry' }, stageGateLanes);
    if (gate === undefined) throw new Error('F291 is at no gate');
    for (const sessionId of ['dyani', 'avary']) {
      const raised = await world.agenda.raise(
        sessionId,
        {
          source: 'task',
          sourceRef: gateReference(gate),
          title: task.title,
          kind: 'choice',
          subject: 'Try it: Open the Inbox',
          why: '&F291 reached To test, which waits on you.',
          howToResolve: 'Choose Done or Not good.',
          ask: { kind: 'multiple-choice', options: gate.options.map(option => ({ label: option.label })) },
          task: { id: 'F291' },
          gate,
          waitingSince: ASKED[sessionId],
        },
        DAEMON,
      );
      if (!raised.ok) throw new Error(raised.error.message);
    }
    // A ferret's own thread is no gate item: the sweep passes it by.
    const thread = await world.agenda.raise('dyani', threadAbout('F291'), {
      kind: 'agent',
      sessionId: 'dyani',
      name: null,
    });
    if (!thread.ok) throw new Error(thread.error.message);
    return world;
  };

  it('keeps the newest gate item, closes the other with a note, and records that it ran, once', async () => {
    const world = await f291();

    await world.gates.backfill();
    await world.gates.backfill();

    should(world.open('avary').some(item => item.gate !== undefined)).be.true();
    should(world.open('dyani').some(item => item.gate !== undefined)).be.false();
    should(world.closed('dyani').at(-1)?.resolutionNote).equal('closed as a duplicate of !A1');
    should(world.marker.records).eql([{ at: NOW, closed: ['dyani !A1'] }]);
  });

  it('records nothing while an agenda cannot be read or a duplicate cannot be closed, so the next start tries again', async () => {
    const unreadable = await f291({ unreadable: ['stranger'] });
    const unwritable = await f291({ resolveThrows: ['dyani'] });

    await unreadable.gates.backfill();
    await unwritable.gates.backfill();

    should(unreadable.marker.records).be.empty();
    should(unwritable.marker.records).be.empty();
    should(unwritable.warnings).containEql(
      'the sweep of duplicate gate items is unfinished; the next start tries again',
    );
  });
});

describe('where a card’s asks are read from', () => {
  it('says so when the agendas holding asks cannot be listed, and still asks on the card’s home', async () => {
    const world = fixture([external()], { listAllThrows: 1 });

    await world.board.trigger('F1', 'release.running');

    should(world.warnings.some(each => each.startsWith('the agendas holding card asks could not be listed'))).be.true();
    should(world.open()).have.length(1);
  });

  it('throws rather than say a card is not asking when its agenda cannot be read', async () => {
    // A card whose ferret has no session the agenda knows
    const world = fixture([external({ laneId: 'tested', assignee: 'ghost', owner: 'ghost' })]);

    const error = await world.gates.asking('F1').then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );

    should(error?.message).equal("ghost's agenda could not be read");
    await world.gates.written('F1');
    should(world.warnings.some(each => each.startsWith('no agenda for &F1'))).be.true();
  });

  it('never asks again an entry the owner set aside after saying Not yet', async () => {
    const world = fixture([external({ laneId: 'todo' })]);
    await world.move('plan');
    const [item] = world.open() as [AgendaItem];
    await world.answer(item.id, choose('Not yet'), { cardAsk: 'gate:F1:plan:2', note: 'after the demo' });
    await world.agenda.dismiss('grandchild', item.id, HUMAN);

    await world.gates.written('F1');

    should(world.open()).be.empty();
  });
});

describe('what a card ask takes as an answer', () => {
  const atPlan = async (faults: Faults = {}) => {
    const world = fixture([external({ laneId: 'todo' })], faults);
    await world.move('plan');
    return { world, item: world.open()[0] as AgendaItem, cardAsk: 'gate:F1:plan:2' };
  };

  it('refuses words alone at a gate with no Not good, another shape, and an option the gate does not have', async () => {
    const { world, item, cardAsk } = await atPlan();

    const words = await world.answer(item.id, { kind: 'other', answer: 'not this way' }, { cardAsk });
    const shape = await world.answer(item.id, { kind: 'permission', decision: 'approve' }, { cardAsk });
    const unknown = await world.answer(item.id, choose('Ship it'), { cardAsk });

    should(words).match({
      handled: true,
      refused: { code: 'invalid', message: `${item.id} is answered with one of its options: OK to build` },
    });
    should(shape).match({ handled: true, refused: { code: 'invalid' } });
    should(unknown).match({ handled: true, refused: { code: 'invalid', message: `${item.id} has no option Ship it` } });
    should(world.stored().laneId).equal('plan');
  });

  it('keeps a Not yet without words quiet, and says so when its words cannot be kept or told', async () => {
    const quiet = await atPlan();
    const failing = await atPlan({ refuses: ['clarify'], tellThrows: true });

    const blank = await quiet.world.answer(quiet.item.id, choose('Not yet'), { cardAsk: quiet.cardAsk, note: '  ' });
    const said = await failing.world.answer(failing.item.id, choose('Not yet'), {
      cardAsk: failing.cardAsk,
      note: 'after the demo',
    });

    should(blank).match({ handled: true, mutation: { ok: true } });
    should(quiet.world.open()[0]?.cardAsks?.[0]?.notYet?.note).be.undefined();
    should(said).match({ handled: true, mutation: { ok: true } });
    should(failing.world.warnings.some(each => each.startsWith("the owner's words on &F1 were not kept"))).be.true();
    should(failing.world.warnings.some(each => each.startsWith('could not tell &F1'))).be.true();
  });

  it('moves nothing, and records nothing, when the board refuses the move', async () => {
    const { world, item, cardAsk } = await atPlan({ refuses: ['move'] });

    const outcome = await world.answer(item.id, choose('OK to build'), { cardAsk });

    should(outcome).match({ handled: true, refused: { code: 'not-moved' } });
    should(world.stored().laneId).equal('plan');
    should(world.open()[0]?.cardAsks?.[0]?.answer).be.undefined();
  });
});
