/**
 * A scripted daemon for the item verbs: the kernel's config routes over files held in memory (`GET /v1/config/status`,
 * `GET`/`PUT`/`DELETE /v1/config/file`), with the etag an edit must be made against and the refusals a stale or missing
 * etag gets. It checks nothing about a file's CONTENT — the owner's schema is the daemon's — except that a PUT whose text
 * holds the marker `INVALID` is refused the way a file that does not check is (`422 config_invalid`), so a test can reach
 * that path. Every call is recorded, in order.
 */
import type { PluginClient } from '../manifest/implement.ts';

/** One call the verbs made. */
export interface ConfigDaemonCall {
  readonly route: string;
  readonly path?: string;
}

export interface FakeConfigDaemon {
  readonly client: Pick<PluginClient, 'call'>;
  /** The files as they stand, by path. */
  readonly files: Map<string, string>;
  readonly calls: ConfigDaemonCall[];
  /** Makes every later write answer "held for the owner". */
  holdWrites(sentences: readonly string[]): void;
}

const etagOf = (text: string | undefined): string => `etag-${String(Bun.hash(text ?? ''))}`;

/** The failure a shell client throws: a message, a status, a code and the body. */
function refusal(status: number, code: string, message: string, body?: unknown): Error {
  return Object.assign(new Error(message), { status, code, ...(body === undefined ? {} : { body }) });
}

export function fakeConfigDaemon(initial: Readonly<Record<string, string>> = {}): FakeConfigDaemon {
  const files = new Map(Object.entries(initial));
  const calls: ConfigDaemonCall[] = [];
  let held: readonly string[] | undefined;
  const client: Pick<PluginClient, 'call'> = {
    call: async <Answer>(
      route: string,
      init: { readonly query?: Readonly<Record<string, string>>; readonly body?: unknown } = {},
    ): Promise<Answer> => {
      const body = init.body as { path?: string; text?: string; etag?: string } | undefined;
      const path = init.query?.path ?? body?.path;
      calls.push({ route, ...(path === undefined ? {} : { path }) });
      switch (route) {
        case 'GET /v1/config/status':
          return {
            directory: '/config',
            files: [...files.keys()].toSorted().map(file => ({ path: file, kind: 'test', state: 'ok' })),
            issues: [],
            pending: [],
          } as Answer;
        case 'GET /v1/config/file': {
          if (path === undefined) throw refusal(400, 'bad_request', 'no file named');
          const text = files.get(path);
          return {
            path,
            exists: text !== undefined,
            text: text ?? '# yaml-language-server: $schema=../.schema/test.json\n',
            etag: etagOf(text),
            state: 'ok',
            issues: [],
          } as Answer;
        }
        case 'PUT /v1/config/file': {
          if (path === undefined || body?.text === undefined) throw refusal(400, 'invalid_request', 'no file or text');
          if (body.etag !== undefined && body.etag !== etagOf(files.get(path)))
            throw refusal(409, 'config_conflict', `${path} changed since it was read; read it again and redo the edit`);
          if (body.text.includes('INVALID'))
            throw refusal(422, 'config_invalid', 'the file does not check (1 problem); nothing was written', {
              error: 'the file does not check (1 problem); nothing was written',
              code: 'config_invalid',
              issues: [{ path, line: 2, severity: 'error', message: 'is not allowed', fix: 'remove it' }],
            });
          files.set(path, body.text);
          return (
            held === undefined
              ? { path, etag: etagOf(body.text), outcome: 'applied' }
              : {
                  path,
                  etag: etagOf(body.text),
                  outcome: 'pending',
                  pending: { path, etag: etagOf(body.text), changes: held },
                }
          ) as Answer;
        }
        case 'DELETE /v1/config/file': {
          if (path === undefined) throw refusal(400, 'bad_request', 'no file named');
          if (init.query?.etag === undefined) throw refusal(428, 'precondition_required', 'needs the etag');
          if (init.query.etag !== etagOf(files.get(path)))
            throw refusal(409, 'config_conflict', `${path} changed since it was read; read it again`);
          files.delete(path);
          return { path, etag: etagOf(undefined), outcome: 'removed' } as Answer;
        }
        default:
          throw new Error(`no answer for ${route}`);
      }
    },
  };
  return {
    client,
    files,
    calls,
    holdWrites: sentences => {
      held = sentences;
    },
  };
}
