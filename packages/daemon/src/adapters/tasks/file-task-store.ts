import { TaskError } from '../../lib/tasks/task-error.ts';
import type { DecodedTaskSnapshot, TaskSnapshot } from '../../lib/tasks/task-snapshot.ts';
import { emptyTaskSnapshot, parseTaskSnapshot, serializeTaskSnapshot } from '../../lib/tasks/task-snapshot.ts';
import type { TaskStoreMutation, TaskStorePort } from '../../lib/tasks/task-store-port.ts';
import { AtomicFileWriter } from './atomic-file.ts';
import type { InstantSource } from './file-operations.ts';
import { SystemInstantSource } from './file-operations.ts';
import type { SerialExecutor } from './serial-executor.ts';
import { KeyedSerialExecutor } from './serial-executor.ts';

/** Collaborators a caller may swap for fault injection; every one has a real default. */
export interface FileTaskStoreOptions {
  readonly writer?: AtomicFileWriter;
  readonly executor?: SerialExecutor;
  readonly instants?: InstantSource;
}

/**
 * The file-backed authoritative task container.
 *
 * One JSON snapshot at one injected absolute path holds the whole board — every task and its whole
 * history — so the reducer's complete result is committed by a single atomic rename. That is what
 * makes notes and clarifications interruption-safe: there is no second append to lose.
 *
 * Placement is not decided here. The composition root hands the store a path; the store never
 * derives one, so board layout can change without touching persistence.
 */
export class FileTaskStore implements TaskStorePort<TaskSnapshot> {
  private readonly snapshotPath: string;
  private readonly writer: AtomicFileWriter;
  private readonly executor: SerialExecutor;
  private readonly instants: InstantSource;

  constructor(snapshotPath: string, options: FileTaskStoreOptions = {}) {
    this.snapshotPath = snapshotPath;
    this.writer = options.writer ?? new AtomicFileWriter();
    this.executor = options.executor ?? new KeyedSerialExecutor();
    this.instants = options.instants ?? new SystemInstantSource();
  }

  /**
   * The authoritative readable board. Diagnostic callers that can present partial state use
   * `readDecoded`; a caller asking for the board itself must never confuse damage with absence.
   */
  async read(): Promise<TaskSnapshot> {
    return this.requireClean(await this.readDecoded());
  }

  /**
   * The read a caller needs when it must distinguish "empty board" from "unreadable board": it
   * carries the per-entry parse issues and the fatal flag alongside the decoded snapshot.
   */
  async readDecoded(): Promise<DecodedTaskSnapshot> {
    const rawText = await this.writer.read(this.snapshotPath);
    if (rawText === null) return { snapshot: emptyTaskSnapshot(), parseErrors: [], fatal: false };
    return parseTaskSnapshot(rawText);
  }

  /**
   * Runs one transaction: read the authoritative file, hand the whole board to the reducer, and
   * commit its entire result atomically. Every transaction on this store is globally serialized, so
   * a read cannot observe state that a concurrent write is about to invalidate — which is what makes
   * caller-side ID allocation over the returned graph safe.
   *
   * A snapshot that could not be read is never overwritten: refusing the mutation preserves the
   * evidence instead of replacing a corrupt board with an apparently empty one.
   */
  async transact<TResult>(
    transform: (current: TaskSnapshot) => TaskStoreMutation<TaskSnapshot, TResult>,
  ): Promise<TResult> {
    return await this.executor.run(this.snapshotPath, async () => {
      const current = this.requireClean(await this.readDecoded());
      const mutation = transform(current);
      await this.writer.write(this.snapshotPath, serializeTaskSnapshot(mutation.container));
      return mutation.result;
    });
  }

  /** One malformed entry or activity is enough to make a whole-snapshot replacement destructive. */
  private requireClean(decoded: DecodedTaskSnapshot): TaskSnapshot {
    const first = decoded.parseErrors[0];
    if (first !== undefined) {
      throw new TaskError(
        'invalid',
        `refusing to use a damaged task snapshot at ${this.snapshotPath}: ${first.detail}`,
      );
    }
    return decoded.snapshot;
  }

  /** The instant a caller should stamp onto records it is about to commit. */
  now(): string {
    return this.instants.now();
  }
}
