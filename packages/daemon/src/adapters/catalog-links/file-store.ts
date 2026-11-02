import { documentProblem } from '../../lib/catalog-members/document.ts';
import { EMPTY_LINKS_DOCUMENT, type LinksDocument, LinksDocumentSchema } from '../../lib/catalog-links/document.ts';
import type { LinkDocumentStore } from '../../lib/catalog-links/ports.ts';
import { CatalogLinkRefusal } from '../../lib/catalog-links/refusal.ts';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * `state/catalogs/links.json`: one JSON document, read whole and written whole through a temporary file and a rename.
 * It names a link, its item and its store, and NEVER a key or a URL (the keys are sealed in `link-keys.json`).
 *
 * DAMAGED IS NOT EMPTY: a file that will not parse is a refusal that names it, because a list shown empty over a
 * damaged document would leave links on the store that this machine could no longer turn off.
 */
export class FileLinkDocumentStore implements LinkDocumentStore {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {}

  async read(): Promise<LinksDocument> {
    const raw = await this.files.readText(this.paths.catalogLinks);
    if (raw === undefined) return EMPTY_LINKS_DOCUMENT;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw this.damaged('it is not JSON');
    }
    const parsed = LinksDocumentSchema.safeParse(decoded);
    if (!parsed.success) throw this.damaged(documentProblem(parsed) ?? 'it is malformed');
    return parsed.data;
  }

  /** Refused, with nothing written, when the document breaks a rule of the file. */
  async write(document: LinksDocument): Promise<void> {
    const parsed = LinksDocumentSchema.safeParse(document);
    if (!parsed.success)
      throw new CatalogLinkRefusal(
        'links_store_damaged',
        `links.json was not written: ${documentProblem(parsed) ?? 'it is malformed'}. Nothing was changed.`,
      );
    await this.files.ensureDirectory(this.paths.catalogs, DIRECTORY_MODE);
    await this.files.writeTextAtomic(this.paths.catalogLinks, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.paths.catalogLinks, FILE_MODE);
  }

  private damaged(why: string): CatalogLinkRefusal {
    return new CatalogLinkRefusal(
      'links_store_damaged',
      `links.json cannot be read: ${why}. Nothing was changed. Restore the file from a backup, or move it aside to start with no links.`,
    );
  }
}
