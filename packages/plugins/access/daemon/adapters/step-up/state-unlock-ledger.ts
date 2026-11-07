import type { StatePort } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';
import { UnlocksFile, UnlocksFileSchema } from '../../../contract/index.ts';
import type { UnlockLedgerPort } from '../../lib/step-up/index.ts';

/**
 * EACH DEVICE'S LAST UNLOCK, in one document inside Access's state (`unlocks.json`), so a restart — an update —
 * does not ask every device for its passkey again inside its unlock period.
 *
 * A device id and an instant, nothing else: no key, no token, no signature. It is BOUND TO THIS DAEMON —
 * the document names the daemon identity that wrote it, and a document written by another (a state home
 * copied between machines, a reset identity) is read as holding nothing. Written owner-only, atomically,
 * through one serialized writer. A document that does not parse is damage, and the caller asks every
 * device to unlock again rather than guessing.
 */
class UnlockLedgerDamaged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlockLedgerDamaged';
  }
}

export class StateUnlockLedger implements UnlockLedgerPort {
  constructor(
    private readonly state: StatePort,
    private readonly daemonId: string,
  ) {}

  async read(): Promise<ReadonlyMap<string, number>> {
    const document = await this.state.read(UnlocksFile);
    if (!document.ok) throw new UnlockLedgerDamaged('the unlock ledger does not describe unlocks');
    if (document.value === undefined || document.value.daemonId !== this.daemonId) return new Map();
    return new Map(document.value.unlocks.map(entry => [entry.deviceId, Date.parse(entry.unlockedAt)]));
  }

  async write(unlocks: ReadonlyMap<string, number>): Promise<void> {
    const document = UnlocksFileSchema.parse({
      format: 1,
      daemonId: this.daemonId,
      unlocks: [...unlocks].map(([deviceId, at]) => ({ deviceId, unlockedAt: instantFromEpochMs(at) })),
    });
    await this.state.write(UnlocksFile, document);
  }
}
