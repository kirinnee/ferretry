import {
  parseAccountManifest,
  type AccountInventoryPort,
  type CoreAccount,
  type FileSystemPort,
} from '../../lib/index.ts';

/**
 * The account inventory, read from the fleet manifest the provisioner publishes into the state home.
 *
 * An absent or unreadable manifest yields an empty fleet rather than an error: the daemon runs
 * before the fleet is ever provisioned, and "no accounts yet" is a state the recommender already
 * reports honestly ("no usable account could fill the … role").
 */
export class ManifestAccountInventory implements AccountInventoryPort {
  constructor(
    private readonly files: FileSystemPort,
    private readonly manifestPath: string,
  ) {}

  async accounts(): Promise<readonly CoreAccount[]> {
    const text = await this.files.readText(this.manifestPath);
    if (text === undefined) return [];
    try {
      return parseAccountManifest(JSON.parse(text));
    } catch {
      return [];
    }
  }
}
