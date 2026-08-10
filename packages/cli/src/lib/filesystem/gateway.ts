import { SessionFileIndexResponseSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { FilesystemApiClient, IFilesystemGateway } from './ports.ts';
import { FsChangesSchema, FsFileViewSchema, FsListingSchema } from './wire.ts';

/** The root of one session's descriptor-confined working-tree reads. */
export function filesystemPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(required(sessionId, 'a session id or callsign is required'))}/fs`;
}

/** Adds a relative path as a query parameter, never as a server-side root override. */
function withPath(base: string, path?: string, rev?: 'head'): string {
  const params = new URLSearchParams();
  const target = path?.trim() ?? '';
  if (target !== '') params.set('path', target);
  if (rev !== undefined) params.set('rev', rev);
  const query = params.toString();
  return query === '' ? base : `${base}?${query}`;
}

function required(value: string, message: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(message);
  return trimmed;
}

/** Speaks the four read-only working-tree routes through the authenticated daemon client. */
export class ProtocolFilesystemGateway implements IFilesystemGateway {
  constructor(private readonly client: FilesystemApiClient) {}

  async list(sessionId: string, path?: string) {
    return await this.client.request(withPath(filesystemPath(sessionId), path), FsListingSchema);
  }

  async file(sessionId: string, path: string, rev?: 'head') {
    const target = required(path, 'a relative file path is required');
    return await this.client.request(withPath(`${filesystemPath(sessionId)}/file`, target, rev), FsFileViewSchema);
  }

  async index(sessionId: string) {
    return await this.client.request(`${filesystemPath(sessionId)}/index`, SessionFileIndexResponseSchema);
  }

  async changes(sessionId: string) {
    return await this.client.request(`${filesystemPath(sessionId)}/changes`, FsChangesSchema);
  }

  async diff(sessionId: string, path: string) {
    const target = required(path, 'a relative diff path is required');
    return await this.client.request(withPath(`${filesystemPath(sessionId)}/diff`, target), z.string());
  }
}
