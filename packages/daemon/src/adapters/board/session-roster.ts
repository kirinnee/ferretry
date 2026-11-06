import { InstantSchema, SessionStatusSchema, SessionTurnStateSchema, TaskRefSchema } from '@ferretry/protocol';
import type {
  SessionLiveness,
  SessionLivenessGuard,
  SessionLivenessSource,
  SessionRoster,
} from '../../lib/board/index.ts';
import { jsonObject } from '../../lib/json.ts';
import type { IndexedSession } from '../../lib/storage-types.ts';
import { withLivenessLedger } from '../../lib/warden/liveness.ts';
import type { WardenLivenessLedger, WardenSessionState } from '../../lib/warden/types.ts';
import type { DaemonStorage, DocumentFreshness } from '../storage/session-storage.ts';
import { parseSessionId } from '../../lib/session-id.ts';
import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../warden/concurrent.ts';

type SessionDocuments = Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'readState' | 'holdSessions'>;
type SessionDocument = Awaited<ReturnType<SessionDocuments['readState']>>;

/** What the Warden's liveness monitor saw of one session this daemon life; `undefined` when nothing. */
export type LivenessLedgerReader = (sessionId: string) => WardenLivenessLedger | undefined;

const instant = (value: unknown): string | undefined => InstantSchema.safeParse(value).data;

/** What one session's two documents say, before the Warden's ledger is laid over them. */
interface DocumentLiveness {
  /** The configuration document it was read from: a new document is a new value, so it is read again. */
  readonly config: unknown;
  /** Everything but the life-signs, which the ledger may move. */
  readonly fields: Pick<
    SessionLiveness,
    'id' | 'status' | 'turnState' | 'focusTask' | 'declaredWait' | 'lead' | 'interactive'
  >;
  readonly instants: WardenSessionState;
  /** The whole liveness when the ledger has nothing to add. */
  readonly unledgered: SessionLiveness;
}

/**
 * Every session this daemon holds, as the board reads it — ONE pass over the session index per board
 * read, never one per card. Each session's configuration (for `focusTask`) and state (status, turn and
 * life-signs) are read through the storage's document cache, a bounded number at a time, and the
 * Warden's liveness ledger is laid over the state exactly as the Warden's own sweep lays it
 * (`withLivenessLedger`), so the board and the Warden judge the same evidence.
 *
 * Both documents are read `heard`, as the fleet reading reads them: a quiet document under a live watch costs
 * no system call, a write by this daemon is seen by the very next read, and one from outside it once its
 * watch has heard it. What a pair of documents says is kept against the two values the storage handed out —
 * it hands out the same frozen value until the file changes — so an unchanged session is not parsed again.
 * Nothing is kept that the storage's cache does not also hold, so nothing here outlives a restart.
 *
 * A session whose documents cannot be read is held but left out of `sessions`: the board calls it
 * neither alive nor dead.
 */
export class StorageSessionRoster implements SessionLivenessSource, SessionLivenessGuard {
  /** Keyed by the state document's value, which a changed file replaces. */
  private readonly parsed = new WeakMap<object, DocumentLiveness>();

  constructor(
    private readonly storage: SessionDocuments,
    private readonly ledger: LivenessLedgerReader,
  ) {}

  async roster(): Promise<SessionRoster> {
    const indexed = this.storage.listSessions();
    const read = await mapWithConcurrency(
      indexed,
      async session => await this.read(session).catch(() => undefined),
      DEFAULT_READ_CONCURRENCY,
    );
    const sessions = new Map<string, SessionLiveness>();
    for (const session of read) if (session !== undefined) sessions.set(session.id, session);
    return { held: new Set(indexed.map(session => session.id)), sessions };
  }

  /**
   * Holds these sessions' documents still and reads them again from the files, so what `work` is handed is what is
   * on disk at that moment and stays so until it settles. A session the index does not hold is gone. Only the named
   * sessions are read, never the fleet: the hold is for a commit, and the commit must not wait on a whole-fleet read.
   */
  async settled<T>(ids: readonly string[], work: (fresh: SessionRoster) => Promise<T>): Promise<T> {
    return await this.storage.holdSessions(ids.map(parseSessionId), async () => {
      const held = this.storage.listSessions().filter(session => ids.includes(session.id));
      const read = await Promise.all(
        held.map(async session => await this.read(session, 'proved').catch(() => undefined)),
      );
      const sessions = new Map<string, SessionLiveness>();
      for (const session of read) if (session !== undefined) sessions.set(session.id, session);
      return await work({ held: new Set(held.map(session => session.id)), sessions });
    });
  }

  private async read(
    session: IndexedSession,
    freshness: DocumentFreshness = 'heard',
  ): Promise<SessionLiveness | undefined> {
    const [config, state] = await Promise.all([
      this.storage.readConfig(session.id, freshness),
      this.storage.readState(session.id, freshness),
    ]);
    const documents = this.documents(session.id, config, state);
    if (documents === undefined) return undefined;
    const ledger = this.ledger(session.id);
    if (ledger === undefined) return documents.unledgered;
    return { ...documents.fields, ...pick(withLivenessLedger(documents.instants, ledger)) };
  }

  /** What the pair says, parsed once per pair of values. */
  private documents(id: string, config: SessionDocument, state: SessionDocument): DocumentLiveness | undefined {
    const key = typeof state === 'object' && state !== null ? state : undefined;
    const known = key === undefined ? undefined : this.parsed.get(key);
    if (known !== undefined && known.config === config) return known;
    const document = jsonObject(state);
    const status = SessionStatusSchema.safeParse(document?.status);
    if (document === undefined || !status.success) return undefined;
    const instants: WardenSessionState = {
      status: status.data,
      lastActivityAt: instant(document.lastActivityAt),
      lastTranscriptAt: instant(document.lastTranscriptAt),
      lastTokenAdvanceAt: instant(document.lastTokenAdvanceAt),
      lastSubprocessAt: instant(document.lastSubprocessAt),
      subprocessSince: instant(document.subprocessSince),
    };
    const turnState = SessionTurnStateSchema.safeParse(document.turnState);
    const settings = jsonObject(config);
    const focus = TaskRefSchema.safeParse(settings?.focusTask);
    const lead = typeof settings?.parent === 'string' && settings.parent !== '' ? settings.parent : undefined;
    const fields = {
      id,
      ...(lead === undefined ? {} : { lead }),
      ...(settings === undefined ? {} : { configRead: true as const }),
      ...(settings?.mode === 'interactive' ? { interactive: true } : {}),
      status: status.data,
      ...(turnState.success ? { turnState: turnState.data } : {}),
      focusTask: focus.success ? focus.data : null,
      declaredWait: document.waiting !== undefined && document.waiting !== null,
    };
    const parsed: DocumentLiveness = { config, fields, instants, unledgered: { ...fields, ...pick(instants) } };
    if (key !== undefined) this.parsed.set(key, parsed);
    return parsed;
  }
}

/** The strong life-signs of a merged state; a missing one stays missing. */
const pick = (state: WardenSessionState): Partial<SessionLiveness> => ({
  ...(state.lastActivityAt === undefined ? {} : { lastActivityAt: state.lastActivityAt }),
  ...(state.lastTranscriptAt === undefined ? {} : { lastTranscriptAt: state.lastTranscriptAt }),
  ...(state.lastTokenAdvanceAt === undefined ? {} : { lastTokenAdvanceAt: state.lastTokenAdvanceAt }),
  ...(state.lastSubprocessAt === undefined ? {} : { lastSubprocessAt: state.lastSubprocessAt }),
  ...(state.subprocessSince === undefined ? {} : { subprocessSince: state.subprocessSince }),
});
