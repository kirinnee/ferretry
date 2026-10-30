import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ReopenDelivery,
  ReopenDeliveryLadder,
  type ReopenMessenger,
  type ReopenNotice,
  reopenKey,
} from '../../../src/lib/board/index.ts';
import { card, NOW } from './support.ts';

class FakeMessenger implements ReopenMessenger {
  readonly sent: Array<readonly [string, string, string]> = [];

  constructor(private readonly answers: Readonly<Record<string, ReopenDelivery>>) {}

  async deliver(sessionId: string, message: string, key: string): Promise<ReopenDelivery> {
    this.sent.push([sessionId, message, key]);
    return this.answers[sessionId] ?? 'absent';
  }
}

const notice = (overrides: Partial<ReopenNotice['task']> = {}): ReopenNotice => ({
  task: card({
    id: 'F412',
    owner: 'lead',
    assignee: 'child',
    laneId: 'implement',
    history: [
      { seq: 1, at: NOW, actor: { kind: 'ferret', sessionId: 'lead' }, type: 'created', laneId: 'todo' },
      {
        seq: 2,
        at: NOW,
        actor: { kind: 'owner' },
        type: 'reopened',
        from: 'tested',
        to: 'implement',
        reason: 'not good',
        ask: { text: 'not good', source: 'owner (board move)' },
      },
    ],
    ...overrides,
  }),
  from: 'tested',
  to: 'implement',
  reason: 'not good',
  by: { kind: 'owner' },
});

const LINE = '&F412 was reopened by the owner: not good';

const ladder = (answers: Readonly<Record<string, ReopenDelivery>>, warnings: string[] = []) => {
  const messenger = new FakeMessenger(answers);
  return { messenger, subject: new ReopenDeliveryLadder(messenger, { warn: message => warnings.push(message) }) };
};

describe('delivering a reopen', () => {
  it('should queue the line to a live assignee and stop there', async () => {
    // Arrange
    const { messenger, subject } = ladder({ child: 'delivered', lead: 'delivered' });

    // Act
    const delivered = await subject.deliver(notice());

    // Assert
    should(delivered).deepEqual({ to: 'child', how: 'delivered' });
    should(messenger.sent).deepEqual([['child', LINE, 'board-reopen-F412-2']]);
  });

  it('should resume a stopped or finished assignee with the line', async () => {
    // Arrange
    const { subject } = ladder({ child: 'resumed' });

    // Act / Assert
    should(await subject.deliver(notice())).deepEqual({ to: 'child', how: 'resumed' });
  });

  it("should go to the card's owner ferret when the assignee is gone or cannot be resumed", async () => {
    // Arrange
    const gone = ladder({ lead: 'delivered' });
    const held = ladder({ child: 'held', lead: 'resumed' });

    // Act
    const toLead = await gone.subject.deliver(notice());
    const afterHold = await held.subject.deliver(notice());

    // Assert
    should(toLead).deepEqual({ to: 'lead', how: 'delivered' });
    should(gone.messenger.sent.map(([to]) => to)).deepEqual(['child', 'lead']);
    should(afterHold).deepEqual({ to: 'lead', how: 'resumed' });
  });

  it('should leave the card orphaned when no ferret on it can be reached, and say so', async () => {
    // Arrange
    const warnings: string[] = [];
    const { subject } = ladder({}, warnings);

    // Act
    const delivered = await subject.deliver(notice());

    // Assert
    should(delivered).deepEqual({ to: null, how: 'orphaned' });
    should(warnings).deepEqual([
      `${LINE} reached no ferret: the card's assignee and owner are gone, so it is orphaned`,
    ]);
  });

  it('should say where the line is held when nobody could be resumed now', async () => {
    // Arrange
    const warnings: string[] = [];
    const { subject } = ladder({ child: 'held', lead: 'held' }, warnings);

    // Act
    const delivered = await subject.deliver(notice());

    // Assert
    should(delivered).deepEqual({ to: 'child', how: 'held' });
    should(warnings).deepEqual([`${LINE} is held for child's next revive: no ferret on the card could be resumed now`]);
  });

  it('should ask an owner who is also the assignee once, and serve the notifier port', async () => {
    // Arrange
    const { messenger, subject } = ladder({ lead: 'delivered' });

    // Act
    await subject.reopened(notice({ assignee: null }));

    // Assert
    should(messenger.sent).deepEqual([['lead', LINE, 'board-reopen-F412-2']]);
  });

  it("should send the owner's reopen through the owner's messenger, and a ferret's through the plain one", async () => {
    // Arrange
    const plain = new FakeMessenger({ child: 'delivered' });
    const owned = new FakeMessenger({ child: 'delivered' });
    const subject = new ReopenDeliveryLadder(plain, { warn: () => undefined }, owned);

    // Act
    await subject.reopened(notice());
    await subject.reopened({ ...notice(), by: { kind: 'ferret', sessionId: 'lead' } });

    // Assert
    should(owned.sent.map(([to]) => to)).deepEqual(['child']);
    should(plain.sent.map(([to]) => to)).deepEqual(['child']);
  });

  it('should key a reopen by its card and the history event that reopened it', () => {
    // Act / Assert
    should(reopenKey(notice())).equal('board-reopen-F412-2');
    should(reopenKey(notice({ history: [] }))).equal('board-reopen-F412-0');
  });
});
