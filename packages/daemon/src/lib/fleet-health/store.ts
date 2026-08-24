/**
 * The account-health heads, in one JSON document under this daemon's own state home.
 *
 * ## Why a JSON document and not a database
 *
 * The whole store is one small record per published account, written by a single serialized pass and
 * read whole. A database would buy transactions this access pattern has no concurrency for, and a
 * schema to migrate for a document whose entire contents can be re-derived for free by the pass that
 * already runs every minute.
 *
 * It replaces `fleet/health-successes.json`, which recorded only SUCCESSES — so there was nowhere to
 * put "this account was checked and rejected" or "nobody has ever checked this account", and every
 * concurrent writer read and rewrote the whole map with no ordering. Nothing here reads that file: it
 * is not migrated, because a success-only cache cannot express any of the four verdicts and deriving
 * one from it would be fabricating evidence. A leftover copy is inert.
 *
 * ## An unreadable document is no heads, never an error
 *
 * These rows are disposable derived evidence with a fifteen-minute horizon. A torn write, a document
 * from a build with a different shape, or a file somebody edited by hand therefore reads as "nothing
 * known yet": every account publishes as never-checked and the next free pass repopulates it.
 * Refusing to serve health because a cache file is damaged would take a whole surface down over a
 * file that costs one minute to rebuild.
 *
 * A WRITE FAILURE IS NOT SWALLOWED HERE. It propagates, because the caller is the one place that
 * knows a failed health write must not fail the quota read it rode in on — and a store that silently
 * dropped writes would look exactly like a store whose verdicts never change.
 *
 * Nothing but the injected {@link FileSystemPort} slice is touched, so the atomic replacement, the
 * permissions and the state-home containment are all the one implementation the daemon already has.
 */
import type { FileSystemPort } from '../ports.ts';
import { AccountHealthDocumentSchema, type AccountHealthHead } from './head.ts';
import type { AccountHealthStore } from './service.ts';

/** The file name under the daemon's `fleet` directory. */
export const ACCOUNT_HEALTH_FILE = 'account-health.json';

export class FileSystemAccountHealthStore implements AccountHealthStore {
  constructor(
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic'>,
    private readonly file: string,
  ) {}

  async read(): Promise<readonly AccountHealthHead[]> {
    const text = await this.files.readText(this.file);
    if (text === undefined) return [];
    try {
      return AccountHealthDocumentSchema.parse(JSON.parse(text)).accounts;
    } catch {
      // See the module note: damaged derived evidence is discarded and re-collected, never repaired.
      return [];
    }
  }

  async write(heads: readonly AccountHealthHead[]): Promise<void> {
    // Atomic, so a daemon killed mid-write leaves the previous document rather than a truncated one.
    // A truncated one reads as "no account has ever been checked", which is a visible regression on
    // every surface at once.
    await this.files.writeTextAtomic(
      this.file,
      `${JSON.stringify(AccountHealthDocumentSchema.parse({ accounts: [...heads] }), undefined, 2)}\n`,
    );
  }
}
