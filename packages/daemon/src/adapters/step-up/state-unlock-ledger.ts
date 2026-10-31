import { join } from 'node:path';
import { InstantSchema, PairedDeviceIdSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { FileSystemPort, FoundationPaths, UnlockLedgerPort } from '../../lib/index.ts';

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

const UNLOCK_LEDGER_MODE = 0o600;

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
  private readonly path: string;
  private readonly schema: ReturnType<typeof documentSchema>;

  constructor(
    paths: FoundationPaths,
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'setMode'>,
    private readonly daemonId: string,
    placement: UnlockLedgerPlacement = { path: join(paths.state, 'unlocks.json'), owner: PairedDeviceIdSchema },
  ) {
    this.path = placement.path;
    this.schema = documentSchema(placement.owner);
  }

  async read(): Promise<ReadonlyMap<string, number>> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return new Map();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UnlockLedgerDamaged('the unlock ledger is not valid JSON');
    }
    const document = this.schema.safeParse(parsed);
    if (!document.success) throw new UnlockLedgerDamaged('the unlock ledger does not describe unlocks');
    if (document.data.daemonId !== this.daemonId) return new Map();
    return new Map(document.data.unlocks.map(entry => [entry.deviceId, Date.parse(entry.unlockedAt)]));
  }

  async write(unlocks: ReadonlyMap<string, number>): Promise<void> {
    const document = {
      schemaVersion: 1,
      daemonId: this.daemonId,
      unlocks: [...unlocks].map(([deviceId, at]) => ({ deviceId, unlockedAt: new Date(at).toISOString() })),
    };
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(this.schema.parse(document))}\n`);
    await this.files.setMode(this.path, UNLOCK_LEDGER_MODE);
  }
}
