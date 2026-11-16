import { describe, it } from 'bun:test';
import type { CardResponse, CardRef } from '../../../contract/index.ts';
import should from 'should';
import { BoardError } from '../../../daemon/lib/board/errors.ts';
import {
  BoardGateCheck,
  type BoardGateCheckPorts,
  type GateCheckItem,
  gateCheckMessage,
  gateCheckSendId,
  isGateLane,
} from '../../../daemon/lib/board/gate-check.ts';
import type { TranscriptEvent } from '../../../daemon/lib/board/transcript-events.ts';
import { card, lanes } from './support.ts';

const TURN_START = '2026-10-30T10:00:00.000Z';
const AFTER = '2026-10-30T10:00:05.000Z';
const BEFORE = '2026-10-30T09:00:00.000Z';

const owner = (text: string, timestamp: string | null = TURN_START): TranscriptEvent => ({
  kind: 'message',
  role: 'user',
  text,
  ...(timestamp === null ? {} : { timestamp }),
});
const call = (name: string, input: unknown): TranscriptEvent =>
  ({ kind: 'tool-call', role: 'assistant', call: { id: name, name, input } }) as TranscriptEvent;
const raising = call('Bash', { command: 'zz ask add --title "Try it" "please test" --card F412' });

/** The ferret's own item on a card, raised after the turn began, unless told otherwise. */
const mine = (overrides: Partial<GateCheckItem> = {}): GateCheckItem => ({
  id: 'A44',
  raisedBy: 'agent',
  card: { id: 'F412' },
  waitingSince: AFTER,
  ...overrides,
});
/** The ask that carries F412's gate obligation, raised by the daemon on its ferret's behalf. */
const gate = (overrides: Partial<GateCheckItem> = {}): GateCheckItem => ({
  id: 'A31',
  raisedBy: 'daemon',
  gateOf: ['F412'],
  waitingSince: BEFORE,
  ...overrides,
});

/** A card in To test (a gate) on the support board, unless told otherwise. */
const response = (overrides: Parameters<typeof card>[0] = {}): CardResponse =>
  ({
    card: { ...card({ id: 'F412', laneId: 'tested', ...overrides }) },
    laneSet: lanes(),
  }) as unknown as CardResponse;

function harness(
  options: {
    readonly events?: readonly TranscriptEvent[];
    readonly items?: readonly GateCheckItem[];
    readonly card?: (ref: CardRef) => Promise<CardResponse>;
    readonly readable?: boolean;
    readonly boardOn?: boolean;
  } = {},
) {
  const sent: { ferret: string; sendId: string; message: string }[] = [];
  const records: { ferret: string; items: readonly string[]; cards: readonly string[] }[] = [];
  const ports: BoardGateCheckPorts = {
    readable: async () => options.readable ?? true,
    boardOn: async () => options.boardOn ?? true,
    tail: async () => options.events ?? [owner('go'), raising],
    open: async () => options.items ?? [mine(), gate()],
    card: options.card ?? (async () => response()),
    send: async (ferret, sendId, message) => void sent.push({ ferret, sendId, message }),
    record: async (ferret, items, cards) => void records.push({ ferret, items, cards }),
  };
  return { ports, sent, records };
}

describe('isGateLane', () => {
  it('should be an owner-gated lane that is not closed', () => {
    // Act + Assert
    const set = lanes();
    const byId = (id: string) => set.lanes.find(lane => lane.id === id)!;
    should(isGateLane(byId('tested'))).be.true();
    should(isGateLane(byId('plan'))).be.true();
    should(isGateLane(byId('closed'))).be.false();
    should(isGateLane(byId('implement'))).be.false();
    should(
      isGateLane({
        ...byId('implement'),
        stage: { kind: 'gate', options: [{ id: 'ok', label: 'OK', outcome: { kind: 'next' } }] },
      }),
    ).be.true();
    should(isGateLane({ ...byId('plan'), stage: { kind: 'auto', triggers: ['work.started'] } })).be.false();
  });
});

describe('the gate check words', () => {
  it('should name the card, the agenda that carries it, how to add to it and how to drop the ferret item, one line each', () => {
    // Act + Assert
    should(gateCheckMessage([{ card: 'F412', gateItem: 'A31', item: 'A44' }], 'zz')).equal(
      '&F412 already asks the owner on !A31, which carries the card: put yours on it (zz ask edit A31 --where "<each existing point>" --where "<what you need>"; --where replaces them all, so repeat the ones already there), then drop !A44: zz ask dismiss !A44',
    );
    should(
      gateCheckMessage(
        [
          { card: 'F412', gateItem: 'A31', item: 'A44' },
          { card: 'F9', gateItem: 'A5', item: 'A45' },
        ],
        'zz',
      ).split('\n'),
    ).have.length(2);
  });

  it('should key a send by the session and the items, in any order', () => {
    // Act + Assert
    should(gateCheckSendId('s-1', ['A45', 'A44'])).equal(gateCheckSendId('s-1', ['A44', 'A45']));
    should(gateCheckSendId('s-1', ['A44'])).equal('board-gate-check-s-1-A44');
  });
});

describe('BoardGateCheck', () => {
  it('should nudge a turn that raised an item on a card at a gate, once, and journal it', async () => {
    // Arrange
    const h = harness();
    const check = new BoardGateCheck(h.ports, 'zz');

    // Act
    const first = await check.check('s-1');
    const again = await check.check('s-1');

    // Assert
    should([first, again]).eql([true, false]);
    should(h.sent).eql([
      {
        ferret: 's-1',
        sendId: 'board-gate-check-s-1-A44',
        message:
          '&F412 already asks the owner on !A31, which carries the card: put yours on it (zz ask edit A31 --where "<each existing point>" --where "<what you need>"; --where replaces them all, so repeat the ones already there), then drop !A44: zz ask dismiss !A44',
      },
    ]);
    should(h.records).eql([{ ferret: 's-1', items: ['A44'], cards: ['F412'] }]);
  });

  it('should see the Ferretry MCP ask-owner tool as raising too', async () => {
    // Arrange
    const h = harness({ events: [owner('go'), call('mcp__ferretry__terminal_ask_owner', { name: 'dev' })] });

    // Act + Assert
    should(await new BoardGateCheck(h.ports, 'zz').check('s-1')).be.true();
  });

  it('should say nothing on a board that is off, or for a session it cannot read', async () => {
    // Arrange
    const off = harness({ boardOn: false });
    const unreadable = harness({ readable: false });

    // Act + Assert
    should(await new BoardGateCheck(off.ports, 'zz').check('s-1')).be.false();
    should(await new BoardGateCheck(unreadable.ports, 'zz').check('s-1')).be.false();
    should([...off.sent, ...unreadable.sent]).eql([]);
  });

  it('should say nothing for a turn that raised nothing', async () => {
    // Arrange
    const h = harness({ events: [owner('go'), call('Bash', { command: 'zz ask ls' })] });

    // Act + Assert
    should(await new BoardGateCheck(h.ports, 'zz').check('s-1')).be.false();
    should(h.sent).eql([]);
  });

  it('should never check a turn its own nudge started', async () => {
    // Arrange
    const message = gateCheckMessage([{ card: 'F412', gateItem: 'A31', item: 'A44' }], 'zz');
    const h = harness({ events: [owner(message), raising] });

    // Act + Assert
    should(await new BoardGateCheck(h.ports, 'zz').check('s-1')).be.false();
  });

  it('should say nothing when the card is not at a gate', async () => {
    // Arrange
    const building = harness({ card: async () => response({ laneId: 'implement' }) });
    const closed = harness({ card: async () => response({ laneId: 'closed' }) });
    const dropped = harness({
      card: async () => response({ dropped: { reason: 'superseded', at: TURN_START } } as never),
    });

    // Act + Assert
    for (const h of [building, closed, dropped]) {
      should(await new BoardGateCheck(h.ports, 'zz').check('s-1')).be.false();
      should(h.sent).eql([]);
    }
  });

  it("should say nothing when no other agenda carries the card's open ask", async () => {
    // Arrange
    const none = harness({ items: [mine()] });
    const otherCard = harness({ items: [mine(), gate({ gateOf: ['F9'] })] });
    const prefix = harness({ items: [mine(), gate({ gateOf: ['F4123'] })] });
    const answered = harness({ items: [mine(), gate({ gateOf: [] })] });

    // Act + Assert
    for (const h of [none, otherCard, prefix, answered]) {
      should(await new BoardGateCheck(h.ports, 'zz').check('s-1')).be.false();
      should(h.sent).eql([]);
    }
  });

  it("should leave alone an item that is not the ferret's own, new this turn and on a card", async () => {
    // Arrange
    const older = harness({ items: [mine({ waitingSince: BEFORE }), gate()] });
    const noCard = harness({ items: [mine({ card: null }), gate()] });
    const notice = harness({ items: [mine({ notice: true }), gate()] });
    const human = harness({ items: [mine({ raisedBy: 'human' }), gate()] });

    // Act + Assert
    for (const h of [older, noCard, notice, human]) {
      should(await new BoardGateCheck(h.ports, 'zz').check('s-1')).be.false();
      should(h.sent).eql([]);
    }
  });

  it('should say nothing when it cannot tell when the turn began', async () => {
    // Arrange
    const h = harness({ events: [owner('go', null), raising] });

    // Act + Assert
    should(await new BoardGateCheck(h.ports, 'zz').check('s-1')).be.false();
  });

  it('should say nothing for a card that is gone, and throw for one it cannot read', async () => {
    // Arrange
    const gone = harness({
      card: async () => {
        throw new BoardError('not-found', 'there is no card on this machine');
      },
    });
    const broken = harness({
      card: async () => {
        throw new Error('board directory is unreadable');
      },
    });

    // Act + Assert
    should(await new BoardGateCheck(gone.ports, 'zz').check('s-1')).be.false();
    await should(new BoardGateCheck(broken.ports, 'zz').check('s-1')).be.rejectedWith(/unreadable/u);
    should(broken.sent).eql([]);
  });

  it('should name every duplicate in one message', async () => {
    // Arrange
    const h = harness({
      items: [mine(), mine({ id: 'A45' }), gate()],
    });

    // Act
    await new BoardGateCheck(h.ports, 'zz').check('s-1');

    // Assert
    should(h.sent).have.length(1);
    should(h.sent[0]?.message.split('\n')).have.length(2);
    should(h.records[0]?.items).eql(['A44', 'A45']);
    should(h.records[0]?.cards).eql(['F412']);
  });
});
