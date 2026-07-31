import { TaskBoardError } from '../../lib/task-boards/error.ts';
import {
  emptyTaskBoardState,
  parseTaskBoardSnapshot,
  serializeTaskBoardSnapshot,
} from '../../lib/task-boards/snapshot.ts';
import type { TaskBoardMutation, TaskBoardRepository, TaskBoardRepositoryState } from '../../lib/task-boards/types.ts';
import { AtomicFileWriter } from '../tasks/atomic-file.ts';
import { KeyedSerialExecutor, type SerialExecutor } from '../tasks/serial-executor.ts';

/** Collaborators a caller may swap for fault injection; every one has a real default. */
export interface FileTaskBoardRepositoryOptions {
  readonly writer?: AtomicFileWriter;
  readonly executor?: SerialExecutor;
}

/**
 * The file-backed authoritative board repository.
 *
 * ONE JSON document at one injected absolute path holds every board, every binding, every invitation
 * proof and the creation ledger, so a whole membership decision — read the state, run the reducer,
 * commit the result — lands in a single atomic rename. That is what makes `transaction` genuinely
 * atomic rather than nearly atomic: there is no second write to lose halfway through granting
 * somebody authority.
 *
 * WHY ONE DOCUMENT FOR THE WHOLE FLEET RATHER THAN ONE PER BOARD. Every reducer here reasons across
 * boards, not within one: `invitation.accept` searches EVERY board for the invitation that names the
 * accepting session, and `authorize` finds a caller by scanning all bindings. Sharding by board would
 * turn each of those into a fan-out read that no per-file lock could make consistent.
 *
 * SERIALIZATION IS ON THE PATH, and the path is the whole repository, so every transaction in the
 * process is serialized against every other one. That is the correct grain: two concurrent grants on
 * DIFFERENT boards still both read `state.bindings`, and a binding is what proves a session is not
 * already a member somewhere else.
 *
 * Placement is not decided here. The composition root hands over an absolute path; a store that
 * derived its own could not be pointed at a test's temp home.
 */
export class FileTaskBoardRepository implements TaskBoardRepository {
  private readonly writer: AtomicFileWriter;
  private readonly executor: SerialExecutor;

  constructor(
    private readonly snapshotPath: string,
    options: FileTaskBoardRepositoryOptions = {},
  ) {
    this.writer = options.writer ?? new AtomicFileWriter();
    this.executor = options.executor ?? new KeyedSerialExecutor();
  }

  /**
   * The readable repository state.
   *
   * A document that will not parse REFUSES rather than reading as empty. An empty repository means
   * "nobody is a member of anything", which every authorization check would honour by denying — and
   * a board whose members all silently lost their grants is indistinguishable, to them, from a board
   * that was deliberately revoked.
   */
  async snapshot(): Promise<TaskBoardRepositoryState> {
    return await this.executor.run(this.snapshotPath, async () => await this.read());
  }

  /**
   * Runs one transaction: read the authoritative document, hand the whole repository to the reducer,
   * and commit its entire result atomically.
   *
   * The reducer runs INSIDE the critical section, so a decision made against `state` is committed
   * before any other transaction can observe — or invalidate — it. A reducer that throws commits
   * nothing: the document is left exactly as it was, which is what makes a refused grant leave no
   * trace beyond the audit the reducer chose to write.
   */
  async transaction<T>(operation: (state: TaskBoardRepositoryState) => Promise<TaskBoardMutation<T>>): Promise<T> {
    return await this.executor.run(this.snapshotPath, async () => {
      const current = await this.read();
      const mutation = await operation(current);
      await this.writer.write(this.snapshotPath, serializeTaskBoardSnapshot(mutation.state));
      return mutation.result;
    });
  }

  /** The document, or the empty repository when the home has never held a board. */
  private async read(): Promise<TaskBoardRepositoryState> {
    const text = await this.writer.read(this.snapshotPath);
    if (text === null) return emptyTaskBoardState();
    const parsed = parseTaskBoardSnapshot(text);
    if (!parsed.ok) {
      throw new TaskBoardError(
        'unavailable',
        `refusing to serve an unreadable task-board document at ${this.snapshotPath}: ${parsed.failure.detail}`,
      );
    }
    return parsed.state;
  }
}
