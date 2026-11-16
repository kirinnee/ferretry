/**
 * A scripted per-daemon client for the file viewer's suites. It answers the five file-browser route keys the way the
 * shell's client does: a JSON body parsed, the diff as text, an empty body as `undefined`, and a refusal thrown as a
 * `DaemonCallError` (the class the shell throws, so the viewer's reading of `status`/`code` is the real one).
 */
import { DaemonCallError } from '@ferretry/app';
import type { FerretsClient } from '../../../../../app/lib/client.ts';
import type { FsChanges, FsFile, FsListing } from '../../../../../app/features/files/wire.ts';
import type { FilesScope } from '../../../../../app/features/files/scope.ts';

export interface FsFixture {
  changes?: FsChanges | Error;
  /** `root` and `path` are the daemon's to state, so the client fills them in from the request. */
  listings?: Record<string, Omit<FsListing, 'root' | 'path'> | Error>;
  /** `size` defaults to the length of the served content, as a real daemon would state it. */
  files?: Record<string, (Omit<FsFile, 'size'> & { size?: number }) | Error>;
  /** The same, for the bounded byte representation (`format=base64`). */
  previews?: Record<string, (Omit<FsFile, 'size'> & { size?: number }) | Error>;
  diffs?: Record<string, string | Error>;
}

export interface FsCall {
  readonly route: string;
  readonly ferretId: string | undefined;
  readonly query: Readonly<Record<string, string>>;
}

export const refusal = (status: number, code: string, message: string): DaemonCallError =>
  new DaemonCallError(status, code, message);

/** A client over `fixture` (read at call time, so a test can change it); every call is appended to `calls`. */
export const fsClient = (fixture: () => FsFixture, calls: FsCall[] = []): FerretsClient => ({
  call: async <Answer = unknown>(
    route: string,
    init?: { readonly params?: Readonly<Record<string, string>>; readonly query?: Readonly<Record<string, string>> },
  ): Promise<Answer> => {
    const query = init?.query ?? {};
    calls.push({ route, ferretId: init?.params?.ferretId, query });
    const path = query.path ?? '';
    const current = fixture();
    const settle = (value: unknown): Answer => {
      if (value instanceof Error) throw value;
      return value as Answer;
    };
    if (route.endsWith('/fs/changes')) return settle(current.changes ?? { repo: false, changes: [] });
    if (route.endsWith('/fs/file')) {
      const table = query.format === 'base64' ? current.previews : current.files;
      const answer = table?.[path];
      if (answer instanceof Error) throw answer;
      const served = answer ?? { path, content: `contents of ${path}` };
      return { size: (served.content ?? '').length, ...served } as Answer;
    }
    if (route.endsWith('/fs/diff')) {
      const answer = current.diffs?.[path];
      if (answer instanceof Error) throw answer;
      return ((answer ?? '') === '' ? undefined : answer) as Answer;
    }
    if (route.endsWith('/fs')) {
      const answer = current.listings?.[path];
      if (answer instanceof Error) throw answer;
      return { root: '/work', path, ...(answer ?? { entries: [] }) } as Answer;
    }
    throw new Error(`no route ${route}`);
  },
});

export const scopeOf = (client: FerretsClient, ferretId = 'work'): FilesScope => ({ client, ferretId });
