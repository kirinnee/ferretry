import {
  matchesSessionSearchQuery,
  MAX_SESSION_SEARCH_QUERY_LENGTH,
  sessionSearchFileHaystack,
  SessionSearchQuerySchema,
} from '@ferretry/protocol';
import type { IFilesystemGateway, IFilesystemOutput } from './ports.ts';
import { renderChanges, renderDiff, renderFile, renderFileIndex, renderListing } from './render.ts';

/** Output options shared by every filesystem read. */
export interface FilesystemCommandOptions {
  readonly json?: boolean;
}

/** `fy fs index` additionally accepts the search term to narrow the index by. */
export interface FilesystemIndexOptions extends FilesystemCommandOptions {
  readonly query?: string;
}

/** Drives descriptor-confined, read-only views of one session's working tree. */
export class FilesystemController {
  constructor(
    private readonly gateway: IFilesystemGateway,
    private readonly out: IFilesystemOutput,
  ) {}

  async list(sessionId: string, path: string | undefined, options: FilesystemCommandOptions): Promise<void> {
    const listing = await this.gateway.list(sessionId, path);
    this.#report(listing, options, () => renderListing(listing));
  }

  /**
   * The whole searchable index, optionally narrowed by the SAME query decision the daemon applies to
   * tasks — one grammar, two candidate sets, so a term that matches here matches there.
   *
   * The narrowing happens on the CLI side deliberately: the daemon answered with everything it may
   * serve, and re-asking it per keystroke-equivalent would spend a round trip to re-derive a substring
   * test the caller can run over a list it already holds.
   */
  async index(sessionId: string, options: FilesystemIndexOptions): Promise<void> {
    const query = options.query === undefined ? undefined : this.#searchQuery(options.query);
    const index = await this.gateway.index(sessionId);
    const matched =
      query === undefined
        ? index.files
        : index.files.filter(file => matchesSessionSearchQuery(sessionSearchFileHaystack(file), query));
    this.#report({ ...index, files: matched }, options, () => renderFileIndex(index, matched));
  }

  /** Validate before the index request, using the protocol-owned grammar and no CLI-local substitute. */
  #searchQuery(raw: string): string {
    const parsed = SessionSearchQuerySchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`--query must be between 1 and ${MAX_SESSION_SEARCH_QUERY_LENGTH} characters of search text`);
    }
    return parsed.data;
  }

  async file(
    sessionId: string,
    path: string,
    options: FilesystemCommandOptions & { readonly head?: boolean },
  ): Promise<void> {
    const file = await this.gateway.file(sessionId, path, options.head === true ? 'head' : undefined);
    this.#report(file, options, () => renderFile(file));
  }

  async changes(sessionId: string, options: FilesystemCommandOptions): Promise<void> {
    const changes = await this.gateway.changes(sessionId);
    this.#report(changes, options, () => renderChanges(changes));
  }

  async diff(sessionId: string, path: string, options: FilesystemCommandOptions): Promise<void> {
    const diff = await this.gateway.diff(sessionId, path);
    this.#report(diff, options, () => renderDiff(path, diff));
  }

  #report(payload: unknown, options: FilesystemCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}
