import { basename } from 'node:path';
import type { SessionConfig } from '@ferretry/protocol';
import { parseSessionId, type SessionId } from '../../../lib/index.ts';
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
  ) {}

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
