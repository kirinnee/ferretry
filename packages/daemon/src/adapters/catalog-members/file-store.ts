import type { ZodError } from 'zod';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import {
  documentProblem,
  EMPTY_MEMBERS_DOCUMENT,
  EMPTY_SHARES_DOCUMENT,
  MembersDocumentSchema,
  SharesDocumentSchema,
  type MembersDocument,
  type SharesDocument,
} from '../../lib/catalog-members/document.ts';
import type { CatalogMembersStore, CatalogSharesStore } from '../../lib/catalog-members/ports.ts';
import { CatalogMemberRefusal } from '../../lib/catalog-members/refusal.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** What a document store needs to know about its one file. */
interface Shape<T> {
  readonly name: string;
  readonly empty: T;
  readonly parse: (value: unknown) => { readonly success: boolean; readonly data?: T; readonly error?: ZodError };
}

/**
 * One JSON document, read whole, parsed with its schema, written whole through a temporary file and a rename.
 * DAMAGED IS NOT EMPTY: a file that will not parse is a refusal that names it, because a list shown empty over a
 * damaged document would have the owner share again on top of people who are still in it. Only a machine that
 * has never shared answers the empty document.
 */
class JsonDocumentFile<T> {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
    private readonly file: string,
    private readonly shape: Shape<T>,
  ) {}

  async read(): Promise<T> {
    const raw = await this.files.readText(this.file);
    if (raw === undefined) return this.shape.empty;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw this.damaged('it is not JSON');
    }
    const parsed = this.shape.parse(decoded);
    const problem = documentProblem(parsed);
    if (!parsed.success || parsed.data === undefined) throw this.damaged(problem ?? 'it is malformed');
    return parsed.data;
  }

  async write(document: T): Promise<void> {
    await this.files.ensureDirectory(this.paths.catalogs, DIRECTORY_MODE);
    await this.files.writeTextAtomic(this.file, `${JSON.stringify(document, undefined, 2)}\n`);
    await this.files.setMode(this.file, FILE_MODE);
  }

  private damaged(why: string): CatalogMemberRefusal {
    return new CatalogMemberRefusal(
      'store_damaged',
      `${this.shape.name} cannot be read: ${why}. Nothing was changed. Restore the file from a backup, or move it aside to start with nobody shared with.`,
    );
  }
}

/** `state/catalogs/members.json`. */
export class FileCatalogMembersStore implements CatalogMembersStore {
  private readonly document: JsonDocumentFile<MembersDocument>;

  constructor(paths: FoundationPaths, files: FileSystemPort) {
    this.document = new JsonDocumentFile(paths, files, paths.catalogMembers, {
      name: 'members.json',
      empty: EMPTY_MEMBERS_DOCUMENT,
      parse: value => MembersDocumentSchema.safeParse(value),
    });
  }

  async read(): Promise<MembersDocument> {
    return await this.document.read();
  }

  async write(document: MembersDocument): Promise<void> {
    await this.document.write(document);
  }
}

/** `state/catalogs/shares.json`: the SHA-256 of each code, never a code. */
export class FileCatalogSharesStore implements CatalogSharesStore {
  private readonly document: JsonDocumentFile<SharesDocument>;

  constructor(paths: FoundationPaths, files: FileSystemPort) {
    this.document = new JsonDocumentFile(paths, files, paths.catalogShares, {
      name: 'shares.json',
      empty: EMPTY_SHARES_DOCUMENT,
      parse: value => SharesDocumentSchema.safeParse(value),
    });
  }

  async read(): Promise<SharesDocument> {
    return await this.document.read();
  }

  async write(document: SharesDocument): Promise<void> {
    await this.document.write(document);
  }
}
