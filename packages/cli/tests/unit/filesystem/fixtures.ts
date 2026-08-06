import type { SessionFileIndexResponse } from '@ferretry/protocol';
import type { z } from 'zod';
import type { FilesystemApiClient, IFilesystemGateway, IFilesystemOutput } from '../../../src/lib/filesystem/ports.ts';
import type { FsChanges, FsFileView, FsListing } from '../../../src/lib/filesystem/wire.ts';

export const listing: FsListing = {
  root: '/work/repo',
  path: 'src',
  entries: [
    { name: 'app.ts', type: 'file', size: 120 },
    { name: 'nested', type: 'dir' },
    { name: 'secret.env', type: 'symlink', denied: true, ignored: true, escapes: true },
  ],
};

export const fileView: FsFileView = { path: 'src/app.ts', size: 18, content: 'export const x = 1;' };

export const changesView: FsChanges = {
  repo: true,
  branch: 'port/clisurface',
  changes: [
    { path: 'src/app.ts', status: ' M', additions: 2, deletions: 1 },
    { path: 'src/new.ts', status: 'R ', from: 'src/old.ts' },
  ],
};

export const fileIndex: SessionFileIndexResponse = {
  v: 1,
  sessionId: 's1',
  root: '/work/repo',
  files: [
    { path: 'src/app.ts', name: 'app.ts' },
    { path: 'src/nested/deep.ts', name: 'deep.ts' },
    { path: 'README.md', name: 'README.md' },
  ],
  coverage: 'partial',
  skipped: [
    { reason: 'denied', count: 2 },
    { reason: 'unreadable', count: 1 },
  ],
};

export class RecordingFilesystemGateway implements IFilesystemGateway {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(
    private readonly responses: {
      listing?: FsListing;
      index?: SessionFileIndexResponse;
      file?: FsFileView;
      changes?: FsChanges;
      diff?: string;
    } = {},
  ) {}

  list(sessionId: string, path?: string): Promise<FsListing> {
    this.calls.push({ method: 'list', args: [sessionId, path] });
    return Promise.resolve(this.responses.listing ?? listing);
  }

  index(sessionId: string): Promise<SessionFileIndexResponse> {
    this.calls.push({ method: 'index', args: [sessionId] });
    return Promise.resolve(this.responses.index ?? fileIndex);
  }

  file(sessionId: string, path: string, rev?: 'head'): Promise<FsFileView> {
    this.calls.push({ method: 'file', args: [sessionId, path, rev] });
    return Promise.resolve(this.responses.file ?? fileView);
  }

  changes(sessionId: string): Promise<FsChanges> {
    this.calls.push({ method: 'changes', args: [sessionId] });
    return Promise.resolve(this.responses.changes ?? changesView);
  }

  diff(sessionId: string, path: string): Promise<string> {
    this.calls.push({ method: 'diff', args: [sessionId, path] });
    return Promise.resolve(this.responses.diff ?? 'diff --git a/src/app.ts b/src/app.ts');
  }
}

export class CapturingOutput implements IFilesystemOutput {
  readonly messages: string[] = [];
  success(message: string): void {
    this.messages.push(message);
  }
}

export class RecordingClient implements FilesystemApiClient {
  readonly calls: Array<{ path: string; schema: z.ZodType<unknown> }> = [];
  responses: unknown[] = [];

  request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    this.calls.push({ path, schema });
    return Promise.resolve(schema.parse(this.responses.shift()));
  }
}
