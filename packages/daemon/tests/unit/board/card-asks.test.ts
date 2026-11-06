import { describe, it } from 'bun:test';
import {
  type AgendaItem,
  type AgendaResponse,
  agendaState,
  type BoardTask,
  type BoardTaskActionRequest,
  BoardTaskActionRequestSchema,
  gateReference,
  type LaneSet,
  MAX_AGENDA_BODY_LENGTH,
  nothingToTryLine,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';
import should from 'should';
import type { StoreBoardAttachments } from '../../../src/adapters/board/board-attachments.ts';
import { BoardGateCards } from '../../../src/adapters/board/board-gate-cards.ts';
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
  cardAgendaRaise,
  type GateAnswer,
  type GateCard,
  GateItems,
  gateEntry,
  gateOf,
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

/** What a try-it carries for a card with these steps, no preview and no PR: where to try it, then the steps as written. */
const TRY_IT =
  'There is no preview for this one. Try it for real: the steps below say where.\n\n1. Open the Inbox\n2. Answer the card';

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
  /** Runs right after the board moves a card, before the answer is recorded: the agenda changes under the answer. */
  readonly afterAct?: () => Promise<void>;
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
  /** An item whose asks the gates' reads stop seeing after this many reads: one that lost them mid-answer. */
  let unasking: { id: string; after: number } | undefined;
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
  const unasked = (listed: Awaited<ReturnType<AgendaService['list']>>) => {
    if (unasking === undefined || !listed.ok) return listed;
    if (unasking.after > 0) {
      unasking.after -= 1;
      return listed;
    }
    const bare = unasking.id;
    return {
      ...listed,
      value: {
        ...listed.value,
        items: listed.value.items.map(each => {
          if (each.id !== bare) return each;
          const { cardAsks: _asks, gateAttached: _mirror, ...rest } = each;
          return rest;
        }),
      },
    };
  };
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
          const read = await agenda.list(sessionId);
          const listed = unasked(read);
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
          await faults.afterAct?.();
        },
        closeNothingToTry: async (id, expect, reason) => await cards_.closeNothingToTry(id, expect, reason),
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
    unask: (id: string, after: number) => {
      unasking = { id, after };
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

/** A ferret's thread whose line only repeats its card's try-it ask (docs/agenda.md § One ask): the card ask is all it asks. */
const REPEATING = (cardId: string) => ({ ...threadAbout(cardId), subject: 'Try it: Open the Inbox' });

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
      howToTest: TRY_IT,
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

  it('leaves a thread as it is when the ask it carried was put before asks remembered their turn', async () => {
    // Arrange — the lead's thread carries an ask written without the turn it woke the thread out of
    const world = fixture([leads()]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    await world.board.trigger('F1', 'release.running');
    const ledger = world.ledgers.ledgers.get('lead');
    if (ledger === undefined) throw new Error('expected the lead’s ledger');
    world.ledgers.ledgers.set('lead', {
      ...ledger,
      entries: ledger.entries.map(entry => {
        if (entry.lifecycle !== 'active' || entry.item.id !== id) return entry;
        const cardAsks = entry.item.cardAsks?.map(({ woke: _woke, ...ask }) => ask);
        return { ...entry, item: { ...entry.item, ...(cardAsks === undefined ? {} : { cardAsks }) } };
      }),
    });
    should(openOf(world, 'lead', id).cardAsks?.[0]?.woke).be.undefined();

    // Act
    await world.move('closed');

    // Assert — still open, with no ask left
    const after = openOf(world, 'lead', id);
    should(after.cardAsks).be.undefined();
    should(after.gateAttached).be.undefined();
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

  /** Two sub-cards' plan asks open on the lead's thread, read three minutes on (past the two-minute replay guard). */
  const twoOpenPlanAsksLater = async () => {
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
    return { world, id: raised.item.id };
  };

  it('shows an older app the next ask once the owner says Not yet to the first, and its answer reaches that one', async () => {
    // Arrange — two approvals, F2 then F3; the owner says Not yet to F2 on a newer app
    const { world, id } = await twoOpenPlanAsksLater();
    await world.answer(id, choose('Not yet'), { sessionId: 'lead', cardAsk: 'gate:F2:plan:2' });
    should(openOf(world, 'lead', id).gateAttached?.cardId).equal('F3');

    // Act — an app that predates card asks answers what it is shown
    const outcome = await world.answer(id, choose('OK to build'), { sessionId: 'lead', gate: true });

    // Assert — F3 moved on; F2, set aside, did not
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F3').laneId).not.equal('plan');
    should(world.stored('F2').laneId).equal('plan');
  });

  it('moves an older app on to the next ask with each Not yet, never back onto the one it set aside', async () => {
    // Arrange — two approvals, F2 shown
    const { world, id } = await twoOpenPlanAsksLater();

    // Act — an older app says Not yet to what it is shown, twice
    const first = await world.answer(id, choose('Not yet'), { sessionId: 'lead', gate: true });
    const shown = openOf(world, 'lead', id).gateAttached?.cardId;
    const second = await world.answer(id, choose('Not yet'), { sessionId: 'lead', gate: true });

    // Assert — the first set F2 aside and showed F3; the second set F3 aside, not F2 again
    should(first).match({ handled: true, mutation: { ok: true } });
    should(shown).equal('F3');
    should(second).match({ handled: true, mutation: { ok: true } });
    const asks = openOf(world, 'lead', id).cardAsks ?? [];
    should(asks.map(ask => [ask.gate.cardId, ask.notYet !== undefined])).deepEqual([
      ['F2', true],
      ['F3', true],
    ]);
    should(world.stored('F2').laneId).equal('plan');
    should(world.stored('F3').laneId).equal('plan');
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

  /** F1's thread shows F1's ask alone; `leave` takes it away; then sub-card F2's plan ask is put on the same thread. */
  const askReplacedByNothing = async (
    leave: (world: ReturnType<typeof fixture>, id: string) => Promise<void>,
    faults: Faults = {},
  ) => {
    // F2 was made from the thread (its topic), so its ask rides it; it is not F1's sub-card, or F1 would wait for it.
    const world = fixture([leads(), leads({ id: 'F2', laneId: 'todo' })], faults);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    world.store.cards.set('F2', { ...world.stored('F2'), ask: { text: 'make it', source: `!${id}` } });
    await world.board.trigger('F1', 'release.running');
    should(openOf(world, 'lead', id).gateAttached?.cardId).equal('F1');
    await leave(world, id);
    should(openOf(world, 'lead', id).gateAttached).be.undefined();
    await world.board.act('F2', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);
    should(openOf(world, 'lead', id).gateAttached?.cardId).equal('F2');
    return { world, id };
  };

  it('refuses an older app’s answer after its only ask was answered Not good elsewhere and another card’s ask took its place', async () => {
    // Arrange — the owner answers F1's ask Not good on another device; F2's ask is put on within two minutes
    const { world, id } = await askReplacedByNothing(async (each, thread) => {
      await each.answer(thread, choose('Not good'), {
        sessionId: 'lead',
        cardAsk: 'gate:F1:tested:2',
        note: 'flickers',
      });
    });

    // Act — a phone on an older app still draws F1's ask and taps
    const outcome = await world.answer(id, choose('OK to build'), { sessionId: 'lead', gate: true });

    // Assert — F2, which the owner never saw, did not move
    should(outcome).match({ handled: true, refused: { code: 'moved-on' } });
    should((outcome as { refused: { message: string } }).refused.message).containEql('two minutes');
    should(world.stored('F2').laneId).equal('plan');
  });

  it('refuses an older app’s answer after its only ask left with its card dragged on the Board, then another took its place', async () => {
    // Arrange
    const { world, id } = await askReplacedByNothing(async each => {
      await each.move('implement', OWNER, 'one more fix');
    });

    // Act
    const outcome = await world.answer(id, choose('OK to build'), { sessionId: 'lead', gate: true });

    // Assert
    should(outcome).match({ handled: true, refused: { code: 'moved-on' } });
    should((outcome as { refused: { message: string } }).refused.message).containEql('two minutes');
    should(world.stored('F2').laneId).equal('plan');
  });

  it('takes an older app’s answer on an ask that appeared after the old one left, once two minutes have passed', async () => {
    // Arrange — the same, read three minutes later
    const { world, id } = await askReplacedByNothing(
      async each => {
        await each.move('implement', OWNER, 'one more fix');
      },
      { gatesNow: '2026-10-30T10:03:00.000Z' },
    );

    // Act
    const outcome = await world.answer(id, choose('OK to build'), { sessionId: 'lead', gate: true });

    // Assert
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F2').laneId).not.equal('plan');
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

  it('reads an older app’s answer that repeats neither of two recent answers against the newest one, and refuses it', async () => {
    // Arrange — A (F1) and B (F2) both answered Done on one thread, within two minutes
    const world = fixture([leads(), leads({ id: 'F2' })]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const id = raised.item.id;
    await world.board.trigger('F1', 'release.running');
    const lead = { sessionId: 'lead' };
    await world.answer(id, choose('Done'), { ...lead, cardAsk: 'gate:F1:tested:2' });
    await world.board.trigger('F2', 'release.running');
    const f2 = gateOf({ task: world.stored('F2'), laneSet: lanes(), audience: 'external' }, stageGateLanes);
    if (f2 === undefined) throw new Error('expected F2 at its gate');
    await world.agenda.cardAsk('lead', id, { kind: 'attach', ask: { gate: f2 } });
    await world.answer(id, choose('Done'), { ...lead, cardAsk: 'gate:F2:tested:2' });
    should(openOf(world, 'lead', id).cardAsks?.filter(ask => ask.answer !== undefined)).have.length(2);
    should(openOf(world, 'lead', id).gateAttached).be.undefined();

    // Act — an old app's Not good with words: neither answer said that
    const other = await world.answer(id, choose('Not good'), { ...lead, gate: true, note: 'it broke' });

    // Assert — read against B, the newest, as a different answer to it
    should(other).match({
      handled: true,
      refused: { code: 'moved-on', message: `${id}'s question was already answered, differently: nothing was sent` },
    });
    should(world.reopen.notices).be.empty();
  });

  it('refuses an older app’s answer when the ask it shows is gone by the time the answer runs', async () => {
    // Arrange — the agenda shows an ask when the answer is looked up, and none when its turn comes
    const { world, item } = await atTest();
    world.unask(item.id, 1);

    // Act
    const outcome = await world.answer(item.id, choose('Done'), { gate: true });

    // Assert
    should(outcome).match({
      handled: true,
      refused: { code: 'moved-on', message: `${item.id} no longer asks that, so nothing was moved` },
    });
    should(world.stored().laneId).equal('tested');
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

  it('puts the ask again when the owner said Not yet on a ferret’s thread and then set the thread aside', async () => {
    // Arrange — the ask rides the lead's thread, and the owner says Not yet to it there
    const world = fixture([leads({ laneId: 'todo' })]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    await world.move('plan');
    await world.answer(raised.item.id, choose('Not yet'), { sessionId: 'lead', cardAsk: 'gate:F1:plan:2' });

    // Act — Not needed on the thread drops the thread, and the Not yet was never an answer
    await world.agenda.dismiss('lead', raised.item.id, HUMAN);
    await world.gates.written('F1');

    // Assert — the card's own agenda carries the ask, open
    const items = world.open('lead');
    should(items).have.length(1);
    should(items[0]?.sourceRef).equal('card-agenda:F1');
    should(items[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:plan:2']);
    should(items[0]?.cardAsks?.[0]?.answer).be.undefined();
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
    should(items[0]?.cardAsks?.[0]).match({ gate: legacy.gate, howToTest: TRY_IT });
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
      /How to test is 201,003 characters, too long to show here \(the most is 200,000\)\. Open the card \(/u,
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
      subject: 'Try it: Gates raise one agenda item',
      task: { id: 'F1' },
      stage: 'test',
      cardAsks: [{ gate, at: NOW, howToTest: TRY_IT }],
    });
    should(request.gate).be.undefined();
  });
});

describe('the new agenda for a card carries everything needed to try it', () => {
  const PR = 'https://github.com/kirinnee/ferretry/pull/9';
  const linked = (
    state: 'open' | 'merged',
    releasedIn: { version: string } | null,
    docs: string[] = [],
  ): Partial<BoardTask> => ({
    laneId: 'tested',
    history: [{ seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'tested' }],
    links: {
      prs: [
        {
          url: PR,
          number: 9,
          repo: 'kirinnee/ferretry',
          state,
          draft: false,
          checks: 'passing',
          mergedAt: state === 'merged' ? NOW : null,
          mergeSha: state === 'merged' ? 'a'.repeat(40) : null,
          releasedIn:
            releasedIn === null ? null : { version: releasedIn.version, tag: `v${releasedIn.version}`, at: NOW },
          polledAt: NOW,
        },
      ],
      branch: null,
      commits: [],
      docs,
    },
  });
  const raised = (overrides: Partial<BoardTask>) => {
    const task = external(overrides);
    const gate = gateOf({ task, laneSet: lanes(), audience: 'external' }, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');
    return cardAgendaRaise(gate, task, NOW);
  };

  it('links the preview first, then the steps, then the shipped version and the PR', () => {
    const request = raised(linked('merged', { version: '1.2.3' }, ['https://abc123.ferretry.pages.dev/inbox']));
    const steps = request.cardAsks?.[0]?.howToTest ?? '';
    should(steps.startsWith('**Try it on the preview:** https://abc123.ferretry.pages.dev/inbox')).be.true();
    should(steps).containEql('1. Open the Inbox');
    should(steps).containEql(`Shipped in Ferretry v1.2.3 (${PR})`);
    should(steps.indexOf('1. Open the Inbox')).be.below(steps.indexOf('Shipped in'));
  });

  it('says where to try it for real when the card has no preview, and that an open PR is not shipped', () => {
    const steps = raised(linked('open', null)).cardAsks?.[0]?.howToTest ?? '';
    should(steps).startWith('There is no preview for this one. Try it for real');
    should(steps).containEql('Not merged yet, so not shipped');
    // The agenda itself carries no second copy of the PR line: the one ask says it.
    should(raised(linked('open', null)).context).be.undefined();
  });

  it('asks an approval in its own words, with the card’s text as written and no try-it frame', () => {
    const request = raised({
      laneId: 'plan',
      history: [{ seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'plan' }],
    });
    should(request.subject).equal('OK to build? Gates raise one agenda item');
    should(request.cardAsks?.[0]?.howToTest).not.containEql('preview');
  });

  it('points an approval at the card when its text is too long for a body', () => {
    const request = raised({
      laneId: 'plan',
      howToTest: `1. ${'x'.repeat(MAX_AGENDA_BODY_LENGTH + 10)}`,
      history: [{ seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'plan' }],
    });
    should(request.cardAsks?.[0]?.howToTest).match(/^How to test is /u);
    should(request.cardAsks?.[0]?.howToTest).not.match(/x{10}/u);
  });

  it('carries no text for an approval whose card wrote none', () => {
    const request = raised({
      laneId: 'plan',
      howToTest: '',
      history: [{ seq: 1, at: NOW, actor: { kind: 'owner' }, type: 'created', laneId: 'plan' }],
    });
    should(request.cardAsks?.[0]?.howToTest).be.undefined();
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
    should(world.warnings.some(each => each.startsWith('could not attach an ask about a card on !'))).be.true();
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

    should(
      world.warnings.some(each => each.startsWith('the agendas holding asks about cards could not be listed')),
    ).be.true();
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

describe('card asks across merge and split (docs/agenda.md § Merge and split)', () => {
  /** Two of the lead's threads, each about a card at its gate: A1 carries F1's ask, A2 carries F2's. */
  const twoAsking = async (faults: Faults = {}) => {
    const world = fixture([leads(), leads({ id: 'F2' })], faults);
    const first = await world.agenda.raise('lead', REPEATING('F1'), AGENT);
    const second = await world.agenda.raise('lead', { ...threadAbout('F2'), subject: 'And the menu?' }, AGENT);
    if (!first.ok || !second.ok || first.item === undefined || second.item === undefined) {
      throw new Error('expected two threads');
    }
    await world.board.trigger('F1', 'release.running');
    await world.board.trigger('F2', 'release.running');
    return { world, kept: first.item.id, absorbed: second.item.id };
  };

  it('a merge keeps both cards’ asks on one agenda, and the gates ask neither again', async () => {
    // Arrange
    const { world, kept, absorbed } = await twoAsking();

    // Act
    const merged = await world.agenda.merge('lead', kept, absorbed, HUMAN);
    await world.gates.backfill();
    await world.gates.sweep();

    // Assert — one open agenda carrying both asks; the absorbed item closed carrying none
    should(merged.ok).be.true();
    const items = world.open('lead');
    should(items.map(item => item.id)).eql([kept]);
    should(items[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:tested:2', 'gate:F2:tested:2']);
    const [closed] = world.closed('lead');
    should(closed).match({ id: absorbed, mergedInto: kept });
    should(closed?.cardAsks).be.undefined();
    should(await world.gates.asking('F2')).eql({ sessionId: 'lead', id: kept });
  });

  it('answering a merged ask moves its card, on the kept item or by the absorbed one’s id, with its receipt', async () => {
    // Arrange
    const { world, kept, absorbed } = await twoAsking();
    await world.agenda.merge('lead', kept, absorbed, HUMAN);

    // Act — F2 through the kept item; F1 from a screen still showing the absorbed one; then that answer again
    const viaKept = await world.answer(kept, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F2:tested:2' });
    const afterFirst = openOf(world, 'lead', kept);
    const viaAbsorbed = await world.answer(absorbed, choose('Done'), {
      sessionId: 'lead',
      cardAsk: 'gate:F1:tested:2',
    });
    const again = await world.answer(absorbed, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F1:tested:2' });

    // Assert — each card moved once, the agenda rests only once nothing is left to answer
    should(viaKept).match({ handled: true, mutation: { ok: true } });
    should(viaAbsorbed).match({ handled: true, mutation: { ok: true } });
    should(again).match({ handled: true, mutation: { ok: true, changed: false } });
    should(world.stored('F2').laneId).equal('closed');
    should(world.stored('F1').laneId).equal('closed');
    should(world.done.notices).have.length(2);
    should(agendaState(afterFirst).state).equal('needs-you');
    const after = openOf(world, 'lead', kept);
    should(after.cardAsks?.map(ask => ask.answer?.receipt)).match([/^[0-9a-f]{64}$/u, /^[0-9a-f]{64}$/u]);
    should(agendaState(after)).match({ state: 'resting', sub: 'waiting-on-ferret' });
  });

  it('refuses a ferret’s answer to a merged ask through either item, and an older app’s on the absorbed one', async () => {
    // Arrange
    const { world, kept, absorbed } = await twoAsking();
    await world.agenda.merge('lead', kept, absorbed, HUMAN);
    const ferret: AgendaActor = { kind: 'agent', sessionId: 'lead', name: null };

    // Act
    const outcomes = [
      await world.answer(kept, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F2:tested:2', actor: ferret }),
      await world.answer(absorbed, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F2:tested:2', actor: ferret }),
    ];
    // An app that predates card asks names none: the item it shows is closed, and nothing is guessed for it.
    const older = await world.answer(absorbed, choose('Done'), { sessionId: 'lead', gate: true });

    // Assert
    for (const outcome of outcomes) should(outcome).match({ handled: true, refused: { code: 'forbidden' } });
    should(older).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.stored('F1').laneId).equal('tested');
    should(world.stored('F2').laneId).equal('tested');
  });

  it('records an answer on the item the ask went to when a merge came between the card moving and the record', async () => {
    // Arrange — the merge lands right after the board moved F2, as the answer was being recorded on the absorbed item
    let between: (() => Promise<unknown>) | undefined;
    const { world, kept, absorbed } = await twoAsking({ afterAct: async () => void (await between?.()) });
    between = async () => {
      between = undefined;
      await world.agenda.merge('lead', kept, absorbed, HUMAN);
    };

    // Act
    const outcome = await world.answer(absorbed, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F2:tested:2' });

    // Assert — the card moved, the answer and its receipt are on the kept item, the ferret is told of that one
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F2').laneId).equal('closed');
    const f2 = openOf(world, 'lead', kept).cardAsks?.find(ask => ask.gate.cardId === 'F2');
    should(f2?.answer).match({ response: choose('Done'), receipt: /^[0-9a-f]{64}$/u });
    should(world.told.some(each => each.message.includes(`!${kept}`))).be.true();
    should(world.told.some(each => each.message.includes(`!${absorbed}`))).be.false();
  });

  /** The lead's thread about F1 carries F1's ask at To test and its sub-card F2's at Plan; F3 is a card of no gate. */
  const parentAndSubBeforeSplit = async (faults: Faults = {}) => {
    // F2 was made from the thread (its topic), so its ask rides it; it is not F1's sub-card, or F1 would wait for it.
    const world = fixture([leads(), leads({ id: 'F2', laneId: 'todo' }), leads({ id: 'F3', laneId: 'todo' })], faults);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const parent = raised.item.id;
    world.store.cards.set('F2', { ...world.stored('F2'), ask: { text: 'make it', source: `!${parent}` } });
    await world.board.act('F2', BoardTaskActionRequestSchema.parse({ action: 'move', to: 'plan' }), OWNER);
    await world.board.trigger('F1', 'release.running');
    const splitOff = async () => {
      const { task: _task, ...plain } = threadAbout('F2');
      const split = await world.agenda.split(
        'lead',
        parent,
        { ...plain, subject: 'OK to build? Open the Inbox' },
        AGENT,
        [{ id: 'F2' }],
      );
      if (!split.ok || split.item === undefined) throw new Error('expected a split');
      return split.item.id;
    };
    return { world, parent, splitOff };
  };

  const parentAndSub = async () => {
    const { world, parent, splitOff } = await parentAndSubBeforeSplit();
    return { world, parent, child: await splitOff() };
  };

  it('a split with the card takes its ask along, and the gates ask it nowhere else', async () => {
    // Arrange
    const { world, parent, child } = await parentAndSub();

    // Act
    await world.gates.backfill();

    // Assert
    const items = world.open('lead');
    should(items.map(item => item.id).sort()).eql([parent, child].sort());
    should(openOf(world, 'lead', parent).cardAsks?.map(ask => ask.gate.cardId)).eql(['F1']);
    should(openOf(world, 'lead', child).cardAsks?.map(ask => ask.gate.cardId)).eql(['F2']);
    should(openOf(world, 'lead', child).gateAttached?.cardId).equal('F2');
    should(await world.gates.asking('F2')).eql({ sessionId: 'lead', id: child });
  });

  it('answering a split-off ask moves its card, on the new item or by the one it left', async () => {
    // Arrange
    const { world, parent, child } = await parentAndSub();

    // Act — a screen still showing the original answers F2's ask; F1's is not on the new item
    const viaParent = await world.answer(parent, choose('OK to build'), {
      sessionId: 'lead',
      cardAsk: 'gate:F2:plan:2',
    });
    const wrong = await world.answer(child, choose('Done'), { sessionId: 'lead', cardAsk: 'gate:F1:tested:2' });

    // Assert
    should(viaParent).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F2').laneId).equal('implement');
    should(openOf(world, 'lead', child).cardAsks?.[0]?.answer).match({ response: choose('OK to build') });
    should(agendaState(openOf(world, 'lead', child))).match({ state: 'resting', sub: 'waiting-on-ferret' });
    should(wrong).match({ handled: true, refused: { code: 'moved-on' } });
    should(world.stored('F1').laneId).equal('tested');
  });

  it('answers a split-off ask by the id of the item it was split from, though it was split off again since', async () => {
    // Arrange — F2's ask went to the child, and then to a grandchild split off the child
    const { world, parent, child } = await parentAndSub();
    const { task: _task, ...plain } = threadAbout('F2');
    const again = await world.agenda.split(
      'lead',
      child,
      { ...plain, subject: 'Is the sub-card right, once more?' },
      AGENT,
      [{ id: 'F2' }],
    );
    if (!again.ok || again.item === undefined) throw new Error('expected a second split');

    // Act — a screen still showing the original answers F2's ask
    const outcome = await world.answer(parent, choose('OK to build'), { sessionId: 'lead', cardAsk: 'gate:F2:plan:2' });

    // Assert — it reached the grandchild, which carries the ask now
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F2').laneId).equal('implement');
    should(openOf(world, 'lead', again.item.id).cardAsks?.[0]?.answer).match({ response: choose('OK to build') });
  });

  it('records an answer on the new item when a split came between the card moving and the record', async () => {
    // Arrange — the split lands right after the board moved F2: the parent stays open, without F2's ask
    let between: (() => Promise<unknown>) | undefined;
    const { world, parent, splitOff } = await parentAndSubBeforeSplit({
      afterAct: async () => void (await between?.()),
    });
    let child: string | undefined;
    between = async () => {
      between = undefined;
      child = await splitOff();
    };

    // Act — the owner answers F2's ask from the original thread
    const outcome = await world.answer(parent, choose('OK to build'), { sessionId: 'lead', cardAsk: 'gate:F2:plan:2' });

    // Assert — the card moved, the answer and its receipt are on the new item, the ferret is told of that one, and
    // the ask was not withdrawn as moved on
    if (child === undefined) throw new Error('expected the split to have run');
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F2').laneId).equal('implement');
    const f2 = openOf(world, 'lead', child).cardAsks?.find(ask => ask.gate.cardId === 'F2');
    should(f2?.answer).match({ response: choose('OK to build'), receipt: /^[0-9a-f]{64}$/u });
    should(openOf(world, 'lead', parent).cardAsks?.some(ask => ask.gate.cardId === 'F2')).not.be.true();
    should(world.told.some(each => each.message.includes(`!${child}`))).be.true();
  });

  it('answers a split-off ask by the id of an item that was split and then merged into another', async () => {
    // Arrange — F2's ask went to the child; the original was then merged into the lead's thread about F3
    const { world, parent, splitOff } = await parentAndSubBeforeSplit();
    const child = await splitOff();
    const other = await world.agenda.raise('lead', { ...threadAbout('F3'), subject: 'And the footer?' }, AGENT);
    if (!other.ok || other.item === undefined) throw new Error('expected a thread');
    const merged = await world.agenda.merge('lead', other.item.id, parent, HUMAN);
    if (!merged.ok) throw new Error(merged.error.message);

    // Act — a screen still showing the original answers F2's ask
    const outcome = await world.answer(parent, choose('OK to build'), { sessionId: 'lead', cardAsk: 'gate:F2:plan:2' });

    // Assert — it reached the child, which carries the ask, not only the item the original was merged into
    should(outcome).match({ handled: true, mutation: { ok: true } });
    should(world.stored('F2').laneId).equal('implement');
    should(openOf(world, 'lead', child).cardAsks?.[0]?.answer).match({ response: choose('OK to build') });
  });

  it('puts the ask again when Not yet was said on a thread that was merged away, and the thread it joined is set aside', async () => {
    // Arrange — F1's ask rides thread X, the owner says Not yet there, and X is merged into the lead's thread Y
    const world = fixture([leads({ laneId: 'todo' }), leads({ id: 'F2', laneId: 'todo' })]);
    const x = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    const y = await world.agenda.raise('lead', { ...threadAbout('F2'), subject: 'And the menu?' }, AGENT);
    if (!x.ok || !y.ok || x.item === undefined || y.item === undefined) throw new Error('expected two threads');
    await world.move('plan');
    await world.answer(x.item.id, choose('Not yet'), { sessionId: 'lead', cardAsk: 'gate:F1:plan:2' });
    const merged = await world.agenda.merge('lead', y.item.id, x.item.id, HUMAN);
    if (!merged.ok) throw new Error(merged.error.message);

    // Act — Not needed on Y drops that thread, and the Not yet on X was never an answer
    await world.agenda.dismiss('lead', y.item.id, HUMAN);
    await world.gates.written('F1');

    // Assert — the card's own agenda carries the ask, open
    const items = world.open('lead');
    should(items).have.length(1);
    should(items[0]?.sourceRef).equal('card-agenda:F1');
    should(items[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:plan:2']);
    should(items[0]?.cardAsks?.[0]?.answer).be.undefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Try it only when there is something to try (docs/agenda.md § Try it only when there is something to try)
// ---------------------------------------------------------------------------------------------------

/** A merged PR of the card, as the watcher caches it, with the kind of change it read (absent: not read). */
const mergedPr = (number: number, changes?: 'docs-tests' | 'code') => ({
  url: `https://github.com/ferretry/ferretry/pull/${String(number)}`,
  number,
  repo: 'ferretry/ferretry',
  state: 'merged' as const,
  draft: false,
  checks: 'passing' as const,
  mergedAt: NOW,
  mergeSha: 'a'.repeat(40),
  releasedIn: { version: '4.1.0', tag: 'v4.1.0', at: NOW },
  polledAt: NOW,
  ...(changes === undefined ? {} : { changes }),
});

const withPrs = (...prs: ReturnType<typeof mergedPr>[]): Partial<BoardTask> => ({
  links: { prs, branch: null, commits: [], docs: [] },
});

/** The last thing that happened to the card, as its history says. */
const lastEvent = (task: BoardTask) => task.history[task.history.length - 1];

describe('a try-it is asked only when there is something to try', () => {
  it('waits while the card is blocked by an open dependency, asks nothing and closes nothing, then asks once it is free', async () => {
    // Arrange — F1 depends on F2, which is still being built
    const dependency = external({ id: 'F2', laneId: 'implement' });
    const world = fixture([external({ dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] }), dependency]);

    // Act — the card reaches To test while blocked
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');
    await world.gates.sweep();

    // Assert — it stays at To test, and nobody is asked
    should(world.stored().laneId).equal('tested');
    should(world.open()).have.length(0);

    // Act — the dependency is gone; the next look at the card asks as usual
    world.store.cards.set('F1', { ...world.stored(), dependsOn: [] });
    const asked = await world.gates.sweep();

    // Assert
    should(asked).equal(1);
    should(world.open()).have.length(1);
    should(world.open()[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:tested:2']);
  });

  it('waits while the card is blocked by hand', async () => {
    // Arrange
    const world = fixture([external({ blocked: { on: 'external', reason: 'waiting on the vendor', since: NOW } })]);

    // Act
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');

    // Assert
    should(world.stored().laneId).equal('tested');
    should(world.open()).have.length(0);
    should(world.closed()).have.length(0);
  });

  it('closes a private card with one line of reason and asks nobody', async () => {
    // Arrange
    const world = fixture([external({ visibility: 'private', visibilitySource: 'chosen' })]);

    // Act
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');

    // Assert — the daemon closed it, with the reason, and no agenda was raised
    should(world.stored().laneId).equal('closed');
    should(lastEvent(world.stored())).match({
      type: 'moved',
      from: 'tested',
      to: 'closed',
      reason: 'Nothing to try: it is a private card',
      auto: true,
      actor: { kind: 'daemon' },
    });
    should(world.open()).have.length(0);
    should(world.closed()).have.length(0);
    should(world.warnings).eql([]);
  });

  it('closes a card with no steps to try, and one whose steps say there is nothing to try', async () => {
    // Arrange
    const bare = fixture([external({ howToTest: '' })]);
    const said = fixture([external({ howToTest: 'Nothing to try: unit suites pass; no PWA behaviour change.' })]);

    // Act
    for (const world of [bare, said]) {
      await world.board.trigger('F1', 'release.running');
      await world.gates.written('F1');
    }

    // Assert
    should(bare.stored().laneId).equal('closed');
    should(lastEvent(bare.stored())).match({ reason: 'Nothing to try: it has no steps to try' });
    should(said.stored().laneId).equal('closed');
    should(lastEvent(said.stored())).match({ reason: 'Nothing to try: its steps say there is nothing to try' });
    should(bare.open()).have.length(0);
    should(said.open()).have.length(0);
  });

  it('closes a card whose every merged PR changed only docs and tests', async () => {
    // Arrange
    const world = fixture([external(withPrs(mergedPr(1, 'docs-tests'), mergedPr(2, 'docs-tests')))]);

    // Act
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');

    // Assert
    should(world.stored().laneId).equal('closed');
    should(lastEvent(world.stored())).match({ reason: 'Nothing to try: its PRs change only docs and tests' });
    should(world.open()).have.length(0);
  });

  it('still asks when one PR changed code, or when the kind of a PR is not known', async () => {
    // Arrange
    const code = fixture([external(withPrs(mergedPr(1, 'docs-tests'), mergedPr(2, 'code')))]);
    const unknown = fixture([external(withPrs(mergedPr(1, 'docs-tests'), mergedPr(2)))]);
    const none = fixture([external()]);

    // Act
    for (const world of [code, unknown, none]) {
      await world.board.trigger('F1', 'release.running');
      await world.gates.written('F1');
    }

    // Assert — each is asked, exactly as before
    for (const world of [code, unknown, none]) {
      should(world.stored().laneId).equal('tested');
      should(world.open()).have.length(1);
      should(world.open()[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:tested:2']);
    }
  });

  it('leaves the plan gate alone: OK to build is asked for a private card with no steps', async () => {
    // Arrange
    const world = fixture([
      external({ visibility: 'private', visibilitySource: 'chosen', howToTest: '', laneId: 'todo' }),
    ]);

    // Act
    await world.move('plan');

    // Assert
    should(world.stored().laneId).equal('plan');
    should(world.open()).have.length(1);
    should(world.open()[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:plan:2']);
  });

  it('withdraws a try-it ask that was open when the card turned out to have nothing to try', async () => {
    // Arrange — asked while it had steps
    const world = fixture([external()]);
    await world.board.trigger('F1', 'release.running');
    should(world.open()).have.length(1);

    // Act — its steps are emptied, and the card is looked at again
    world.store.cards.set('F1', { ...world.stored(), howToTest: '' });
    await world.gates.sweep();

    // Assert — closed, and the card agenda that held only that ask went with it
    should(world.stored().laneId).equal('closed');
    should(world.open()).have.length(0);
  });

  it('adds one plain line to the open agenda that carries the card, and does not wake it', async () => {
    // Arrange — the lead's own thread about the card, on the owner's turn, before the card reaches To test
    const world = fixture([leads({ visibility: 'private', visibilitySource: 'chosen', laneId: 'implement' })]);
    const raised = await world.agenda.raise('lead', threadAbout('F1'), AGENT);
    if (!raised.ok || raised.item === undefined) throw new Error('expected a thread');
    const before = openOf(world, 'lead', raised.item.id);

    // Act
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');
    await world.gates.sweep();

    // Assert — the card closed; the thread is still open, with one line, no ask, and the same turn
    should(world.stored().laneId).equal('closed');
    const after = openOf(world, 'lead', raised.item.id);
    should(after.cardAsks).be.undefined();
    should(agendaState(after).state).equal(agendaState(before).state);
    should(after.waitingSince).equal(before.waitingSince);
    should((after.history ?? []).filter(entry => entry.note?.includes('Nothing to try') === true)).have.length(1);
    should(after.history?.at(-1)).match({ kind: 'updated', note: '&F1: Nothing to try: it is a private card' });
    // — and the app can tell that line from any other update, and shows its words (the one shape the PWA reads)
    should(nothingToTryLine(after.history?.at(-1)?.note)).equal('&F1: Nothing to try: it is a private card');
    should(after.stage).equal(before.stage);
    should(after.stages).eql(before.stages);
    should(world.open('lead')).have.length(1);
  });

  it('puts the ask on the topic item the card was made from, before opening an item of its own', async () => {
    // Arrange — the owner's topic is !A1 on the lead's agenda; the card was made on its Yes
    const world = fixture([
      leads({ laneId: 'implement', ask: { text: 'make the gates ask me', source: 'owner (agenda !A1)' } }),
    ]);
    const topic = await world.agenda.raise('lead', { ...threadAbout('F0'), task: undefined }, AGENT);
    if (!topic.ok || topic.item === undefined) throw new Error('expected a topic item');
    should(topic.item.id).equal('A1');

    // Act
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');

    // Assert — the ask rides !A1; no card agenda was raised
    const items = world.open('lead');
    should(items).have.length(1);
    should(items[0]?.id).equal('A1');
    should(items[0]?.sourceRef).be.null();
    should(items[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:tested:2']);
  });

  it('reads the topic from the card’s approval first, on the plan gate too', async () => {
    // Arrange
    const world = fixture([
      leads({ laneId: 'todo', approval: { sessionId: 'lead', id: 'A1' }, ask: { text: 'build it', source: 'owner' } }),
    ]);
    const topic = await world.agenda.raise('lead', { ...threadAbout('F0'), task: undefined }, AGENT);
    if (!topic.ok) throw new Error('expected a topic item');

    // Act
    await world.move('plan');

    // Assert
    const items = world.open('lead');
    should(items).have.length(1);
    should(items[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:plan:2']);
  });

  it('opens an item of its own only when the topic item is not open', async () => {
    // Arrange — the card names !A7, which is not on its agendas
    const world = fixture([
      leads({ laneId: 'implement', ask: { text: 'make the gates ask me', source: 'owner (agenda !A7)' } }),
    ]);

    // Act
    await world.board.trigger('F1', 'release.running');
    await world.gates.written('F1');

    // Assert
    const items = world.open('lead');
    should(items).have.length(1);
    should(items[0]?.sourceRef).equal('card-agenda:F1');
  });

  it('never lets a ferret, nor the daemon’s ordinary move, pass a gate', async () => {
    // Arrange — a card asked at To test
    const world = fixture([external()]);
    await world.board.trigger('F1', 'release.running');

    // Act + Assert — the card's own ferret is refused, as before
    await should(world.move('closed', { kind: 'ferret', sessionId: 'grandchild' })).be.rejectedWith(/owner/u);
    // — and so is the daemon through an ordinary move
    await should(world.move('closed', { kind: 'daemon' })).be.rejected();
    should(world.stored().laneId).equal('tested');
  });
});

describe('the daemon’s one close of a card with nothing to try', () => {
  it('closes only a card still at the try-it gate the verdict was about', async () => {
    // Arrange
    const world = fixture([external({ visibility: 'private', visibilitySource: 'chosen', laneId: 'tested' })]);
    const gate = gateOf((await cardsOf(world))[0] as GateCard, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');

    // Act + Assert — a stale entry writes nothing
    should(
      await world.board.closeWhereNothingToTry(
        'F1',
        { laneId: gate.laneId, entry: gate.entry + 1 },
        'Nothing to try: it is a private card',
      ),
    ).be.false();
    should(world.stored().laneId).equal('tested');
    // — the right one closes
    should(
      await world.board.closeWhereNothingToTry(
        'F1',
        { laneId: gate.laneId, entry: gate.entry },
        'Nothing to try: it is a private card',
      ),
    ).be.true();
    should(world.stored().laneId).equal('closed');
  });

  it('closes nothing out of the plan gate', async () => {
    // Arrange
    const world = fixture([external({ laneId: 'todo' })]);
    await world.move('plan');
    const gate = gateOf((await cardsOf(world))[0] as GateCard, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');

    // Act
    const closed = await world.board.closeWhereNothingToTry(
      'F1',
      { laneId: gate.laneId, entry: gate.entry },
      'Nothing to try: x',
    );

    // Assert
    should(closed).be.false();
    should(world.stored().laneId).equal('plan');
  });
});

describe('the close judges the verdict again inside the card’s write', () => {
  const at = async (world: ReturnType<typeof fixture>) => {
    const gate = gateOf((await cardsOf(world))[0] as GateCard, stageGateLanes);
    if (gate === undefined) throw new Error('expected a gate');
    return { laneId: gate.laneId, entry: gate.entry };
  };

  it('closes nothing when real steps arrive at the same entry between the read and the write', async () => {
    // Arrange — a card with no steps: the verdict is "nothing", read at this lane and entry
    const world = fixture([external({ howToTest: '', laneId: 'tested' })]);
    const expect = await at(world);

    // Act — steps are added without the card moving; the close then writes
    world.store.cards.set('F1', { ...world.stored(), howToTest: '1. Open the Inbox\n2. Tap Done' });
    const closed = await world.board.closeWhereNothingToTry('F1', expect, 'Nothing to try: it has no steps to try');

    // Assert
    should(closed).be.false();
    should(world.stored().laneId).equal('tested');
  });

  it('closes nothing when the card is blocked, by hand or by an open dependency, at the same entry', async () => {
    // Arrange — a private card at To test, held there only so the verdict can be read
    const world = fixture([
      external({ visibility: 'private', visibilitySource: 'chosen', laneId: 'tested' }),
      external({ id: 'F2', laneId: 'implement' }),
    ]);
    const expect = await at(world);
    const reason = 'Nothing to try: it is a private card';

    // Act + Assert — blocked by hand
    world.store.cards.set('F1', {
      ...world.stored(),
      blocked: { on: 'external', reason: 'waiting on the vendor', since: NOW },
    });
    should(await world.board.closeWhereNothingToTry('F1', expect, reason)).be.false();
    should(world.stored().laneId).equal('tested');
    // — blocked by an unfinished dependency
    world.store.cards.set('F1', {
      ...world.stored(),
      blocked: null,
      dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }],
    });
    should(await world.board.closeWhereNothingToTry('F1', expect, reason)).be.false();
    should(world.stored().laneId).equal('tested');
    // — and once nothing holds it, the very same close goes through
    world.store.cards.set('F1', { ...world.stored(), dependsOn: [] });
    should(await world.board.closeWhereNothingToTry('F1', expect, reason)).be.true();
    should(world.stored().laneId).equal('closed');
  });

  it('closes nothing when the reason it was asked to record is no longer the verdict', async () => {
    // Arrange — private, so the verdict is "nothing" for that reason alone
    const world = fixture([external({ visibility: 'private', visibilitySource: 'chosen', laneId: 'tested' })]);
    const expect = await at(world);

    // Act + Assert
    should(
      await world.board.closeWhereNothingToTry('F1', expect, 'Nothing to try: its PRs change only docs'),
    ).be.false();
    should(world.stored().laneId).equal('tested');
  });
});

describe('an umbrella or internal card never gets a try-it (&C50, 2026-11-06)', () => {
  // The owner's case: the umbrella &C50 "Split fyd.ts", a chore, had a prerequisite PR linked to it. Its release moved the
  // card to the try-it lane, and an older daemon raised "Try it: Split fyd.ts…" with a box asking the owner about the card.
  const umbrella = (overrides: Partial<BoardTask> = {}): BoardTask =>
    external({
      id: overrides.kind === 'feature' ? 'F50' : 'C50',
      kind: 'chore',
      summary: 'Split fyd.ts into feature modules',
      howToTest: '',
      ...withPrs(mergedPr(1536, 'code')),
      ...overrides,
    });
  const subCard = (id: string, laneId: string, parent = 'C50'): BoardTask =>
    external({ id, laneId, parent: { id: parent } });

  it('closes the C50 umbrella when its PR ships, with one line and no ask, no new agenda and no second prompt', async () => {
    // Arrange — every sub-card shipped and closed, as on 11-06
    const world = fixture([umbrella(), subCard('F1473', 'closed')]);

    // Act — the prerequisite PR is released: the card enters the try-it lane
    await world.board.trigger('C50', 'release.running');
    await world.gates.written('C50');
    await world.gates.sweep();

    // Assert — closed by the daemon with the reason; nobody is asked anything
    const stored = world.store.cards.get('C50');
    should(stored?.laneId).equal('closed');
    should(stored === undefined ? undefined : lastEvent(stored)).match({
      type: 'moved',
      to: 'closed',
      reason: 'Nothing to try: it is internal work, with nothing a person sees',
      actor: { kind: 'daemon' },
    });
    should(world.open()).have.length(0);
    should(world.closed()).have.length(0);
  });

  it('holds an umbrella whose sub-cards are still being built: no ask, nothing closes, even with steps to try', async () => {
    // Arrange — a feature umbrella with steps, a released code PR, and one sub-card still in Implement
    const world = fixture([
      umbrella({ kind: 'feature', howToTest: '1. Open the Inbox\n2. Answer the card' }),
      subCard('F1473', 'closed', 'F50'),
      subCard('F1474', 'implement', 'F50'),
    ]);

    // Act
    await world.board.trigger('F50', 'release.running');
    await world.gates.written('F50');
    await world.gates.sweep();

    // Assert — it waits at the try-it lane; no agenda carries it
    should(world.store.cards.get('F50')?.laneId).equal('tested');
    should(world.open()).have.length(0);
    should(world.closed()).have.length(0);

    // Act — the last sub-card ships; the next look decides again, and now asks once
    world.store.cards.set('F1474', { ...(world.store.cards.get('F1474') as BoardTask), laneId: 'closed' });
    const asked = await world.gates.sweep();

    // Assert
    should(asked).equal(1);
    should(world.open()).have.length(1);
    should(world.open()[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F50:tested:2']);
  });
});

describe('a card that becomes blocked takes back its live try-it ask', () => {
  const blocked = { on: 'external' as const, reason: 'waiting on the vendor', since: NOW };

  it('withdraws an unanswered ask when a block arrives, keeps the card put, and asks again once it is free', async () => {
    // Arrange — the ask is live at To test
    const { world, item } = await atTest();
    should(world.open()).have.length(1);

    // Act — a ferret blocks the card; the next look runs
    world.store.cards.set('F1', { ...world.stored(), blocked });
    await world.gates.sweep();

    // Assert — the ask is gone from Needs you, the card stays at To test, nothing was closed by the daemon
    should(world.stored().laneId).equal('tested');
    should(world.open()).have.length(0);
    should(world.closed().every(each => each.id !== item.id || each.resolvedBy !== 'human')).be.true();

    // Act — unblocked: the next look asks again
    world.store.cards.set('F1', { ...world.stored(), blocked: null });
    const asked = await world.gates.sweep();

    // Assert
    should(asked).equal(1);
    should(world.open()).have.length(1);
    should(world.open()[0]?.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:tested:2']);
  });

  it('withdraws the ask when an unfinished dependency is added', async () => {
    // Arrange
    const { world } = await atTest();
    world.store.cards.set('F2', external({ id: 'F2', laneId: 'implement' }));

    // Act
    world.store.cards.set('F1', { ...world.stored(), dependsOn: [{ task: { id: 'F2' }, until: 'shipped' }] });
    await world.gates.sweep();

    // Assert
    should(world.stored().laneId).equal('tested');
    should(world.open()).have.length(0);
  });

  it('leaves the plan gate’s ask alone, a Not yet on it included: only a try-it can wait', async () => {
    // Arrange — the owner said Not yet to OK to build
    const world = fixture([external({ laneId: 'todo' })]);
    await world.move('plan');
    const [item] = world.open() as [AgendaItem];
    await world.answer(item.id, choose('Not yet'), { cardAsk: 'gate:F1:plan:2', note: 'after the demo' });

    // Act — the card then becomes blocked
    world.store.cards.set('F1', { ...world.stored(), blocked });
    await world.gates.sweep();

    // Assert — the ask is still there, with the owner's words
    should(world.stored().laneId).equal('plan');
    const after = openOf(world, 'grandchild', item.id);
    should(after.cardAsks?.map(ask => gateReference(ask.gate))).eql(['gate:F1:plan:2']);
    should(after.cardAsks?.[0]?.notYet).match({ note: 'after the demo' });
  });

  it('leaves a try-it ask the owner already answered exactly as it is', async () => {
    // Arrange — Not good was answered, and the card came back to To test (a new entry) with its ask answered there
    const { world, item, reference } = await atTest();
    await world.answer(item.id, choose('Done'), { cardAsk: reference });
    const before = openOf(world, 'grandchild', item.id).cardAsks;

    // Act — a block lands on the (now closed) card, and the next look runs
    world.store.cards.set('F1', { ...world.stored(), blocked });
    await world.gates.sweep();

    // Assert — the answered ask is the agenda's record and is untouched
    should(openOf(world, 'grandchild', item.id).cardAsks).eql(before);
  });
});

const cardsOf = async (world: ReturnType<typeof fixture>): Promise<readonly GateCard[]> =>
  await new BoardGateCards(world.board, { project: async () => ({ name: 'Ferretry' }) }).cards();
