/**
 * Everything automatic quota failover needs from outside itself.
 *
 * Each port is the NARROWEST view of a collaborator this subsystem actually uses, so a test supplies
 * four small objects rather than a daemon. Two of them are deliberately structural rather than
 * imported wholesale — the roster and the migrator — because the real implementations are the session
 * directory and the migration mount, and depending on those types directly would make this domain
 * hold a reference to the whole session surface to read three fields and call one method.
 */

import type { QuotaFailoverState } from './ledger.ts';
import type { QuotaFailoverSession } from './plan.ts';

/** The operator's configuration document, handed up as raw parsed JSON. The domain decides what a
 *  damaged one means — see `config.ts` — and an adapter that parsed would duplicate that policy. */
export interface QuotaFailoverConfigStore {
  read(): Promise<unknown>;
}

/** The durable ledger. Read raw for the same reason, and written as the typed value the domain owns. */
export interface QuotaFailoverStateStore {
  read(): Promise<unknown>;
  write(state: QuotaFailoverState): Promise<void>;
}

/**
 * The sessions this daemon holds.
 *
 * A roster this daemon could not read must REJECT rather than answer an empty list: an empty fleet
 * and an unreadable one look identical from here, and the second would prune the entire ledger.
 */
export interface QuotaFailoverRoster {
  sessions(): Promise<readonly QuotaFailoverSession[]>;
}

/**
 * Moving one session, through the daemon's own migration — the preflight included.
 *
 * THIS IS THE GATE, AND IT IS NOT OPTIONAL. The method takes an agent and nothing else: there is no
 * force flag to pass, no downgrade acceptance to grant, and no way to express "just get the session
 * moving". A refusal from the preflight arrives here as a rejection and is recorded as one. Anything
 * that let this subsystem past the gate would make the gate decorative for precisely the caller that
 * has no human watching it.
 */
export interface QuotaFailoverMigrator {
  migrate(sessionId: string, agent: string): Promise<void>;
}

/**
 * Where a move — or a refusal to move — is written so a human can find it.
 *
 * Onto the SESSION's own journal, not a private log, because the question a human asks is "why is
 * this session on a different account than I left it on", and the session's own event stream is where
 * they ask it.
 */
export interface QuotaFailoverJournal {
  record(sessionId: string, event: string, data: Record<string, unknown>): Promise<void>;
}

export interface QuotaFailoverClock {
  /** Epoch milliseconds, not the daemon's ISO clock: every rule here is an arithmetic one —
   *  snapshot age, retry cooldown, revisit cooldown — and a domain that parsed a string to subtract
   *  it would be one bad parse away from treating an ambiguous instant as the epoch. */
  nowMs(): number;
}
