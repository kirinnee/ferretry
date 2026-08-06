import type { IFyApiClient, SessionFileIndexResponse } from '@ferretry/protocol';
import type { FsChanges, FsFileView, FsListing } from './wire.ts';

/** The daemon working-tree reads used by the CLI. */
export interface IFilesystemGateway {
  list(sessionId: string, path?: string): Promise<FsListing>;
  /** Every searchable file under the session root in one call, with what the daemon left out. */
  index(sessionId: string): Promise<SessionFileIndexResponse>;
  file(sessionId: string, path: string, rev?: 'head'): Promise<FsFileView>;
  changes(sessionId: string): Promise<FsChanges>;
  diff(sessionId: string, path: string): Promise<string>;
}

/** Terminal output for the filesystem command group. */
export interface IFilesystemOutput {
  success(message: string): void;
}

/** The generic, schema-parsing client capability this route family consumes. */
export type FilesystemApiClient = Pick<IFyApiClient, 'request'>;
