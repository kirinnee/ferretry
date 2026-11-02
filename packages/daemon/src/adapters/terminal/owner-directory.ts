import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import { type SessionId, tryParseSessionId } from '../../lib/session-id.ts';
import type { TerminalOwnerDirectory, TerminalOwnerStanding } from '../../lib/terminal/contracts.ts';
import { standingOfSessionStatus } from '../../lib/terminal/holders.ts';

/** The three reads of the session store this directory needs; `DaemonStorage` satisfies it. */
export interface TerminalOwnerStorage {
  findSession(id: SessionId): unknown;
  readConfig(id: SessionId): Promise<unknown>;
  readState(id: SessionId): Promise<unknown>;
}

/**
 * Where a terminal's owner stands, read from the session store.
 *
 * A session the store does not hold is `gone`. One it holds but whose state cannot be read or understood
 * is `live` with an `unknown` status: closing a person's shell on a guess is the one mistake this class
 * must never make, while keeping one a sweep later closes costs a slot for a minute.
 */
export class StorageTerminalOwnerDirectory implements TerminalOwnerDirectory {
  constructor(private readonly storage: TerminalOwnerStorage) {}

  async standing(ownerId: string): Promise<TerminalOwnerStanding> {
    const id = tryParseSessionId(ownerId);
    if (id === undefined || this.storage.findSession(id) === undefined)
      return { ...standingOfSessionStatus(undefined), label: ownerId };
    const config = SessionConfigSchema.safeParse(await this.storage.readConfig(id).catch(() => undefined));
    const label = config.success ? (config.data.teammate ?? config.data.name) : ownerId;
    const state = SessionStateSchema.safeParse(await this.storage.readState(id).catch(() => undefined));
    if (!state.success) return { standing: 'live', status: 'unknown', label };
    return { ...standingOfSessionStatus(state.data.status), label };
  }
}
