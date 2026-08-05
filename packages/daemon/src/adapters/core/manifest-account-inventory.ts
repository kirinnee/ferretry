import {
  FleetManifestUnreadableError,
  parseAccountManifest,
  type AccountInventoryPort,
  type CoreAccount,
  type FileSystemPort,
} from '../../lib/index.ts';

/**
 * The account inventory, read from the fleet manifest the provisioner publishes into the state home.
 *
 * ABSENT AND DAMAGED ARE DIFFERENT ANSWERS, and this adapter is where the difference is kept.
 *
 * An absent manifest yields an empty fleet: the daemon runs before the fleet is ever provisioned,
 * and "no accounts yet" is a state the recommender already reports honestly ("no usable account
 * could fill the … role"). A manifest that is PRESENT and cannot be parsed yields
 * {@link FleetManifestUnreadableError} instead, naming the file and the failure.
 *
 * This adapter used to answer both with `[]`. That is how a daemon whose reader disagreed with the
 * provisioner's writer came to report "the fleet manifest publishes no account for either" about a
 * file listing a provisioned, available account — a message that was confidently wrong rather than
 * merely unhelpful, and that hid the disagreement for an entire release.
 */
export class ManifestAccountInventory implements AccountInventoryPort {
  constructor(
    private readonly files: FileSystemPort,
    private readonly manifestPath: string,
  ) {}

  async accounts(): Promise<readonly CoreAccount[]> {
    // `undefined` is the ONE benign case: this port answers it only for a file that is not there.
    const text = await this.files.readText(this.manifestPath);
    if (text === undefined) return [];
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new FleetManifestUnreadableError(this.manifestPath, `it is not valid JSON (${(error as Error).message})`);
    }
    return parseAccountManifest(payload, this.manifestPath);
  }
}
