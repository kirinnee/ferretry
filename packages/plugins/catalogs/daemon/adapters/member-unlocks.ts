import { InstantSchema, CatalogMemberKeyIdSchema } from '../lib/boundary.ts';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { UnlockLedgerPort } from '../lib/member-passkeys/types.ts';

/**
 * EACH DEVICE'S LAST UNLOCK, in one document inside the state home, so a restart — an update — does not
 * ask every device for its passkey again inside its unlock period.
 *
 * A device id and an instant, nothing else: no key, no token, no signature. It is BOUND TO THIS DAEMON —
 * the document names the daemon identity that wrote it, and a document written by another (a state home
 * copied between machines, a reset identity) is read as holding nothing. Written owner-only, atomically,
 * through one serialized writer. A document that does not parse is damage, and the caller asks every
 * device to unlock again rather than guessing.
 */

const documentSchema = (owner: z.ZodType<string>) =>
  z.strictObject({
    schemaVersion: z.literal(1),
    daemonId: z.string().min(1).max(200),
    unlocks: z.array(z.strictObject({ deviceId: owner, unlockedAt: InstantSchema })).max(10_000),
  });

/** Where a ledger lives and whose unlocks it keeps. The default is the paired devices'. */
export interface UnlockLedgerPlacement {
  readonly path: string;
  readonly owner: z.ZodType<string>;
}

/** The unlock ledger could not be read as unlocks. */
class UnlockLedgerDamaged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlockLedgerDamaged';
  }
}

export class StateUnlockLedger implements UnlockLedgerPort {
  private readonly schema: ReturnType<typeof documentSchema>;

  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef,
    private readonly daemonId: () => string,
  ) {
    this.schema = documentSchema(CatalogMemberKeyIdSchema);
  }

  async read(): Promise<ReadonlyMap<string, number>> {
    const raw = await this.state.read(this.file);
    if (!raw.ok) throw new UnlockLedgerDamaged('the unlock ledger cannot be read');
    if (raw.value === undefined) return new Map();
    const parsed = raw.value;
    const document = this.schema.safeParse(parsed);
    if (!document.success) throw new UnlockLedgerDamaged('the unlock ledger does not describe unlocks');
    if (document.data.daemonId !== this.daemonId()) return new Map();
    return new Map(document.data.unlocks.map(entry => [entry.deviceId, Date.parse(entry.unlockedAt)]));
  }

  async write(unlocks: ReadonlyMap<string, number>): Promise<void> {
    const document = {
      schemaVersion: 1,
      daemonId: this.daemonId(),
      unlocks: [...unlocks].map(([deviceId, at]) => ({ deviceId, unlockedAt: new Date(at).toISOString() })),
    };
    await this.state.write(this.file, this.schema.parse(document));
  }
}
