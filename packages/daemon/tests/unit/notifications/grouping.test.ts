import { describe, it } from 'bun:test';
import { type AttentionItem, AttentionItemSchema, AttentionSnapshotSchema } from '@ferretry/protocol';
import should from 'should';
import {
  ATTENTION_GROUP_WINDOW_MS,
  GroupedAttentionRaises,
  type GroupedRaiseSink,
  type NotificationTimers,
} from '../../../src/lib/notifications/grouping.ts';

const AT = '2026-10-23T10:00:00.000Z';

function ask(id: string, session: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return AttentionItemSchema.parse({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}?`,
    why: 'Blocked.',
    waitingSince: AT,
    howToResolve: 'Answer.',
    ask: { kind: 'open-question' },
    raisedBy: 'agent',
    raisedBySession: session,
    raisedByName: 'Ada',
    waitingOn: 'ferret',
    askedAt: AT,
    waitingFor: 'discussion',
    ...overrides,
  });
}

const snapshot = (session: string, items: readonly AttentionItem[]) =>
  AttentionSnapshotSchema.parse({
    v: 1,
    sessionId: session,
    items,
    resolved: [],
    count: items.length,
    parseErrors: 0,
    updatedAt: AT,
  });

class Timers implements NotificationTimers {
  readonly pending = new Map<string, { delayMs: number; task: () => void }>();
  schedule(key: string, delayMs: number, task: () => void): void {
    this.pending.set(key, { delayMs, task });
  }
  cancel(key: string): void {
    this.pending.delete(key);
  }
  fire(key: string): void {
    const timer = this.pending.get(key);
    this.pending.delete(key);
    timer?.task();
  }
}

class Sink implements GroupedRaiseSink {
  readonly single: string[] = [];
  readonly groups: Array<{ sessionId: string; ids: string[] }> = [];
  async raised(_: string, item: AttentionItem): Promise<void> {
    this.single.push(item.id);
  }
  async groupRaised(sessionId: string, items: readonly AttentionItem[]): Promise<void> {
    this.groups.push({ sessionId, ids: items.map(each => each.id) });
  }
}

describe('Grouped attention raises', () => {
  it('should gather one session’s asks inside the window and announce them once, after it', async () => {
    // Arrange
    const sink = new Sink();
    const timers = new Timers();
    const raises = new GroupedAttentionRaises(sink, timers);
    const [a, b, c] = [ask('A1', 's1'), ask('A2', 's1'), ask('A3', 's1')] as const;

    // Act
    await raises.raised('s1', a, snapshot('s1', [a]));
    await raises.raised('s1', b, snapshot('s1', [a, b]));
    await raises.raised('s1', c, snapshot('s1', [a, b, c]));
    const before = sink.groups.length;
    const window = timers.pending.get('attention-group:s1')?.delayMs;
    timers.fire('attention-group:s1');
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    should(before).equal(0);
    should(window).equal(ATTENTION_GROUP_WINDOW_MS);
    should(sink.groups).deepEqual([{ sessionId: 's1', ids: ['A1', 'A2', 'A3'] }]);
    should(sink.single).deepEqual([]);
  });

  it('should keep two sessions apart, and start a fresh group after a flush', async () => {
    // Arrange
    const sink = new Sink();
    const timers = new Timers();
    const raises = new GroupedAttentionRaises(sink, timers);
    const [a, b] = [ask('A1', 's1'), ask('A1', 's2')] as const;

    // Act
    await raises.raised('s1', a, snapshot('s1', [a]));
    await raises.raised('s2', b, snapshot('s2', [b]));
    await raises.flush('s1');
    const again = ask('A2', 's1');
    await raises.raised('s1', again, snapshot('s1', [a, again]));
    await raises.flush('s1');
    await raises.flush('s2');
    await raises.flush('s2');

    // Assert
    should(sink.groups).deepEqual([
      { sessionId: 's1', ids: ['A1'] },
      { sessionId: 's1', ids: ['A2'] },
      { sessionId: 's2', ids: ['A1'] },
    ]);
  });

  it('should announce a card that is not in discussion at once, and never gather it', async () => {
    // Arrange
    const sink = new Sink();
    const timers = new Timers();
    const raises = new GroupedAttentionRaises(sink, timers);
    const surfaced = ask('A1', 's1', { waitingOn: undefined, askedAt: undefined, waitingFor: undefined });

    // Act
    await raises.raised('s1', surfaced, snapshot('s1', [surfaced]));

    // Assert
    should(sink.single).deepEqual(['A1']);
    should(timers.pending.size).equal(0);
  });

  it('should contain a sink that fails', async () => {
    // Arrange
    const sink = new Sink();
    sink.groupRaised = async () => {
      throw new Error('push is down');
    };
    const raises = new GroupedAttentionRaises(sink, new Timers());
    const a = ask('A1', 's1');
    await raises.raised('s1', a, snapshot('s1', [a]));

    // Act / Assert
    await raises.flush('s1');
  });
});
