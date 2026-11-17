import {
  FerretSearchQuerySchema,
  matchesSessionSearchQuery,
  MAX_SESSION_SEARCH_QUERY_LENGTH,
  sessionSearchFileHaystack,
} from '../../../contract/index.ts';
import type { IFsGateway } from './gateway.ts';
import { renderChanges, renderDiff, renderFile, renderFileIndex, renderListing } from './render.ts';

/** Output options every file read accepts. */
export interface FsOptions {
  readonly json?: boolean;
}

/** `fy fs ls|index|cat|changes|diff`: descriptor-confined, read-only views of one ferret's working tree. */
export class FsController {
  constructor(
    private readonly gateway: IFsGateway,
    private readonly out: { success(message: string): void },
  ) {}

  async list(ferret: string, path: string | undefined, options: FsOptions): Promise<void> {
    const listing = await this.gateway.list(ferret, path);
    this.#report(listing, options, () => renderListing(listing));
  }

  /**
   * The whole searchable index, optionally narrowed by the SAME query decision the daemon applies to tasks: one grammar,
   * two candidate sets. The narrowing is here, over a list already held, rather than a round trip per term.
   */
  async index(ferret: string, options: FsOptions & { readonly query?: string }): Promise<void> {
    const parsed = options.query === undefined ? undefined : FerretSearchQuerySchema.safeParse(options.query);
    if (parsed !== undefined && !parsed.success)
      throw new Error(`--query must be between 1 and ${MAX_SESSION_SEARCH_QUERY_LENGTH} characters of search text`);
    const query = parsed?.data;
    const index = await this.gateway.index(ferret);
    const matched =
      query === undefined
        ? index.files
        : index.files.filter(file => matchesSessionSearchQuery(sessionSearchFileHaystack(file), query));
    this.#report({ ...index, files: matched }, options, () => renderFileIndex(index, matched));
  }

  async file(ferret: string, path: string, options: FsOptions & { readonly head?: boolean }): Promise<void> {
    const file = await this.gateway.file(ferret, path, options.head === true ? 'head' : undefined);
    this.#report(file, options, () => renderFile(file));
  }

  async changes(ferret: string, options: FsOptions): Promise<void> {
    const changes = await this.gateway.changes(ferret);
    this.#report(changes, options, () => renderChanges(changes));
  }

  async diff(ferret: string, path: string, options: FsOptions): Promise<void> {
    const diff = await this.gateway.diff(ferret, path);
    this.#report(diff, options, () => renderDiff(path, diff));
  }

  #report(payload: unknown, options: FsOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}
