import { type IFyApiClient, PairedDevicesViewSchema, SecretListSchema } from '@ferretry/protocol';
import type { IResetInventoryPort } from '../../lib/daemon/ports.ts';

/**
 * The one client capability this needs, and it must be the AUTHENTICATED one.
 *
 * Not the unauthenticated health probe the rest of this group shares: both routes below sit behind the
 * host's admin credential, and a probe token would be refused on each of them.
 */
export type ResetInventoryApiClient = Pick<IFyApiClient, 'request'>;

/** The secret surface, spelled where the secret gateway spells it. */
const SECRETS_PATH = '/v1/secrets';

/** The paired-device registry, read only to be counted. */
const DEVICES_PATH = '/v1/pair/devices';

/**
 * Counts what a reset destroys unrecoverably, by asking the daemon that still holds it.
 *
 * THE DAEMON IS THE AUTHORITY, not the disk. The count could be taken by listing files under the state
 * home, and that is exactly the read the package split forbids — the CLI does not open the daemon's
 * state, and a verb that removes it does not get to be the one exception. It also would not be right:
 * the secret store and the device registry are shapes the daemon owns, and a file count is a guess at
 * them that goes stale on the next release.
 *
 * NOTHING HERE FAILS A RESET. A daemon that will not answer is a daemon somebody is very likely
 * resetting BECAUSE it will not answer, so every failure is `undefined` and the preflight says the
 * counts are unavailable while still printing paths and sizes it measured for itself. Turning that into
 * an error would make the recovery path depend on the thing being recovered from.
 *
 * Both routes need the host's admin credential. On loopback that is ungoverned — somebody at the
 * machine already has the machine — so no grant and no operator password stands between this and its
 * answer, which is required: the password being forgotten is one of the reasons to reset.
 */
export class ProtocolResetInventory implements IResetInventoryPort {
  constructor(private readonly client: ResetInventoryApiClient) {}

  async count(): Promise<{ readonly secrets: number; readonly devices: number } | undefined> {
    try {
      const secrets = await this.client.request(SECRETS_PATH, SecretListSchema);
      const devices = await this.client.request(DEVICES_PATH, PairedDevicesViewSchema);
      return { secrets: secrets.secrets.length, devices: devices.devices.length };
    } catch {
      return undefined;
    }
  }
}
