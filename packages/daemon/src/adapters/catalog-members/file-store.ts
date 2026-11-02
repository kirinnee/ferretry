import type { ZodError } from 'zod';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import {
  documentProblem,
  EMPTY_MEMBERS_DOCUMENT,
  EMPTY_SHARES_DOCUMENT,
  LegacyMembersDocumentSchema,
  MembersDocumentSchema,
  SharesDocumentSchema,
  type MembersDocument,
  type SharesDocument,
} from '../../lib/catalog-members/document.ts';
import { uniqueMemberNames } from '../../lib/catalog-members/names.ts';
import type { CatalogMembersStore, CatalogSharesStore, MembersUpgrade } from '../../lib/catalog-members/ports.ts';
import { CatalogMemberRefusal } from '../../lib/catalog-members/refusal.ts';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** What a document store needs to know about its one file. */
interface Shape<T> {
  readonly name: string;
  readonly empty: T;
  readonly parse: (
    value: unknown,
    raw: string,
  ) => { readonly success: boolean; readonly data?: T; readonly error?: ZodError };
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
    const parsed = this.shape.parse(decoded, raw);
    const problem = documentProblem(parsed);
    if (!parsed.success || parsed.data === undefined) throw this.damaged(problem ?? 'it is malformed');
    return parsed.data;
  }

  async write(document: T): Promise<void> {
    await this.writeFile(this.file, `${JSON.stringify(document, undefined, 2)}\n`);
  }

  /** The text of `file`, or `undefined` when it is not there. */
  async textOf(file: string): Promise<string | undefined> {
    return await this.files.readText(file);
  }

  async writeFile(file: string, text: string): Promise<void> {
    await this.files.ensureDirectory(this.paths.catalogs, DIRECTORY_MODE);
    await this.files.writeTextAtomic(file, text);
    await this.files.setMode(file, FILE_MODE);
  }

  private damaged(why: string): CatalogMemberRefusal {
    return new CatalogMemberRefusal(
      'store_damaged',
      `${this.shape.name} cannot be read: ${why}. Nothing was changed. Restore the file from a backup, or move it aside to start with nobody shared with.`,
    );
  }
}

/**
 * `state/catalogs/members.json`.
 *
 * A file written before a name was an ID may hold two people with one name. It is not damaged: `read` answers it
 * with the later people renamed ("Alice (2)"), and `takeUpgrade` hands the service the commit that writes it.
 */
export class FileCatalogMembersStore implements CatalogMembersStore {
  private readonly document: JsonDocumentFile<MembersDocument>;
  private upgrade: MembersUpgrade | undefined;

  constructor(
    private readonly paths: FoundationPaths,
    files: FileSystemPort,
  ) {
    this.document = new JsonDocumentFile(paths, files, paths.catalogMembers, {
      name: 'members.json',
      empty: EMPTY_MEMBERS_DOCUMENT,
      parse: (value, raw) => {
        const strict = MembersDocumentSchema.safeParse(value);
        if (strict.success) return strict;
        const legacy = LegacyMembersDocumentSchema.safeParse(value);
        if (!legacy.success) return legacy;
        const unique = uniqueMemberNames(legacy.data.members);
        const data: MembersDocument = { ...legacy.data, members: [...unique.members] };
        this.upgrade = {
          renames: unique.renames,
          commit: async () => {
            await this.document.writeFile(await this.backupFile(raw), raw);
            await this.write(data);
          },
        };
        return { success: true, data };
      },
    });
  }

  async read(): Promise<MembersDocument> {
    this.upgrade = undefined;
    return await this.document.read();
  }

  takeUpgrade(): MembersUpgrade | undefined {
    const upgrade = this.upgrade;
    this.upgrade = undefined;
    return upgrade;
  }

  /** Refused, with nothing written, when two people would share a name or any other rule of the file is broken. */
  async write(document: MembersDocument): Promise<void> {
    const parsed = MembersDocumentSchema.safeParse(document);
    if (!parsed.success)
      throw new CatalogMemberRefusal(
        'store_damaged',
        `members.json was not written: ${documentProblem(parsed) ?? 'it is malformed'}. Nothing was changed.`,
      );
    await this.document.write(document);
  }

  /**
   * Where the original goes: the plain name when nothing is there, the same place when it already holds exactly this
   * file, and otherwise the first numbered name that is free. A backup is never replaced, so an earlier original
   * survives a later upgrade.
   */
  private async backupFile(raw: string): Promise<string> {
    const plain = this.paths.catalogMembersBeforeUniqueNames;
    for (let n = 1; ; n += 1) {
      const file = n === 1 ? plain : plain.replace(/\.json$/u, `.${String(n)}.json`);
      const held = await this.document.textOf(file);
      if (held === undefined || held === raw) return file;
    }
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
