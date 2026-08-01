import { z } from 'zod';
import type { FileSystemPort, SerialExecutor } from '../../lib/index.ts';
import {
  type NameClaim,
  type NameClaimAttempt,
  type NameClaimStore,
  normalizeCallsign,
} from '../../lib/names/index.ts';

/**
 * The callsign reservation ledger, in one file inside the state home.
 *
 * WHY A LEDGER AT ALL, when the pool already knows what is taken. `GET /v1/names` derives held
 * callsigns from the `teammate` recorded in each live session's own configuration, which is the
 * durable truth — but it is only true AFTER the session document exists. A start has to claim the
 * name BEFORE it writes one, or two concurrent starts both see the name free, both take it, and a
 * bare callsign then resolves to two sessions. The ledger is what closes that window.
 *
 * WHAT MAKES `tryClaim` ATOMIC, which the port demands. Two things, and neither is a lock file.
 * Every claim goes through ONE serial executor keyed on the ledger, so a read-modify-write cannot
 * interleave with another inside this process; and only one daemon can hold the state home at all,
 * because opening it takes the lifetime lock. A second daemon on the same home does not race this
 * file — it never gets as far as serving a request.
 *
 * WHAT `listClaims` ANSWERS WITH is the ledger UNION the live fleet, because either alone would be
 * wrong: the ledger alone forgets every session started before it existed, and the fleet alone forgets
 * the reservation a start is holding right now. A callsign is free only when nobody in either holds it.
 */

const NameClaimSchema = z
  .object({
    callsign: z.string().refine(callsign => normalizeCallsign(callsign) === callsign, 'callsign is not canonical'),
    ownerId: z.string().min(1),
    claimedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .refine(claim => claim.expiresAtMs > claim.claimedAtMs, 'claim expiry must be after its creation');

const LedgerSchema = z.array(NameClaimSchema);

/** The callsigns the live fleet is using, as the pool route derives them. */
export type HeldCallsigns = () => Promise<readonly NameClaim[]>;

export class FileNameClaimStore implements NameClaimStore {
  constructor(
    private readonly file: string,
    private readonly files: FileSystemPort,
    private readonly executor: SerialExecutor,
    private readonly held: HeldCallsigns,
  ) {}

  async listClaims(): Promise<readonly NameClaim[]> {
    const [reserved, live] = await Promise.all([this.ledger(), this.held()]);
    return [...reserved, ...live];
  }

  async tryClaim(claim: NameClaim): Promise<NameClaimAttempt> {
    return await this.executor.run(this.file, async () => {
      const existing = await this.listClaims();
      // Only an UNEXPIRED claim conflicts, and an owner re-claiming its own name does not: a retried
      // start of the same session must be able to take the callsign it already holds.
      const conflict = existing.find(
        row => row.callsign === claim.callsign && row.ownerId !== claim.ownerId && row.expiresAtMs > claim.claimedAtMs,
      );
      if (conflict !== undefined) return { claimed: false, conflict };
      const ledger = await this.ledger();
      const kept = ledger.filter(
        // The expired rows go, and so does this owner's previous reservation: one owner holds one name.
        row => row.expiresAtMs > claim.claimedAtMs && row.ownerId !== claim.ownerId,
      );
      await this.write([...kept, claim]);
      return { claimed: true, claim };
    });
  }

  async release(callsign: string, ownerId: string): Promise<void> {
    await this.executor.run(this.file, async () => {
      const ledger = await this.ledger();
      const kept = ledger.filter(row => !(row.callsign === callsign && row.ownerId === ownerId));
      if (kept.length !== ledger.length) await this.write(kept);
    });
  }

  /**
   * The reservations on disk. A missing ledger is an empty ledger; damaged durable evidence is not.
   *
   * Live session documents can reconstruct claims only AFTER a start has written its session. Before
   * then, this ledger is the sole proof that the start owns its callsign. Treating malformed JSON or
   * one malformed row as empty would reopen that exact collision window, so decoding fails closed and
   * leaves the file untouched for diagnosis.
   */
  private async ledger(): Promise<readonly NameClaim[]> {
    const text = await this.files.readText(this.file);
    if (text === undefined) return [];
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid callsign claim ledger ${this.file}: malformed JSON`, { cause: error });
    }
    const rows = LedgerSchema.safeParse(decoded);
    if (!rows.success) throw new Error(`invalid callsign claim ledger ${this.file}: ${rows.error.message}`);
    return rows.data;
  }

  private async write(claims: readonly NameClaim[]): Promise<void> {
    await this.files.writeTextAtomic(this.file, JSON.stringify(claims));
  }
}
