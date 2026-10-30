import { describe, it } from 'bun:test';
import should from 'should';
import {
  MAX_PENDING_ITEMS,
  mergeQuietItems,
  PendingContextDelivery,
  type PendingContextQueue,
  type QuietItem,
  quietLine,
  withQuietContext,
} from '../../../src/lib/board/index.ts';
import { NOW } from './support.ts';

const item = (key: string, text = key): QuietItem => ({ key, text, at: NOW });

/** A pending context in memory, failing on whichever operation it is told to. */
class MemoryContext implements PendingContextQueue {
  readonly held = new Map<string, readonly QuietItem[]>();

  constructor(private readonly failing: ReadonlySet<'take' | 'restore'> = new Set()) {}

  async append(sessionId: string, items: readonly QuietItem[]): Promise<void> {
    this.held.set(sessionId, mergeQuietItems(this.held.get(sessionId) ?? [], items));
  }

  async take(sessionId: string): Promise<readonly QuietItem[]> {
    if (this.failing.has('take')) throw new Error('unreadable');
    const items = this.held.get(sessionId) ?? [];
    this.held.delete(sessionId);
    return items;
  }

  async restore(sessionId: string, items: readonly QuietItem[]): Promise<void> {
    if (this.failing.has('restore')) throw new Error('read-only');
    this.held.set(sessionId, mergeQuietItems(items, this.held.get(sessionId) ?? []));
  }
}

describe('quiet items', () => {
  it('should keep only the newest item of a key, in the order they last happened', () => {
    // Act
    const merged = mergeQuietItems(
      [item('F1:lane', 'old'), item('F2:lane')],
      [item('F1:lane', 'new'), item('F3:asks')],
    );

    // Assert
    should(merged.map(each => each.text)).eql(['F2:lane', 'new', 'F3:asks']);
  });

  it('should keep only the newest items once there are too many', () => {
    // Act
    const merged = mergeQuietItems(
      [],
      Array.from({ length: MAX_PENDING_ITEMS + 3 }, (_, index) => item(`F${index + 1}:lane`)),
    );

    // Assert
    should(merged).have.length(MAX_PENDING_ITEMS);
    should(merged[0]?.key).equal('F4:lane');
  });

  it('should read as one batched line on top of the message, and leave a message with nothing held alone', () => {
    // Arrange
    const items = [item('a', '&F413 → Review/CI (PR #930)'), item('b', '&F414 waiting on owner (!A9)')];

    // Assert
    should(quietLine(items)).equal('[board] &F413 → Review/CI (PR #930) · &F414 waiting on owner (!A9)');
    should(withQuietContext(items, 'carry on')).equal(`${quietLine(items)}\n\ncarry on`);
    should(withQuietContext([], 'carry on')).equal('carry on');
  });
});

describe('pending context sent as a message of its own', () => {
  it('should send what is held alone, never on anybody’s words, and empty the queue', async () => {
    // The owner read "[board] &F115 → Manually tested" glued to the front of their own message.
    const context = new MemoryContext();
    await context.append('lead', [item('F1:lane', '&F1 → Merged'), item('F2:lane', '&F2 → Review')]);
    const sent: string[] = [];

    await new PendingContextDelivery(context).sendSeparately('lead', async line => {
      sent.push(line);
    });

    should(sent).eql(['[board] &F1 → Merged · &F2 → Review']);
    should(context.held.has('lead')).be.false();
  });

  it('should send nothing when nothing is held or the queue cannot be read', async () => {
    const sent: string[] = [];
    const send = async (line: string): Promise<void> => {
      sent.push(line);
    };

    await new PendingContextDelivery(new MemoryContext()).sendSeparately('lead', send);
    await new PendingContextDelivery(new MemoryContext(new Set(['take']))).sendSeparately('lead', send);

    should(sent).be.empty();
  });

  it('should put the context back when the send fails, and not fail itself', async () => {
    const context = new MemoryContext();
    await context.append('lead', [item('F1:lane', '&F1 → Merged')]);
    const broken = new MemoryContext(new Set(['restore']));
    await broken.append('lead', [item('F1:lane', '&F1 → Merged')]);

    await new PendingContextDelivery(context).sendSeparately('lead', async () => Promise.reject(new Error('full')));
    await new PendingContextDelivery(broken).sendSeparately('lead', async () => Promise.reject(new Error('full')));

    should(context.held.get('lead')?.map(entry => entry.text)).eql(['&F1 → Merged']);
  });
});

describe('pending context delivery', () => {
  it('should put what is held on top of the next message and empty the queue', async () => {
    // Arrange
    const context = new MemoryContext();
    await context.append('lead', [item('F1:lane', '&F1 → Merged')]);
    const sent: string[] = [];

    // Act
    const result = await new PendingContextDelivery(context).send('lead', 'hello', async message => {
      sent.push(message);
      return 'ok';
    });

    // Assert
    should(result).equal('ok');
    should(sent).eql(['[board] &F1 → Merged\n\nhello']);
    should(context.held.has('lead')).be.false();
  });

  it('should send the message bare when nothing is held or the queue cannot be read', async () => {
    // Arrange
    const sent: string[] = [];
    const send = async (message: string) => {
      sent.push(message);
    };

    // Act
    await new PendingContextDelivery(new MemoryContext()).send('lead', 'one', send);
    await new PendingContextDelivery(new MemoryContext(new Set(['take']))).send('lead', 'two', send);

    // Assert
    should(sent).eql(['one', 'two']);
  });

  it('should put the context back, ahead of anything newer, when the send fails', async () => {
    // Arrange
    const context = new MemoryContext();
    await context.append('lead', [item('F1:lane')]);
    const delivery = new PendingContextDelivery(context);

    // Act
    const failure = await delivery
      .send('lead', 'hello', async () => {
        await context.append('lead', [item('F2:lane')]);
        throw new Error('composer busy');
      })
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(Error).and.match({ message: 'composer busy' });
    should(context.held.get('lead')?.map(each => each.key)).eql(['F1:lane', 'F2:lane']);
  });

  it('should put the context back when the send path kept an earlier message, and still answer', async () => {
    // Arrange
    const context = new MemoryContext();
    await context.append('lead', [item('F1:lane', '&F1 → Merged')]);
    const lines: string[] = [];

    // Act
    const result = await new PendingContextDelivery(context).send(
      'lead',
      'hello',
      async () => ({ kept: 'hello' }),
      (sent, line) => {
        lines.push(line);
        return sent.kept.includes(line);
      },
    );

    // Assert
    should(result).eql({ kept: 'hello' });
    should(lines).eql(['[board] &F1 → Merged']);
    should(context.held.get('lead')?.map(each => each.key)).eql(['F1:lane']);
  });

  it('should still rethrow the send failure when the context cannot be put back', async () => {
    // Arrange
    const context = new MemoryContext(new Set(['restore']));
    await context.append('lead', [item('F1:lane')]);

    // Act
    const failure = await new PendingContextDelivery(context)
      .send('lead', 'hello', async () => {
        throw new Error('refused');
      })
      .catch((error: unknown) => error);

    // Assert
    should(failure).match({ message: 'refused' });
  });
});
