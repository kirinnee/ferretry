import path from 'node:path';

/** Serializes preflight plus mutation per shared Git directory. */
export class WorktreeOperationQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  async run<T>(commonDir: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(commonDir);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
}
