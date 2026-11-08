import type { StatePort } from '@ferretry/kernel/contract';
import { NameClaimSchema, NamesFile } from '../../../contract/state.ts';
import type { SerialExecutor } from '../../lib/ports.ts';
import type { NameClaim, NameClaimAttempt, NameClaimStore } from '../../lib/names/index.ts';

/**
 * The callsign reservation ledger over `names.json` (`NamesFile`), today's `FileNameClaimStore`.
 *
 * WHY A LEDGER AT ALL, when the registry already knows who runs. A start has to claim the name BEFORE its record
 * exists, or two concurrent starts both see the name free and both take it. The ledger closes that window.
 *
 * WHAT MAKES `tryClaim` ATOMIC: every claim goes through ONE serial executor keyed on the ledger, so a
 * read-modify-write cannot interleave with another inside this process; only one daemon holds the state home.
 *
 * `listClaims` answers with the ledger UNION the live fleet: the ledger alone forgets every ferret started before it
 * existed, the fleet alone forgets the reservation a start is holding right now.
 */

/** Where the ledger lives: a missing ledger is empty, a damaged one throws (fail closed). */
export interface ClaimLedger {
  read(): Promise<readonly NameClaim[]>;
  write(claims: readonly NameClaim[]): Promise<void>;
}

/** The ledger key the executor serializes on. */
const LEDGER_KEY = 'names.json';

/** The callsigns the live fleet is using, as the registry derives them. */
export type HeldCallsigns = () => Promise<readonly NameClaim[]> | readonly NameClaim[];

export class LedgerNameClaimStore implements NameClaimStore {
  constructor(
    private readonly ledger: ClaimLedger,
    private readonly executor: SerialExecutor,
    private readonly held: HeldCallsigns,
  ) {}

  async listClaims(): Promise<readonly NameClaim[]> {
    const [reserved, live] = await Promise.all([this.ledger.read(), this.held()]);
    return [...reserved, ...live];
  }

  async tryClaim(claim: NameClaim): Promise<NameClaimAttempt> {
    // A claim the schema rejects would poison the file for the next read, so the decoder that guards reads guards this.
    const incoming = NameClaimSchema.safeParse(claim);
    if (!incoming.success) throw new Error(`invalid callsign claim: ${incoming.error.message}`);
    return await this.executor.run(LEDGER_KEY, async () => {
      const existing = await this.listClaims();
      // Only an UNEXPIRED claim conflicts, and an owner re-claiming its own name does not.
      const conflict = existing.find(
        row => row.callsign === claim.callsign && row.ownerId !== claim.ownerId && row.expiresAtMs > claim.claimedAtMs,
      );
      if (conflict !== undefined) return { claimed: false, conflict };
      const ledger = await this.ledger.read();
      // The expired rows go, and so does this owner's previous reservation: one owner holds one name.
      const kept = ledger.filter(row => row.expiresAtMs > claim.claimedAtMs && row.ownerId !== claim.ownerId);
      await this.ledger.write([...kept, claim]);
      return { claimed: true, claim };
    });
  }

  async release(callsign: string, ownerId: string): Promise<void> {
    await this.executor.run(LEDGER_KEY, async () => {
      const ledger = await this.ledger.read();
      const kept = ledger.filter(row => !(row.callsign === callsign && row.ownerId === ownerId));
      if (kept.length !== ledger.length) await this.ledger.write(kept);
    });
  }
}

/** The ledger on a state port: `names.json`. Damaged durable evidence is not an empty ledger. */
export function stateClaimLedger(state: Pick<StatePort, 'read' | 'write'>): ClaimLedger {
  return {
    read: async () => {
      const read = await state.read(NamesFile);
      if (!read.ok) throw new Error(`invalid callsign claim ledger: ${read.error.sentence}`);
      return read.value === undefined ? [] : read.value.claims;
    },
    write: async claims => await state.write(NamesFile, { claims: [...claims] }),
  };
}
