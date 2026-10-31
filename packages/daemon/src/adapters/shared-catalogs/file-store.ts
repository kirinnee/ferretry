import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import {
  CatalogsDocumentSchema,
  type CatalogsDocument,
  documentProblem,
  EMPTY_CATALOGS_DOCUMENT,
} from '../../lib/shared-catalogs/document.ts';
import type { CatalogBlobStore, CatalogDocumentStore } from '../../lib/shared-catalogs/ports.ts';
import { CatalogRefusal } from '../../lib/shared-catalogs/refusal.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const DIGEST = /^sha256:([0-9a-f]{64})$/u;

/**
 * `state/catalogs/catalogs.json`, read whole, parsed with its schema, written whole through a temporary
 * file and a rename. DAMAGED IS NOT EMPTY: a file that will not parse is a refusal that names it, because
 * an empty list shown over a damaged document would have the person publish again on top of it. Only a
 * machine that has never published answers the empty document.
 */
export class FileCatalogDocumentStore implements CatalogDocumentStore {
  private readonly file: string;

  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.file = paths.catalogsDocument;
  }

  async read(): Promise<CatalogsDocument> {
    const raw = await this.files.readText(this.file);
    if (raw === undefined) return EMPTY_CATALOGS_DOCUMENT;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw this.damaged('it is not JSON');
    }
    const parsed = CatalogsDocumentSchema.safeParse(decoded);
    const problem = documentProblem(parsed);
    if (!parsed.success || problem !== null) throw this.damaged(problem ?? 'it is malformed');
    return parsed.data;
  }

  async write(document: CatalogsDocument): Promise<void> {
    await this.files.ensureDirectory(this.paths.catalogs, DIRECTORY_MODE);
    await this.files.writeTextAtomic(this.file, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.file, FILE_MODE);
  }

  private damaged(why: string): CatalogRefusal {
    return new CatalogRefusal(
      'store_damaged',
      `catalogs.json cannot be read: ${why}. Nothing was changed. Restore the file from a backup, or move it aside to start with no catalogs.`,
    );
  }
}

/**
 * The frozen item versions, one file per digest. A blob is written once: a digest already on disk is not
 * touched, so a published version can never be edited in place. The reader hashes what it gets back
 * (the service does), so a file changed under its name is found, not trusted.
 */
export class FileCatalogBlobStore implements CatalogBlobStore {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {}

  async put(digest: string, text: string): Promise<void> {
    const file = this.fileOf(digest);
    if ((await this.files.readText(file)) !== undefined) return;
    await this.files.ensureDirectory(this.paths.catalogs, DIRECTORY_MODE);
    await this.files.ensureDirectory(this.paths.catalogBlobs, DIRECTORY_MODE);
    await this.files.writeTextAtomic(file, text);
    await this.files.setMode(file, FILE_MODE);
  }

  async get(digest: string): Promise<string | undefined> {
    return await this.files.readText(this.fileOf(digest));
  }

  private fileOf(digest: string): string {
    const hex = DIGEST.exec(digest)?.[1];
    if (hex === undefined)
      throw new CatalogRefusal('store_damaged', 'a frozen item is listed under a digest that is not a sha256.');
    return join(this.paths.catalogBlobs, `${hex}.json`);
  }
}
