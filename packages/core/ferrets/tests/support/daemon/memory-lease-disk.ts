import {
  type ConversationId,
  type ConversationLeaseDisk,
  ConversationLeaseRecordSchema,
  type HistoryHarness,
} from '../../../contract/conversation-lease.ts';

/**
 * A conversation-lease disk in memory: the real store's rules run on it, with no folder and no `flock`. Every pid reports
 * the same start time unless a test lists it in {@link MemoryLeaseDisk.gone}.
 */
export class MemoryLeaseDisk implements ConversationLeaseDisk {
  readonly files = new Map<string, string>();
  /** The pids that are NOT running. */
  readonly gone = new Set<number>();

  async exclusive<T>(_harness: HistoryHarness, work: () => Promise<T>): Promise<T> {
    return await work();
  }
  async read(harness: HistoryHarness, conversation: ConversationId): Promise<string | undefined> {
    return this.files.get(`${harness}/${conversation}`);
  }
  async write(harness: HistoryHarness, conversation: ConversationId, text: string): Promise<void> {
    this.files.set(`${harness}/${conversation}`, text);
  }
  async remove(harness: HistoryHarness, conversation: ConversationId): Promise<void> {
    this.files.delete(`${harness}/${conversation}`);
  }
  async list(harness: HistoryHarness): Promise<readonly string[]> {
    return [...this.files.keys()]
      .filter(key => key.startsWith(`${harness}/`))
      .map(key => key.slice(harness.length + 1));
  }
  async startOf(pid: number): Promise<number | undefined> {
    return this.gone.has(pid) ? undefined : 1;
  }
  /** The lease on a conversation as stored, or `undefined` when there is none. */
  lease(harness: HistoryHarness, conversation: string) {
    const text = this.files.get(`${harness}/${conversation}`);
    return text === undefined ? undefined : ConversationLeaseRecordSchema.parse(JSON.parse(text));
  }
}
