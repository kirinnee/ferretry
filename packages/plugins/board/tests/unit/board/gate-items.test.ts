import { describe, it } from 'bun:test';
import type { AskDraft } from '@ferretry/core-asks/contract';
import type { Card, CardId } from '../../../contract/index.ts';
import should from 'should';
import {
  type BoardCaller,
  BoardService,
  type CardObligations,
  type GateAnswer,
  type GateBoard,
  type GateCard,
  GateItems,
  type OpenCardAskEntry,
  stageGateLanes,
} from '../../../daemon/lib/board/index.ts';
import { card, MemoryBoardStore, NOW, world } from './support.ts';

/**
 * CARD ASKS (docs/board.md § Cards show progress; their asks ride Asks, source `card`, #1552): a card entering a gate has
 * ONE obligation raised through Asks, leaving withdraws it, and only the owner's answer moves the card — first, through
 * the board, as the owner — and each answer is applied once, by its answer id. The real Board service runs over a
 * fake `CardObligations`.
 */

const OWNER: BoardCaller = { kind: 'owner' };

/**
 * Asks' writes for one ferret, as its agenda service runs them (`KeyedSerialQueue`): one at a time, each starting only
 * once the one before it settled, and never re-entered — work queued from inside a turn waits for that turn to end.
 * Asks calls a source's `apply` INSIDE the turn that then records the answer, and its `close` and `raise` take a
 * turn of their own: this is the lock the integration fake lacks.
 */
class AsksTurns {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(ferret: string, work: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(ferret) ?? Promise.resolve()).then(work, work);
    this.tails.set(
      ferret,
      next.catch(() => undefined),
    );
    return await next;
  }
}

/** Asks' `card` source in memory: idempotent by entry, with the ledger id the real one would give. */
class Obligations implements CardObligations {
  readonly raised: AskDraft[] = [];
  private readonly state = new Map<string, 'open' | 'answered' | 'withdrawn'>();
  private readonly ledger = new Map<string, OpenCardAskEntry>();
  failing = false;

  /** With `turns`, every raise and close takes the ferret's turn, as Asks' own do. */
  constructor(private readonly turns?: AsksTurns) {}

  private async turn<T>(ferret: string, work: () => Promise<T>): Promise<T> {
    return this.turns === undefined ? await work() : await this.turns.run(ferret, work);
  }

  ferretOf(entry: string): string {
    return this.ledger.get(entry)?.ferret ?? '';
  }

  async raise(draft: AskDraft): Promise<boolean> {
    if (this.failing) throw new Error('Asks is unwritable');
    return await this.turn(draft.ferret as string, async () => {
      const entry = String(draft.entry);
      if (this.state.has(entry)) return false;
      this.state.set(entry, 'open');
      this.raised.push(draft);
      const cardId = (draft.ref as { card: CardId }).card;
      this.ledger.set(entry, { entry, ask: `A${String(this.raised.length)}`, ferret: draft.ferret as string, cardId });
      return true;
    });
  }

  async withdraw(entry: string): Promise<void> {
    await this.turn(this.ferretOf(entry), async () => {
      if (this.state.get(entry) === 'open') this.state.set(entry, 'withdrawn');
    });
  }

  stateOf(entry: string): 'open' | 'answered' | 'withdrawn' | undefined {
    return this.state.get(entry);
  }

  async open(cardId?: CardId): Promise<readonly OpenCardAskEntry[]> {
    return [...this.ledger.values()].filter(
      each => this.state.get(each.entry) === 'open' && (cardId === undefined || each.cardId === cardId),
    );
  }

  async answered(cardId: CardId): Promise<ReadonlySet<string>> {
    return new Set(
      [...this.ledger.values()]
        .filter(e => e.cardId === cardId && this.state.get(e.entry) === 'answered')
        .map(e => e.entry),
    );
  }

  /** Asks marks the entry answered once the Board has applied the answer. */
  markAnswered(entry: string): void {
    this.state.set(entry, 'answered');
  }

  openEntries(): readonly string[] {
    return [...this.ledger.values()].filter(e => this.state.get(e.entry) === 'open').map(e => e.entry);
  }
}

const external = (overrides: Partial<Card> = {}): Card => {
  const laneId = overrides.laneId ?? 'implement';
  return card({
    owner: 'child',
    assignee: 'grandchild',
    createdBy: { kind: 'ferret', ferret: 'child' },
    ask: { text: 'make the gates ask me', source: 'owner' },
    summary: 'Gates raise one ask',
    howToTest: '1. Open the Inbox\n2. Answer the card',
    history: [{ seq: 1, at: NOW, actor: { kind: 'ferret', ferret: 'child' }, type: 'created', laneId }],
    ...overrides,
    laneId,
  });
};

const fixture = (
  cards: readonly Card[],
  options: { readonly noCarrier?: boolean; readonly turns?: AsksTurns } = {},
) => {
  const store = new MemoryBoardStore(cards);
  const obligations = new Obligations(options.turns);
  const warnings: string[] = [];
  const told: { readonly card: string; readonly message: string; readonly key: string }[] = [];
  let gates: GateItems | undefined;
  const service = new BoardService(world({ store, gates: { written: async id => await gates?.written(id) } }));
  const read = async (id: CardId): Promise<GateCard | undefined> => {
    const stored = store.cards.get(id);
    if (stored === undefined) return undefined;
    const response = await service.card(id);
    return {
      task: stored,
      laneSet: response.laneSet,
      audience: await service.audienceOf(stored),
      blockedBy: response.card.blockedBy,
      building: 0,
    };
  };
  const board: GateBoard = {
    card: read,
    cards: async () =>
      (await Promise.all([...store.cards.keys()].map(read))).flatMap(each => (each === undefined ? [] : [each])),
    act: async (id, request, caller, expect) => {
      await service.act(id, request, caller, expect);
    },
    closeNothingToTry: async (id, expect, reason) => await service.closeWhereNothingToTry(id, expect, reason),
  };
  gates = new GateItems({
    obligations,
    board,
    lanes: stageGateLanes,
    words: {
      told: async (task, message, key) => {
        told.push({ card: task.id, message, key });
      },
    },
    homes: { of: async ferret => ferret },
    ...(options.noCarrier === true
      ? {}
      : { files: { carry: async (_from: string, _to: string, ids: readonly string[]) => ids } }),
    diagnostics: { warn: message => warnings.push(message) },
  });
  const answer = async (entry: string, overrides: Partial<GateAnswer> = {}) => {
    const outcome = await (gates as GateItems).answer({
      answerId: `ans-${entry}-${String(Math.random())}`,
      ask: { ferret: 'grandchild', id: 'A1' },
      entry,
      human: true,
      caller: OWNER,
      ...overrides,
    });
    if (outcome.handled && 'applied' in outcome) {
      obligations.markAnswered(entry);
      await (gates as GateItems).recorded(entry);
    }
    return outcome;
  };
  return {
    store,
    service,
    obligations,
    warnings,
    told,
    answer,
    gates: gates as GateItems,
    stored: (id = 'F1') => store.cards.get(id) as Card,
  };
};

/** A card at To test: its obligation raised, and the entry's reference. */
const atTest = async (cards: readonly Card[] = [external()]) => {
  const world_ = fixture(cards);
  await world_.service.trigger('F1', 'release.running');
  const [open] = await world_.obligations.open('F1');
  if (open === undefined) throw new Error('expected an obligation at To test');
  return { world: world_, entry: open.entry };
};

describe('a card at a gate has one obligation through Asks, never an ask of its own', () => {
  it('should raise one `card` obligation named gate:<card>:<lane>:<entry> when the card reaches To test', async () => {
    // Arrange / Act
    const { world: w, entry } = await atTest();

    // Assert
    should(entry).match(/^gate:F1:tested:\d+$/u);
    should(w.obligations.raised).have.length(1);
    const [draft] = w.obligations.raised;
    should(draft?.source).equal('card');
    should(draft?.kind).equal('choice');
    should((draft?.options ?? []).map(option => option.label)).containEql('Done');
    should(String(draft?.context)).containEql('1. Open the Inbox');
  });

  it('should raise nothing more for a card whose ask is already open: the entry is the idempotency key', async () => {
    const { world: w } = await atTest();

    await w.gates.written('F1');
    await w.gates.written('F1');

    should(w.obligations.raised).have.length(1);
  });

  it('should withdraw the ask when the owner moves the card on without answering it', async () => {
    const { world: w, entry } = await atTest();

    await w.service.act('F1', { action: 'move', to: 'implement', reason: 'not ready' }, OWNER);

    should(w.obligations.openEntries()).not.containEql(entry);
  });

  it('should never ask for an internal card: its lead passes the gate', async () => {
    const w = fixture([external({ ask: { text: 'tidy the logs', source: 'session:child' } })]);

    await w.service.trigger('F1', 'release.running');

    should(w.obligations.raised).be.empty();
  });

  it('should raise a plan card’s ask at Plan, and none for a card that waits on a blocker', async () => {
    const w = fixture([external({ laneId: 'todo' })]);
    await w.service.act('F1', { action: 'move', to: 'plan', reason: 'plan first' }, { kind: 'owner' });

    should(w.obligations.raised.map(draft => String(draft.entry))).eql([
      `gate:F1:plan:${w.stored().history.at(-1)?.seq ?? 0}`,
    ]);
  });

  it('should leave the card where it is and warn when Asks cannot be written', async () => {
    const w = fixture([external()]);
    w.obligations.failing = true;

    await w.service.trigger('F1', 'release.running');

    should(w.stored().laneId).equal('tested');
    should(w.warnings.some(warning => warning.includes('could not follow it'))).be.true();
  });
});

describe('answering a card ask', () => {
  it('should move the card first, as the owner, on Done, and apply the answer once by its answer id', async () => {
    // Arrange
    const { world: w, entry } = await atTest();

    // Act
    const first = await w.answer(entry, { answerId: 'ans-1', choice: 'Done' });
    const replay = await w.answer(entry, { answerId: 'ans-1', choice: 'Done' });

    // Assert
    should(first).eql({ handled: true, applied: true });
    should(replay).eql({ handled: true, applied: true });
    should(w.stored().laneId).equal('closed');
    should(w.stored().history.filter(event => event.type === 'moved')).have.length(2);
  });

  it('should refuse an answer that is not the owner’s and leave the card where it is', async () => {
    const { world: w, entry } = await atTest();

    const outcome = await w.answer(entry, { choice: 'Done', human: false });

    should(outcome).match({ handled: true, refused: { code: 'forbidden' } });
    should(w.stored().laneId).equal('tested');
  });

  it('should refuse an answer for a gate the card has already left, and withdraw the stale ask', async () => {
    const { world: w, entry } = await atTest();
    await w.service.act('F1', { action: 'move', to: 'implement', reason: 'back' }, OWNER);

    const outcome = await w.answer(entry, { choice: 'Done' });

    should(outcome).match({ handled: true, refused: { code: 'moved-on' } });
    should(w.stored().laneId).equal('implement');
  });

  it('should not handle an entry that is not a gate’s', async () => {
    const { world: w } = await atTest();

    should(
      await w.gates.answer({
        answerId: 'x',
        ask: { ferret: 'lead', id: 'A9' },
        entry: 'something-else',
        human: true,
        caller: OWNER,
      }),
    ).eql({
      handled: false,
    });
  });

  it('should refuse a choice the gate does not have', async () => {
    const { world: w, entry } = await atTest();

    const outcome = await w.answer(entry, { choice: 'Maybe' });

    should(outcome).match({ handled: true, refused: { code: 'invalid' } });
    should(w.stored().laneId).equal('tested');
  });

  it('should send a Not good back with the owner’s words, and refuse one without words', async () => {
    // Arrange
    const { world: w, entry } = await atTest();

    // Act
    const bare = await w.answer(entry, { choice: 'Not good' });
    const said = await w.answer(entry, { choice: 'Not good', text: 'the badge is clipped' });

    // Assert
    should(bare).match({ handled: true, refused: { code: 'invalid' } });
    should(said).eql({ handled: true, applied: true });
    should(w.stored().laneId).not.equal('tested');
    should(w.stored().clarifications.at(-1)?.text).containEql('the badge is clipped');
  });

  it('should treat the owner’s words alone, with no choice, as the gate’s Not good', async () => {
    const { world: w, entry } = await atTest();

    const outcome = await w.answer(entry, { text: 'the badge is clipped' });

    should(outcome).eql({ handled: true, applied: true });
    should(w.stored().laneId).not.equal('tested');
  });

  it('should keep a one-option gate’s card where it is on "Not yet", tell its ferret, and keep the words as the owner’s', async () => {
    // Arrange: the Plan gate offers only "OK to build", so "Not yet" is its second answer
    const w = fixture([external({ laneId: 'todo' })]);
    await w.service.act('F1', { action: 'move', to: 'plan', reason: 'plan first' }, OWNER);
    const [open] = await w.obligations.open('F1');

    // Act
    const outcome = await w.answer(open?.entry ?? '', { choice: 'Not yet', text: 'after lunch' });

    // Assert
    should(outcome).eql({ handled: true, applied: true });
    should(w.stored().laneId).equal('plan');
    should(w.told.map(each => each.message).join('\n')).containEql('after lunch');
    should(w.stored().clarifications.at(-1)?.text).equal('after lunch');
  });

  it('should refuse files with anything but a Not good, and where this daemon carries none', async () => {
    const { world: w, entry } = await atTest();
    const att = { from: 'grandchild', ids: [`att_${'a'.repeat(64)}`] };

    const wrong = await w.answer(entry, { choice: 'Done', attachments: att });

    should(wrong).match({ handled: true, refused: { code: 'invalid' } });
    should(w.stored().laneId).equal('tested');
  });
});

describe('a try-it is asked only when there is something to try', () => {
  it('should close a card whose How to test says nothing to try, with the reason, and ask nobody', async () => {
    const w = fixture([external({ howToTest: 'Nothing to try: docs only' })]);

    await w.service.trigger('F1', 'release.running');

    should(w.obligations.raised).be.empty();
    should(w.stored().laneId).equal('closed');
    should(JSON.stringify(w.stored().history)).containEql('Nothing to try');
  });

  it('should ask nothing for a card that is blocked, and ask once it is unblocked', async () => {
    const w = fixture([external({ blocked: { on: 'external', reason: 'vendor', since: NOW } })]);
    await w.service.trigger('F1', 'release.running');
    should(w.obligations.raised).be.empty();
    should(w.stored().laneId).equal('tested');

    await w.service.act('F1', { action: 'unblock' }, { kind: 'owner' });

    should(w.obligations.raised).have.length(1);
  });
});

describe('the boot backfill and the sweep', () => {
  it('should raise the ask of every card at a gate, once, and count them', async () => {
    const w = fixture([
      external({
        laneId: 'tested',
        history: [{ seq: 1, at: NOW, actor: { kind: 'ferret', ferret: 'child' }, type: 'created', laneId: 'tested' }],
      }),
    ]);

    const first = await w.gates.backfill();
    const second = await w.gates.backfill();

    should(first).equal(1);
    should(second).equal(0);
    should(w.obligations.raised).have.length(1);
  });

  it('should withdraw an ask whose card moved on while nobody watched', async () => {
    const { world: w, entry } = await atTest();
    w.store.cards.set('F1', { ...w.stored(), laneId: 'implement' });

    await w.gates.sweep();

    should(w.obligations.openEntries()).not.containEql(entry);
  });

  it('should keep only the newest open ask of a card when two entries are open, and say where it is asking', async () => {
    const { world: w, entry } = await atTest();

    should(await w.gates.asking('F1')).match({ ferret: 'grandchild' });
    should(w.obligations.openEntries()).eql([entry]);
  });
});

describe('#1552 (models Asks’ per-ferret turn, its KeyedSerialQueue) an answer applied inside that turn: the card moves first, then Asks records it, and nothing waits on itself', () => {
  const DEADLOCK_MS = 2000;

  /** Rejects when `work` has not settled in time: an answer that waits on its own turn never does. */
  const within = async <T>(work: Promise<T>): Promise<T> =>
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('the answer never returned: it waits on the turn it runs in')), DEADLOCK_MS);
      }),
    ]);

  /**
   * Asks' answer route for a source question: in the ferret's turn it calls the source's `apply` FIRST and records
   * the answer only when `apply` said applied; `asks.answered` is delivered after that turn's write.
   */
  const answerThroughAsks = async (
    w: ReturnType<typeof fixture>,
    turns: AsksTurns,
    entry: string,
    overrides: Partial<GateAnswer>,
  ) => {
    const ferret = w.obligations.ferretOf(entry);
    const states: (string | undefined)[] = [];
    const outcome = await within(
      turns.run(ferret, async () => {
        const applied = await w.gates.answer({
          answerId: `ans-${entry}`,
          ask: { ferret, id: 'A1' },
          entry,
          human: true,
          caller: OWNER,
          ...overrides,
        });
        states.push(w.obligations.stateOf(entry), w.stored().laneId);
        if (applied.handled && 'applied' in applied) w.obligations.markAnswered(entry);
        return applied;
      }),
    );
    if (outcome.handled && 'applied' in outcome) await within(w.gates.recorded(entry));
    // Work the answer left for after Asks' turn queues behind it: one more turn of that ferret runs after it.
    await Bun.sleep(5);
    await within(turns.run(ferret, async () => undefined));
    return { outcome, during: states };
  };

  const atTestLocked = async () => {
    const turns = new AsksTurns();
    const w = fixture([external()], { turns });
    await w.service.trigger('F1', 'release.running');
    const [open] = await w.obligations.open('F1');
    if (open === undefined) throw new Error('expected an obligation at To test');
    return { w, turns, entry: open.entry };
  };

  it('should return a Done, with the card moved while the ask was still open, then the ask answered (never withdrawn)', async () => {
    // Arrange
    const { w, turns, entry } = await atTestLocked();

    // Act
    const { outcome, during } = await answerThroughAsks(w, turns, entry, { choice: 'Done' });

    // Assert: the card moved FIRST (the ask still open), then Asks recorded the answer
    should(outcome).eql({ handled: true, applied: true });
    should(during).eql(['open', 'closed']);
    should(w.obligations.stateOf(entry)).equal('answered');
    should(w.obligations.openEntries()).be.empty();
  });

  it('should return a Not good (reopen) and leave no ask open once Asks recorded it', async () => {
    const { w, turns, entry } = await atTestLocked();

    const { outcome } = await answerThroughAsks(w, turns, entry, { choice: 'Not good', text: 'the badge is clipped' });

    should(outcome).eql({ handled: true, applied: true });
    should(w.stored().laneId).not.equal('tested');
    should(w.obligations.stateOf(entry)).equal('answered');
    should(w.obligations.openEntries()).be.empty();
  });

  it('should refuse an answer to a gate the card left without waiting on itself, and withdraw that ask after Asks’ turn', async () => {
    // Arrange: the owner moved the card on the board; the ask is left open (a write that was missed)
    const { w, turns, entry } = await atTestLocked();
    w.store.cards.set('F1', { ...w.stored(), laneId: 'implement' });

    // Act
    const { outcome, during } = await answerThroughAsks(w, turns, entry, { choice: 'Done' });

    // Assert: refused, the ask still open while Asks' turn ran, and withdrawn after it
    should(outcome).match({ handled: true, refused: { code: 'moved-on' } });
    should(during[0]).equal('open');
    should(w.obligations.stateOf(entry)).equal('withdrawn');
    should(w.stored().laneId).equal('implement');
  });

  it('should keep the ferret’s later asks working after an answer: a second card’s ask is raised in its own turn', async () => {
    const { w, turns, entry } = await atTestLocked();
    await answerThroughAsks(w, turns, entry, { choice: 'Done' });

    // The next write of that ferret's board takes its turn and returns.
    await within(w.obligations.withdraw('gate:F9:tested:1'));
    should(w.obligations.openEntries()).be.empty();
  });
});
