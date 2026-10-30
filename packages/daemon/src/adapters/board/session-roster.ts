import { InstantSchema, SessionStatusSchema, SessionTurnStateSchema, TaskRefSchema } from '@ferretry/protocol';
import type { SessionLiveness, SessionLivenessSource, SessionRoster } from '../../lib/board/index.ts';
import { jsonObject } from '../../lib/json.ts';
import type { IndexedSession } from '../../lib/storage-types.ts';
import { withLivenessLedger } from '../../lib/warden/liveness.ts';
import type { WardenLivenessLedger, WardenSessionState } from '../../lib/warden/types.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';
import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../warden/concurrent.ts';

type SessionDocuments = Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'readState'>;

/** What the Warden's liveness monitor saw of one session this daemon life; `undefined` when nothing. */
export type LivenessLedgerReader = (sessionId: string) => WardenLivenessLedger | undefined;

const instant = (value: unknown): string | undefined => InstantSchema.safeParse(value).data;

/**
 * Every session this daemon holds, as the board reads it — ONE pass over the session index per board
 * read, never one per card. Each session's configuration (for `focusTask`) and state (status, turn and
 * life-signs) are read through the storage's document cache, a bounded number at a time, and the
 * Warden's liveness ledger is laid over the state exactly as the Warden's own sweep lays it
 * (`withLivenessLedger`), so the board and the Warden judge the same evidence.
 *
 * A session whose documents cannot be read is held but left out of `sessions`: the board calls it
 * neither alive nor dead.
 */
export class StorageSessionRoster implements SessionLivenessSource {
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

  private async read(session: IndexedSession): Promise<SessionLiveness | undefined> {
    const [config, state] = await Promise.all([
      this.storage.readConfig(session.id, 'heard'),
      this.storage.readState(session.id),
    ]);
    const document = jsonObject(state);
    const status = SessionStatusSchema.safeParse(document?.status);
    if (document === undefined || !status.success) return undefined;
    const observed = withLivenessLedger(
      {
        status: status.data,
        lastActivityAt: instant(document.lastActivityAt),
        lastTranscriptAt: instant(document.lastTranscriptAt),
        lastTokenAdvanceAt: instant(document.lastTokenAdvanceAt),
        lastSubprocessAt: instant(document.lastSubprocessAt),
        subprocessSince: instant(document.subprocessSince),
      },
      this.ledger(session.id),
    );
    const turnState = SessionTurnStateSchema.safeParse(document.turnState);
    const focus = TaskRefSchema.safeParse(jsonObject(config)?.focusTask);
    return {
      id: session.id,
      status: status.data,
      ...(turnState.success ? { turnState: turnState.data } : {}),
      focusTask: focus.success ? focus.data : null,
      declaredWait: document.waiting !== undefined && document.waiting !== null,
      ...pick(observed),
    };
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
