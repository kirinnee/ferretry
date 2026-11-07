import type { SerialExecutor } from '../../../src/lib/index.ts';
import type { SystemCallsignCounters, SystemCallsignCounterStore } from '../../../src/lib/names/index.ts';
import { SystemCallsignIssuer } from '../../../src/lib/names/index.ts';

export class MemoryCounters implements SystemCallsignCounterStore {
  constructor(public counters: SystemCallsignCounters = {}) {}

  async read(): Promise<SystemCallsignCounters> {
    return { ...this.counters };
  }

  async write(counters: SystemCallsignCounters): Promise<void> {
    this.counters = { ...counters };
  }
}

/** Runs every job in call order, one at a time — what the process-wide executor guarantees. */
class QueueExecutor implements SerialExecutor {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(_key: string, work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return await result;
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return await this.run('exclusive', work);
  }
}

export const issuerOver = (
  counters: SystemCallsignCounterStore = new MemoryCounters(),
  held: () => readonly string[] = () => [],
): SystemCallsignIssuer =>
  new SystemCallsignIssuer({ counters, held: async () => held(), serial: new QueueExecutor() });
