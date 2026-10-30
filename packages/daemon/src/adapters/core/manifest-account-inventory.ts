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
 *
 * READ ONCE PER FILE, NOT ONCE PER ASK. Every start, every session view's context window, every Pack fact and
 * every Codex runtime lookup asks for the accounts, so a busy daemon asked dozens of times a second — each a
 * contained read and a schema parse of the same unchanged file. The accounts are kept with the identity of
 * the file they were read from, and an ask whose single `stat` finds that same file answers them; the
 * provisioner publishes by rename, so a new manifest is a new identity. A damaged file is never kept: it
 * refuses on every ask until it is fixed. A filesystem without identities is read in full every time.
 */
export class ManifestAccountInventory implements AccountInventoryPort {
  #kept: { readonly identity: string; readonly accounts: readonly CoreAccount[] } | undefined;

  constructor(
    private readonly files: FileSystemPort,
    private readonly manifestPath: string,
  ) {}

  async accounts(): Promise<readonly CoreAccount[]> {
    const { identity, readTextIdentified } = this.files;
    if (identity === undefined || readTextIdentified === undefined)
      return this.#parsed(await this.files.readText(this.manifestPath));
    const now = await identity.call(this.files, this.manifestPath);
    if (now !== undefined && this.#kept?.identity === now) return this.#kept.accounts;
    this.#kept = undefined;
    const read = now === undefined ? undefined : await readTextIdentified.call(this.files, this.manifestPath);
    const accounts = this.#parsed(read?.text);
    if (read !== undefined) this.#kept = { identity: read.identity, accounts };
    return accounts;
  }

  #parsed(text: string | undefined): readonly CoreAccount[] {
    // `undefined` is the ONE benign case: this port answers it only for a file that is not there.
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
