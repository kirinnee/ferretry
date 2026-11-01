import { describe, it } from 'bun:test';
import should from 'should';
import {
  type DoneNotice,
  DoneDeliveryLadder,
  doneKey,
  doneMessage,
  type ReopenDelivery,
  type ReopenMessenger,
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

const closed = (id: string, title: string, assignee: string | null, owner = 'lead'): DoneNotice => ({
  by: 'owner',
  task: card({
    id,
    title,
    owner,
    assignee,
    laneId: 'closed',
    history: [
      {
        seq: 1,
        at: NOW,
        actor: { kind: 'owner' },
        type: 'moved',
        from: 'tested',
        to: 'closed',
        backward: false,
        reason: null,
      },
    ],
  }),
});

const ladder = (answers: Readonly<Record<string, ReopenDelivery>>, warnings: string[] = []) => {
  const messenger = new FakeMessenger(answers);
  return { messenger, subject: new DoneDeliveryLadder(messenger, { warn: message => warnings.push(message) }) };
};

describe('the line a done card’s ferret is told', () => {
  it('should be one plain sentence for one card, with no tag around it', () => {
    // Act
    const line = doneMessage([{ id: 'F164', title: 'Board Table View' }]);

    // Assert
    should(line).equal('The owner marked &F164 “Board Table View” done.');
  });

  it('should list the cards of a batch in one sentence', () => {
    // Act
    const line = doneMessage([
      { id: 'F1', title: 'First' },
      { id: 'F2', title: 'Second' },
    ]);

    // Assert
    should(line).equal('The owner marked these cards done: &F1 “First”, &F2 “Second”.');
  });

  it('should never say the owner closed it when the admin token did: that may be a ferret', () => {
    // Act
    const line = doneMessage([{ id: 'F164', title: 'Board Table View' }], 'admin-token');

    // Assert
    should(line).equal(
      'The admin token (the owner at this machine, or a ferret without its own credential) marked &F164 “Board Table View” done.',
    );
  });
});

describe('a batch closed by different callers', () => {
  it('should tell one ferret twice, each line naming who closed its cards', async () => {
    // Arrange
    const { messenger, subject } = ladder({ child: 'delivered', lead: 'delivered' });

    // Act
    await subject.done([closed('F7', 'Ship it', 'child'), { ...closed('F8', 'And this', 'child'), by: 'admin-token' }]);

    // Assert
    should(messenger.sent.map(([, message]) => message)).deepEqual([
      'The owner marked &F7 “Ship it” done.',
      'The admin token (the owner at this machine, or a ferret without its own credential) marked &F8 “And this” done.',
    ]);
  });
});

describe('delivering a done', () => {
  it("should tell the card's assignee once and stop there", async () => {
    // Arrange
    const { messenger, subject } = ladder({ child: 'delivered', lead: 'delivered' });

    // Act
    await subject.done([closed('F7', 'Ship it', 'child')]);

    // Assert
    should(messenger.sent).deepEqual([['child', 'The owner marked &F7 “Ship it” done.', 'board-done-F7-1']]);
  });

  it("should fall back to the card's owner ferret when the assignee is gone", async () => {
    // Arrange
    const { messenger, subject } = ladder({ lead: 'resumed' });

    // Act
    await subject.done([closed('F7', 'Ship it', 'child')]);

    // Assert
    should(messenger.sent.map(([to]) => to)).deepEqual(['child', 'lead']);
  });

  it('should tell the owner ferret when the card has no assignee', async () => {
    // Arrange
    const { messenger, subject } = ladder({ lead: 'delivered' });

    // Act
    await subject.done([closed('F7', 'Ship it', null)]);

    // Assert
    should(messenger.sent.map(([to]) => to)).deepEqual(['lead']);
  });

  it('should send ONE message per ferret for a bulk close, listing its cards', async () => {
    // Arrange
    const { messenger, subject } = ladder({ child: 'delivered', other: 'delivered' });

    // Act
    await subject.done([
      closed('F1', 'First', 'child'),
      closed('F2', 'Second', 'other'),
      closed('F3', 'Third', 'child'),
    ]);

    // Assert
    should(messenger.sent).deepEqual([
      ['child', 'The owner marked these cards done: &F1 “First”, &F3 “Third”.', 'board-done-F1-1+F3-1'],
      ['other', 'The owner marked &F2 “Second” done.', 'board-done-F2-1'],
    ]);
  });

  it('should say so when nobody on the card can be reached', async () => {
    // Arrange
    const warnings: string[] = [];
    const { subject } = ladder({}, warnings);

    // Act
    await subject.done([closed('F7', 'Ship it', 'child')]);

    // Assert
    should(warnings).deepEqual([
      "The owner marked &F7 “Ship it” done. reached no ferret: the card's assignee and owner are gone, so it is orphaned",
    ]);
  });

  it('should say nothing for an empty batch, and key a message by its cards and closing events', async () => {
    // Arrange
    const { messenger, subject } = ladder({});

    // Act
    await subject.done([]);

    // Assert
    should(messenger.sent).deepEqual([]);
    should(doneKey([{ task: card({ id: 'F9', history: [] }), by: 'owner' }])).equal('board-done-F9-0');
  });
});
