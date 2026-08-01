import type { IFilesystemGateway, IFilesystemOutput } from './ports.ts';
import { renderChanges, renderDiff, renderFile, renderListing } from './render.ts';

/** Output options shared by every filesystem read. */
export interface FilesystemCommandOptions {
  readonly json?: boolean;
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
