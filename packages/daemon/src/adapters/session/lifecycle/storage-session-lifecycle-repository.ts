import { type FileHandle, open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SessionConfig } from '@ferretry/protocol';
import { createSessionPaths, parseSessionId, type SessionId } from '../../../lib/index.ts';
import type {
  SessionLifecycleEvent,
  SessionLifecycleRecord,
  SessionLifecycleRepository,
} from '../../../lib/session/lifecycle/index.ts';
import { SessionLifecycleRecordSchema } from '../../../lib/session/lifecycle/types.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** Raised instead of a raw parse error, so a caller can tell a broken record from a missing one. */
export class UnusableSessionRecordError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly reason: string,
  ) {
    super(`session record ${sessionId} is unusable: ${reason}`);
    this.name = 'UnusableSessionRecordError';
  }
}

/**
 * The fields the PROTOCOL's session document demands that the lifecycle does not decide.
 *
 * ONE DOCUMENT SERVES TWO SCHEMAS, which is why this type exists. `config.json` is written here and
 * read back by every mounted surface — the session list, task-board enrichment, analytics and the
 * callsign pool — and those parse it with `SessionConfigSchema`, which demands an incarnation, a
 * harness, a turn count and a dozen operator knobs the lifecycle has no opinion about. A document
 * carrying only the lifecycle's own fields is dropped by every one of those reads, so a session
 * started through the lifecycle would be invisible to the product that started it.
 *
 * It is the protocol's configuration MINUS what the lifecycle owns: the id, the title, the working
 * directory, the mode, the parent and the two instants are the lifecycle's decisions and are never
 * taken from here.
 */
export type SessionProtocolEnvelope = Omit<
  SessionConfig,
  'id' | 'name' | 'cwd' | 'mode' | 'parent' | 'createdAt' | 'updatedAt'
>;

/** A JSON document as a plain field bag, or `undefined` when it is anything else. */
function fields(document: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * The lifecycle's view of a persisted session document.
 *
 * `agent` is the one field the two schemas disagree about: the lifecycle demands the ABSOLUTE
 * executable, because `authorizeSessionCommand` is what stops the daemon launching anything but a
 * fleet auto-wrapper, while the protocol's `agent` is the wrapper NAME every account in the fleet
 * manifest is listed under and every surface displays. The executable is recovered from the argv
 * rather than stored twice — `command[0]` IS the agent, which that same authorization guarantees.
 */
export function lifecycleConfigDocument(document: unknown): unknown {
  const bag = fields(document);
  if (bag === undefined) return document;
  const command = bag.command;
  const executable = Array.isArray(command) ? command[0] : undefined;
  return typeof executable === 'string' ? { ...bag, agent: executable } : bag;
}

/** A stored turn count, when the document holds a usable one. */
function storedTurn(state: Readonly<Record<string, unknown>> | undefined): number | undefined {
  const turn = state?.turn;
  return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : undefined;
}

/**
 * Whether an error means this platform cannot sync a directory at all.
 *
 * Exactly the three the state filesystem tolerates, and no more — a directory sync that failed for
 * any other reason has not happened, and the durability this file promises would be a lie.
 */
function unsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM';
}

/**
 * Persisting one directory's own entries, for the reservation boundary above.
 *
 * A directory fsync is not universally supported, so the same three errnos `StateFileSystem` already
 * tolerates are tolerated here — from the OPEN as well as the sync, because that is where such a
 * platform usually refuses — and a filesystem that cannot sync a directory must not fail a start.
 * Everything else propagates, because a reservation that could not be made durable for any other
 * reason has not been made.
 */
export async function fsyncReservedDirectory(
  path: string,
  /**
   * Opens the directory to be synced.
   *
   * A parameter rather than a constructor port, and defaulted to the real call, because the ONLY
   * thing a test needs to vary is which errno the open produces — and that cannot be produced from
   * outside on a filesystem that supports directory opens. Nothing else about the helper varies.
   */
  openDirectory: (target: string) => Promise<FileHandle> = target => open(target, 'r'),
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openDirectory(path);
  } catch (error) {
    // TOLERATED AT THE OPEN TOO, which is where a filesystem that cannot sync directories usually
    // says so: it refuses the read-only open of a directory rather than failing the fsync behind it.
    if (!unsupportedDirectorySync(error)) throw error;
    return;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}
/** Stores lifecycle records in the daemon's authoritative config/state/journal triplet. */
export class StorageSessionLifecycleRepository implements SessionLifecycleRepository {
  constructor(
    private readonly storage: DaemonStorage,
    /**
     * The protocol fields THIS start decided, present only for a session this daemon is creating.
     *
     * A later mutation of an existing session — a stop, a retried start — carries none: its
     * envelope is already in the document on disk, and merging over that document is what keeps a
     * transition from erasing the half of it the lifecycle does not own.
     */
    private readonly envelope?: SessionProtocolEnvelope,
    /**
     * Persists one directory's own entries.
     *
     * A seam solely so the ORDER can be proved — reservation first, then the parent — because that
     * ordering is a claim about invisible IO and a claim about invisible IO rots silently. Nothing
     * else varies it.
     */
    private readonly syncDirectory: (path: string) => Promise<void> = fsyncReservedDirectory,
  ) {}

  /**
   * Reserves the session's layout, then persists it, then persists the entry that NAMES it.
   *
   * TWO DIRECTORIES, INNERMOST FIRST, AND ON EVERY CALL. An entry lives in its immediate parent, so
   * the journal and marker entries live in the SESSION directory and the session directory's own
   * name lives in `<sessions>`. Persisting only the parent makes the target reachable and its
   * contents still losable; persisting only the session directory makes its contents durable inside
   * an inode nothing names. The reservation barrier owes both.
   *
   * WHY IT CANNOT BE CONDITIONAL ON HAVING CREATED ANYTHING. Storage publishes the marker with an
   * atomic rename and syncs the session directory AFTER it, so a process that dies in between leaves
   * a marker that is page-cache-visible but not durable. The next `ensureSessionDirectory` sees a
   * current marker, merely observes the journal and returns without syncing anything — so the retry
   * that "found everything already there" is exactly the call that must sync, and it is the one a
   * created-only rule would skip. The same reasoning covers a concurrent creator: an attempt that
   * observes another's directory cannot know whether that other attempt has reached its own sync.
   *
   * WHY IT IS HERE AND NOT IN STORAGE. `reserveSessionDirectory` stays layout-only; the broader
   * storage guarantee is a declared #F117 GAP. This is the lifecycle's own boundary making its own
   * reservation whole, with no `DaemonStorage` or `StateFileSystem` interface change.
   */
  async reserve(id: SessionId): Promise<void> {
    await this.storage.reserveSessionDirectory(id);
    await this.syncDirectory(createSessionPaths(this.storage.paths, id).directory);
    await this.syncDirectory(this.storage.paths.sessions);
  }

  async read(id: SessionId): Promise<SessionLifecycleRecord | undefined> {
    const [config, state] = await Promise.all([this.storage.readConfig(id), this.storage.readState(id)]);
    if (config === undefined && state === undefined) return undefined;
    if (config === undefined) throw new UnusableSessionRecordError(id, 'its configuration document is missing');
    // `write` persists the configuration first, so a config with no state is a create that tore
    // between the two writes: nothing was ever launched, and the session is recoverable as
    // `created` rather than throwing on every later read — which would leave its pane unstoppable.
    const parsed = SessionLifecycleRecordSchema.safeParse({
      config: lifecycleConfigDocument(config),
      state: state ?? { id, status: 'created' },
    });
    if (!parsed.success)
      throw new UnusableSessionRecordError(
        id,
        parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      );
    return parsed.data;
  }

  /**
   * Configuration, then state, then the journal. The order is the recovery contract: a tear can
   * only ever lose the *later* write, so it leaves the session one transition behind — never a
   * state whose configuration is missing, and never an event claiming a state that is not durable.
   *
   * Both documents are MERGED over what is already on disk rather than replacing it, because this
   * record is only ever half of them: the protocol half was decided at the start and is not
   * reconstructible from a transition.
   */
  async write(record: SessionLifecycleRecord, event: SessionLifecycleEvent): Promise<void> {
    const id = parseSessionId(record.config.id);
    const [config, state] = await Promise.all([this.storage.readConfig(id), this.storage.readState(id)]);
    await this.storage.writeConfig(id, this.configDocument(record, fields(config)));
    await this.storage.writeState(id, this.stateDocument(record, fields(state)));
    await this.storage.append(id, event.type, event.data);
  }

  /**
   * The configuration document: the envelope beneath, whatever is already stored over it, and this
   * record's own fields last.
   *
   * `agent` is written as the wrapper NAME, never the absolute executable, so the fleet manifest,
   * `fy ps` and the analytics index all join on the same value the account is published under. The
   * stored name wins over the envelope's because a session may have been migrated to another
   * account since it was created, and falls back to the executable's basename — which the wrapper
   * authorization has already proved is a wrapper name — so a document written without an envelope
   * still round-trips unchanged.
   */
  private configDocument(
    record: SessionLifecycleRecord,
    stored: Readonly<Record<string, unknown>> | undefined,
  ): unknown {
    const name = stored?.agent ?? this.envelope?.agent ?? basename(record.config.agent);
    return { ...this.envelope, ...stored, ...record.config, agent: name };
  }

  /**
   * The state document, which the protocol reads for a turn count the lifecycle does not track.
   *
   * A stored turn is preserved; a session this daemon is creating starts at the envelope's own
   * count. Neither exists only for a record persisted with no protocol envelope at all, and there
   * the turn is left out rather than invented as a zero the wire would report as a fact.
   */
  private stateDocument(
    record: SessionLifecycleRecord,
    stored: Readonly<Record<string, unknown>> | undefined,
  ): unknown {
    const turn = storedTurn(stored) ?? this.envelope?.turn;
    return { ...stored, ...record.state, ...(turn === undefined ? {} : { turn }) };
  }
}
