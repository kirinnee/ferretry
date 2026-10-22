import { describe, it } from 'bun:test';
import should from 'should';
import { RememberedHandoverReceipts } from '../../../src/lib/handover/remembered-receipts.ts';
import type { HandoverReceipt, HandoverReceiptStore } from '../../../src/lib/handover/types.ts';
import { receiptAt } from './support.ts';

/** The file store's behaviour, in memory: a full read lists every receipt not yet terminal. */
class FakeStore implements HandoverReceiptStore {
  readonly receipts = new Map<string, HandoverReceipt>();
  scans = 0;
  /** Runs inside a full read, after it has listed, before it answers — to race a write against it. */
  during: (() => Promise<void>) | undefined;
  failure: string | undefined;

  async read(sourceSessionId: string): Promise<HandoverReceipt | null> {
    return this.receipts.get(sourceSessionId) ?? null;
  }

  async write(receipt: HandoverReceipt): Promise<void> {
    this.receipts.set(receipt.sourceSessionId, receipt);
  }

  async pendingSourceSessionIds(): Promise<readonly string[]> {
    this.scans += 1;
    if (this.failure !== undefined) throw new Error(this.failure);
    const open = [...this.receipts.values()]
      .filter(receipt => receipt.phase !== 'completed')
      .map(receipt => receipt.sourceSessionId);
    await this.during?.();
    return open;
  }
}

const open = (id: string): HandoverReceipt => receiptAt('accepted', { sourceSessionId: id });
const done = (id: string): HandoverReceipt => receiptAt('completed', { sourceSessionId: id });

describe('the remembered handover roster', () => {
  it('reads every receipt once, then answers from memory', async () => {
    // Arrange
    const store = new FakeStore();
    store.receipts.set('a', open('a'));
    store.receipts.set('b', done('b'));
    const roster = new RememberedHandoverReceipts(store);
    should(roster.anyOpen()).be.false();

    // Act
    const first = await roster.pendingSourceSessionIds();
    const second = await roster.pendingSourceSessionIds();

    // Assert
    should(first).deepEqual(['a']);
    should(second).deepEqual(['a']);
    should(store.scans).equal(1);
    should(roster.anyOpen()).be.true();
  });

  it('follows every write: an opened receipt joins, a finished one leaves, and listeners hear the opening', async () => {
    // Arrange
    const store = new FakeStore();
    const roster = new RememberedHandoverReceipts(store);
    await roster.pendingSourceSessionIds();
    let heard = 0;
    const unsubscribe = roster.onOpened(() => {
      heard += 1;
    });

    // Act
    await roster.write(open('a'));
    const opened = await roster.pendingSourceSessionIds();
    await roster.write(done('a'));
    const finished = await roster.pendingSourceSessionIds();
    unsubscribe();
    await roster.write(open('c'));

    // Assert
    should(opened).deepEqual(['a']);
    should(finished).deepEqual([]);
    should(heard).equal(1);
    should(store.receipts.get('a')?.phase).equal('completed');
    should(store.scans).equal(1);
  });

  it('forgets a receipt whose directory is gone', async () => {
    // Arrange
    const store = new FakeStore();
    store.receipts.set('a', open('a'));
    const roster = new RememberedHandoverReceipts(store);
    await roster.pendingSourceSessionIds();
    store.receipts.delete('a');

    // Act
    const read = await roster.read('a');

    // Assert
    should(read).be.null();
    should(await roster.pendingSourceSessionIds()).deepEqual([]);
  });

  it('applies a write made during a full read over what that read found', async () => {
    // Arrange — the read lists 'a' open and 'b' absent; while it runs, 'a' finishes and 'b' opens.
    const store = new FakeStore();
    store.receipts.set('a', open('a'));
    const roster = new RememberedHandoverReceipts(store);
    store.during = async () => {
      store.during = undefined;
      await roster.write(done('a'));
      await roster.write(open('b'));
    };

    // Act
    const pending = await roster.pendingSourceSessionIds();

    // Assert
    should(pending).deepEqual(['b']);
  });

  it('reads every receipt again once forgotten', async () => {
    // Arrange
    const store = new FakeStore();
    const roster = new RememberedHandoverReceipts(store);
    await roster.pendingSourceSessionIds();
    store.receipts.set('restored', open('restored'));

    // Act
    roster.forget();
    const pending = await roster.pendingSourceSessionIds();

    // Assert
    should(pending).deepEqual(['restored']);
    should(store.scans).equal(2);
  });

  it('remembers nothing from a full read that failed', async () => {
    // Arrange
    const store = new FakeStore();
    store.failure = 'handover.json is damaged';
    const roster = new RememberedHandoverReceipts(store);

    // Act
    await should(roster.pendingSourceSessionIds()).be.rejectedWith(/damaged/u);
    store.failure = undefined;
    store.receipts.set('a', open('a'));
    const pending = await roster.pendingSourceSessionIds();

    // Assert
    should(pending).deepEqual(['a']);
    should(store.scans).equal(2);
  });
});
