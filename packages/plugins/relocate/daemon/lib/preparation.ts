import type { Clock } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { SnapshotInputs } from './snapshot.ts';

/** One deadline covers stopping, reading and sealing. Late answers cannot start another read or publish an export. */
export class Preparation {
  readonly #deadline: number;
  readonly #timeout: Promise<never>;
  readonly #cancel: () => void;
  #reject!: (error: Error) => void;
  #error: Error | undefined;

  constructor(private readonly clock: Pick<Clock, 'nowMs' | 'after'>) {
    this.#deadline = clock.nowMs() + 60_000;
    this.#timeout = new Promise<never>((_resolve, reject) => {
      this.#reject = reject;
    });
    this.#cancel = clock.after(milliseconds(60_000), () => this.expire());
  }

  get expired(): boolean {
    return this.#error !== undefined || this.clock.nowMs() >= this.#deadline;
  }

  expire(): void {
    if (this.#error !== undefined) return;
    this.#error = new Error('the move preparation exceeded its deadline');
    this.#reject(this.#error);
  }

  // read-scoped: none — races a typed operation against a deadline; never interprets or displays text.
  async wait<T>(work: () => Promise<T>): Promise<T> {
    const check = () => {
      if (this.expired) {
        this.expire();
        throw this.#error;
      }
    };
    check();
    const value = await Promise.race([work(), this.#timeout]);
    check();
    return value;
  }

  close(): void {
    this.#cancel();
  }

  /** Bound each underlying operation too: cancelling gather/plan must prevent their next filesystem/git read. */
  inputs(inputs: SnapshotInputs): SnapshotInputs {
    const { source, tree } = inputs;
    return {
      ...inputs,
      source: {
        secretNames: () => this.wait(() => source.secretNames()),
        busy: () => this.wait(() => source.busy()),
        conversation: () => this.wait(() => source.conversation()),
        files: () => this.wait(() => source.files()),
        read: (file, limit) => this.wait(() => source.read(file, limit)),
      },
      tree:
        tree === undefined
          ? undefined
          : {
              inspect: check => this.wait(() => tree.inspect(check)),
              head: () => this.wait(() => tree.head()),
              remote: () => this.wait(() => tree.remote()),
              ignoredTopLevel: () => this.wait(() => tree.ignoredTopLevel()),
              untracked: () => this.wait(() => tree.untracked()),
              size: path => this.wait(() => tree.size(path)),
              read: (path, limit) => this.wait(() => tree.read(path, limit)),
              commits: limit => this.wait(() => tree.commits(limit)),
              changes: limit => this.wait(() => tree.changes(limit)),
            },
    };
  }
}
