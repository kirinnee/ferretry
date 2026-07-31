import { PIN_SCHEMA_VERSION, type Pin, type PinSnapshot } from '@ferretry/protocol';
import {
  AttentionService,
  type AttentionLedger,
  type AttentionLedgerRepository,
  type AttentionMutation,
} from '../../../../src/lib/attention/index.ts';
import { PinService, type PinRepository, type PinSessionDirectory } from '../../../../src/lib/pins/index.ts';
import type { UsageFeedPort } from '../../../../src/lib/usage/index.ts';

/** Shared fakes for the mounted-surface tests: real domain services over storage the test owns. */

export const AT = '2024-05-01T10:00:00.000Z';
export const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] as const;
export const CREDENTIALS = { admin: 'admin-secret', warden: 'warden-secret' } as const;

/** The human's CLI. */
export const human = { authorization: `Bearer ${CREDENTIALS.admin}`, 'x-ferretry-client': 'cli' } as const;
/** An agent calling from inside its own pane. */
export const agentIn = (sessionId: string) => ({ ...human, 'x-ferretry-session-id': sessionId });

/** A pin repository under the test's control: the domain rules are real, the storage is not. */
class FakePinRepository implements PinRepository {
  constructor(private pins: readonly Pin[] = []) {}

  async snapshot(sessionId: string): Promise<PinSnapshot> {
    return this.document(sessionId, this.pins);
  }

  async mutate(sessionId: string, transform: (current: readonly Pin[]) => readonly Pin[]): Promise<PinSnapshot> {
    this.pins = transform(this.pins);
    return this.document(sessionId, this.pins);
  }

  private document(sessionId: string, pins: readonly Pin[]): PinSnapshot {
    return { v: PIN_SCHEMA_VERSION, sessionId, pins: [...pins], updatedAt: AT };
  }
}

class FakePinSessions implements PinSessionDirectory {
  constructor(private readonly known: readonly string[]) {}

  async has(sessionId: string): Promise<boolean> {
    return this.known.includes(sessionId);
  }
}

/** A pin service whose ids and instant are fixed, so a response body can be asserted exactly. */
export function pinService(known: readonly string[], instant: string = AT): PinService {
  let minted = -1;
  return new PinService(
    new FakePinSessions(known),
    new FakePinRepository(),
    { now: () => instant },
    {
      next: () => {
        minted += 1;
        return IDS[minted] ?? `unexpected-${minted}`;
      },
    },
  );
}

/** An in-memory attention ledger: the state machine is real, the JSONL file is not. */
class FakeLedgerRepository implements AttentionLedgerRepository {
  constructor(private ledger: AttentionLedger | null = null) {}

  async read(): Promise<AttentionLedger | null> {
    return this.ledger;
  }

  async transact(
    _sessionId: string,
    apply: (current: AttentionLedger | null) => AttentionMutation,
  ): Promise<AttentionMutation> {
    const mutation = apply(this.ledger);
    if (mutation.ok) this.ledger = mutation.ledger;
    return mutation;
  }
}

/** An attention service over an in-memory ledger, with a fixed instant. */
export function attentionService(repository: AttentionLedgerRepository = new FakeLedgerRepository()): AttentionService {
  return new AttentionService(repository, { now: () => AT });
}

/** A feed that never collected: enough to build the base surface without a transport. */
export const emptyFeed: UsageFeedPort = {
  accounts: async () => [],
  snapshotAt: () => undefined,
  hasSnapshot: () => false,
};
