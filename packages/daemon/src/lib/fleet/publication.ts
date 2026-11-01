/**
 * The published fleet, never observed half-published.
 *
 * ## Why this exists
 *
 * An apply publishes the manifest, the wrappers and the ids by moving each live file ASIDE and then
 * linking its replacement into the free name (`@ferretry/fleet`'s `FileFleetProvisioner`, which
 * refuses to overwrite). Between those two steps — several awaits apart — the name is simply not
 * there. The manifest adapter answers an absent manifest with an empty fleet, because on a host that
 * was never provisioned that is the truth. Mid-apply it is a lie, and it was a dangerous one: a
 * session start that landed while the boot's catalog republish was applying resolved its account,
 * then asked for the account's launch environment, found no account, and launched with no
 * environment at all — skipping the missing-credential refusal (`MissingFleetSecretsError`) that is
 * the whole point of a profile-bound credential.
 *
 * ## What it guarantees
 *
 * Every apply this daemon makes runs EXCLUSIVELY, and every read of the published fleet waits for an
 * apply in flight to finish rather than reading the gap. So a read sees the fleet as it was before
 * an apply or as it is after one, never the moment between. An apply that is waiting holds back new
 * reads (otherwise a busy daemon, which reads the inventory many times a second, could starve it),
 * and waits for the reads already in progress.
 *
 * ## Why in memory and not a file
 *
 * The daemon is the only thing that applies a fleet — the command-line tool asks the daemon — and
 * every apply it makes goes through the one provisioner the catalogue and the setup share, which runs
 * its mutation inside {@link FleetPublication.publishing} once it holds its claim beside the manifest.
 * The claim still keeps two applies apart; this only keeps readers out of the window, and never for
 * the time an apply spends waiting for a claim somebody else holds.
 *
 * ## What it does not cover
 *
 * Each read is consistent; two reads are not pinned to one publish. A start judges its credential
 * against a committed manifest and the pane runs that publish's wrapper — unless ANOTHER apply lands
 * between the judgment and the pane's exec, in which case the new wrapper carries its own guard for
 * every secret-backed variable (`@ferretry/fleet` wrappers) and refuses to run without it. Fail
 * closed either way; never a launch with a credential silently missing.
 *
 * NEVER NEST: a read or an apply must not run another inside itself. Both sections wrap only leaf
 * file work, so a reader holding the gate while an apply waits behind it can never need the gate
 * again.
 */

import type { RuntimeIds } from '@ferretry/fleet';
import type { AccountInventoryPort, CoreAccount } from '../core/inventory.ts';
import type { RuntimeNamesPort } from './start-resolution.ts';

/** Applies exclusively, reads between applies. */
export class FleetPublication {
  /** Applies queued or running. While any is, no new read is admitted. */
  #applies = 0;
  /** Reads admitted and not yet finished. An apply starts only once this is zero. */
  #reads = 0;
  /** Resolves once {@link #applies} returns to zero; replaced each time it leaves zero. */
  #settled: Promise<void> = Promise.resolve();
  #settle: (() => void) | undefined;
  /** Applies waiting for the admitted reads to drain. */
  #drainWaiters: Array<() => void> = [];

  /** Run one read of the published fleet, after any apply in flight has finished. */
  async reading<T>(read: () => Promise<T>): Promise<T> {
    // Looped: an apply queued while this one waited must be waited for too. The check and the count
    // below are one synchronous step, so no apply can start between them.
    while (this.#applies > 0) await this.#settled;
    this.#reads += 1;
    try {
      return await read();
    } finally {
      this.#reads -= 1;
      if (this.#reads === 0) for (const wake of this.#drainWaiters.splice(0)) wake();
    }
  }

  /** Run one apply with no read in progress and none admitted until it is done. */
  async publishing<T>(apply: () => Promise<T>): Promise<T> {
    if (this.#applies === 0) this.#settled = new Promise<void>(resolve => (this.#settle = resolve));
    this.#applies += 1;
    try {
      while (this.#reads > 0) await new Promise<void>(resolve => this.#drainWaiters.push(resolve));
      return await apply();
    } finally {
      this.#applies -= 1;
      if (this.#applies === 0) this.#settle?.();
    }
  }
}

/**
 * The daemon's ONE account inventory, read only between applies.
 *
 * Both halves are gated: the runtime names (`ids.json`) are published by the same apply as the
 * manifest and are moved aside the same way.
 */
export class PublishedFleetInventory implements AccountInventoryPort, RuntimeNamesPort {
  constructor(
    private readonly inner: AccountInventoryPort & RuntimeNamesPort,
    private readonly publication: FleetPublication,
  ) {}

  async accounts(): Promise<readonly CoreAccount[]> {
    return await this.publication.reading(async () => await this.inner.accounts());
  }

  async ids(): Promise<RuntimeIds | undefined> {
    return await this.publication.reading(async () => await this.inner.ids());
  }
}
