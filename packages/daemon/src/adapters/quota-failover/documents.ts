import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  QuotaFailoverConfigStore,
  QuotaFailoverState,
  QuotaFailoverStateStore,
} from '../../lib/quota-failover/index.ts';

/**
 * The two documents automatic quota failover owns inside the state home.
 *
 * BOTH READ AS `undefined` RATHER THAN THROWING, and both hand the raw parsed JSON up rather than a
 * typed value. The parsing belongs to the domain, and the two policies are deliberately different: an
 * invalid CONFIGURATION falls back to the defaults and warns, while an invalid LEDGER halts failover
 * entirely — because the ledger is the record of what has already been moved, and an empty one is a
 * permission rather than an absence. An adapter that parsed would have to carry both policies, and
 * the copy would drift.
 *
 * THE LEDGER IS WRITTEN ATOMICALLY, and it is written twice per migration — once before the move is
 * asked for and once when its outcome is known. A torn write there would lose the record that a
 * session had been moved, which is the one fact standing between this subsystem and a loop.
 *
 * The directory is created with owner-only permissions on first use: it names which accounts a
 * deployment pools together, which is fleet topology.
 */

export const QUOTA_FAILOVER_DIRECTORY = 'quota-failover';
export const QUOTA_FAILOVER_CONFIG_FILENAME = 'config.json';
export const QUOTA_FAILOVER_STATE_FILENAME = 'state.json';

/** The subsystem's own directory inside a state home. */
export function quotaFailoverRoot(stateDirectory: string): string {
  return join(stateDirectory, QUOTA_FAILOVER_DIRECTORY);
}

/** Reads and writes one JSON document, tolerating absence. */
class QuotaFailoverDocument {
  constructor(private readonly path: string) {}

  /** The document's parsed JSON, or `undefined` when it is absent, unreadable or not JSON at all. */
  async read(): Promise<unknown> {
    const raw = await readFile(this.path, 'utf8').catch(() => undefined);
    if (raw === undefined || raw.trim() === '') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      // Deliberately `undefined` and not a throw: what a document this daemon cannot read MEANS is a
      // domain decision, and it is not the same decision for the two documents above.
      return undefined;
    }
  }

  async write(value: unknown): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** The operator's quota-failover configuration, in its own document. */
export class FileQuotaFailoverConfigStore implements QuotaFailoverConfigStore {
  private readonly document: QuotaFailoverDocument;

  constructor(root: string) {
    this.document = new QuotaFailoverDocument(join(root, QUOTA_FAILOVER_CONFIG_FILENAME));
  }

  async read(): Promise<unknown> {
    return await this.document.read();
  }
}

/** The durable ledger: which sessions this daemon has already moved, and when. */
export class FileQuotaFailoverStateStore implements QuotaFailoverStateStore {
  private readonly document: QuotaFailoverDocument;

  constructor(root: string) {
    this.document = new QuotaFailoverDocument(join(root, QUOTA_FAILOVER_STATE_FILENAME));
  }

  async read(): Promise<unknown> {
    return await this.document.read();
  }

  async write(state: QuotaFailoverState): Promise<void> {
    await this.document.write(state);
  }
}
