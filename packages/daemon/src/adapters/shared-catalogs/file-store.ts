import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import { CatalogsDocumentSchema, type CatalogsDocument, documentProblem } from '../../lib/shared-catalogs/document.ts';
import { CatalogsDocumentV1Schema } from '../../lib/shared-catalogs/document-v1.ts';
import type { CatalogBlobStore, CatalogDocumentStore, RawCatalogs } from '../../lib/shared-catalogs/ports.ts';
import { CatalogRefusal } from '../../lib/shared-catalogs/refusal.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const DIGEST = /^sha256:([0-9a-f]{64})$/u;

/**
 * `state/catalogs/catalogs.json`, read whole, parsed with the schema its `schemaVersion` names, written whole
 * through a temporary file and a rename. DAMAGED IS NOT EMPTY: a file that will not parse is a refusal that
 * names it, because an empty list shown over a damaged document would have the person publish again on top of
 * it. Only a machine that has never published answers the empty document. A version 1 file is handed on with
 * its exact text, so the backup the upgrade writes is those bytes.
 */
export class FileCatalogDocumentStore implements CatalogDocumentStore {
  private readonly file: string;

  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.file = paths.catalogsDocument;
  }

  async readRaw(): Promise<RawCatalogs> {
    const text = await this.files.readText(this.file);
    if (text === undefined) return { version: 'none' };
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw this.damaged('it is not JSON');
    }
    const version =
      typeof decoded === 'object' && decoded !== null
        ? (decoded as { schemaVersion?: unknown }).schemaVersion
        : undefined;
    if (version === 1) {
      const parsed = CatalogsDocumentV1Schema.safeParse(decoded);
      if (!parsed.success) throw this.damaged(documentProblem(parsed) as string);
      return { version: 1, doc: parsed.data, text };
    }
    const parsed = CatalogsDocumentSchema.safeParse(decoded);
    if (!parsed.success) throw this.damaged(documentProblem(parsed) as string);
    return { version: 2, doc: parsed.data };
  }

  async write(document: CatalogsDocument): Promise<void> {
    await this.writeFile(this.file, `${JSON.stringify(document, undefined, 2)}\n`);
  }

  async writeBackupV1(text: string): Promise<void> {
    await this.writeFile(this.paths.catalogsBackupV1, text);
  }

  private async writeFile(file: string, text: string): Promise<void> {
    await this.files.ensureDirectory(this.paths.catalogs, DIRECTORY_MODE);
    await this.files.writeTextAtomic(file, text);
    await this.files.setMode(file, FILE_MODE);
  }

  private damaged(why: string): CatalogRefusal {
    return new CatalogRefusal(
      'store_damaged',
      `catalogs.json cannot be read: ${why}. Nothing was changed. Restore the file from a backup, or move it aside to start with no catalogs.`,
    );
  }
}

/**
 * The frozen item versions, one file per digest.
 * A blob is named by the digest of its text, which every caller has already computed, so the text a name
 * holds is fixed: a file that already has it is left alone, and one that holds anything else (damaged on
 * disk) is replaced atomically with the right text. The reader hashes what it gets back (the service does),
 * so a file changed under its name is found, not trusted.
 */
export class FileCatalogBlobStore implements CatalogBlobStore {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {}

  async put(digest: string, text: string): Promise<void> {
    const file = this.fileOf(digest);
    if ((await this.files.readText(file)) === text) return;
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
