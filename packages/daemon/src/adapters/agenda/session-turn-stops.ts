import type { SessionStops, TurnChanges } from '../../lib/agenda/index.ts';
import { jsonObject } from '../../lib/json.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

/** The turn states a ferret is IDLE in: it handed control back, or is parked on a prompt only the owner can answer. */
const IDLE = new Set(['your-turn', 'needs-input']);

/** The session's turn, from its state document: one signature that changes whenever the turn does. */
function turnOf(state: unknown): { readonly signature: string; readonly stop: string | undefined } {
  const document = jsonObject(state as never);
  const turn = typeof document?.turnState === 'string' ? document.turnState : undefined;
  const at = typeof document?.turnStateAt === 'string' ? document.turnStateAt : undefined;
  return {
    signature: `${turn ?? 'none'}@${at ?? ''}`,
    stop: turn !== undefined && IDLE.has(turn) ? (at ?? turn) : undefined,
  };
}

/** Whether a session is idle, read from its state document; absent when it works or its state cannot be read. */
export class StorageSessionStops implements SessionStops {
  constructor(private readonly storage: Pick<DaemonStorage, 'readState'>) {}

  async current(sessionId: string): Promise<string | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return undefined;
    return turnOf(await this.storage.readState(id).catch(() => undefined)).stop;
  }
}

/**
 * Calls `onMoved` whenever a session's turn moves — it goes idle, or goes back to work — and never for any other
 * write to its state document. The fleet's turns as they stand are learned first, without calling them changes:
 * a daemon that starts must not announce every ferret that was already idle. Returns the unsubscribe.
 */
export function armSessionTurnChanges(
  storage: Pick<DaemonStorage, 'listSessions' | 'readState' | 'subscribeStates'>,
  changes: TurnChanges,
  onMoved: (sessionId: string) => Promise<void>,
): () => void {
  for (const session of storage.listSessions()) {
    void storage
      .readState(session.id)
      .then(state => changes.prime(session.id, turnOf(state).signature))
      .catch(() => undefined);
  }
  return storage.subscribeStates((id, state) => {
    if (changes.moved(id, turnOf(state).signature)) void onMoved(id).catch(() => undefined);
  });
}
