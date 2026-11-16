import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ZodType } from 'zod';
import { type SessionFileIndexResponse, SessionFileIndexResponseSchema } from '../../../contract/index.ts';
import {
  type FsChanges,
  FsChangesSchema,
  type FsFileView,
  FsFileViewSchema,
  type FsListing,
  FsListingSchema,
} from './wire.ts';

/** The file browser's route keys, as the manifest declares them. */
export const FS_ROUTES = {
  list: 'GET /v1/ferrets/:ferretId/fs',
  index: 'GET /v1/ferrets/:ferretId/fs/index',
  file: 'GET /v1/ferrets/:ferretId/fs/file',
  changes: 'GET /v1/ferrets/:ferretId/fs/changes',
  diff: 'GET /v1/ferrets/:ferretId/fs/diff',
} as const;

/** The daemon's read-only working-tree reads, which the controller never sees as URLs. */
export interface IFsGateway {
  list(ferret: string, path?: string): Promise<FsListing>;
  index(ferret: string): Promise<SessionFileIndexResponse>;
  file(ferret: string, path: string, rev?: 'head'): Promise<FsFileView>;
  changes(ferret: string): Promise<FsChanges>;
  diff(ferret: string, path: string): Promise<string>;
}

function required(value: string, message: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(message);
  return trimmed;
}

/**
 * The four working-tree reads over the shell's guarded client. A path travels as a query parameter, never as a root
 * override (the daemon reads the folder from the ferret's own record), and every JSON answer is parsed, not cast.
 */
export class ClientFsGateway implements IFsGateway {
  constructor(private readonly client: PluginClient) {}

  async #read<T>(route: string, ferret: string, schema: ZodType<T>, query?: Record<string, string>): Promise<T> {
    const params = { ferretId: required(ferret, 'a session id or callsign is required') };
    return schema.parse(await this.client.call<unknown>(route, query === undefined ? { params } : { params, query }));
  }

  async list(ferret: string, path?: string): Promise<FsListing> {
    const target = path?.trim() ?? '';
    return await this.#read(FS_ROUTES.list, ferret, FsListingSchema, target === '' ? undefined : { path: target });
  }

  async index(ferret: string): Promise<SessionFileIndexResponse> {
    return await this.#read(FS_ROUTES.index, ferret, SessionFileIndexResponseSchema);
  }

  async file(ferret: string, path: string, rev?: 'head'): Promise<FsFileView> {
    const query = { path: required(path, 'a relative file path is required'), ...(rev === undefined ? {} : { rev }) };
    return await this.#read(FS_ROUTES.file, ferret, FsFileViewSchema, query);
  }

  async changes(ferret: string): Promise<FsChanges> {
    return await this.#read(FS_ROUTES.changes, ferret, FsChangesSchema);
  }

  /** The one text answer: a unified diff. An empty diff arrives as no body at all. */
  async diff(ferret: string, path: string): Promise<string> {
    const params = { ferretId: required(ferret, 'a session id or callsign is required') };
    const query = { path: required(path, 'a relative diff path is required') };
    const body = await this.client.call<unknown>(FS_ROUTES.diff, { params, query });
    if (body === undefined || body === null) return '';
    if (typeof body !== 'string') throw new Error('the daemon answered a diff with a body that is not text');
    return body;
  }
}
