import { describe, expect, it } from 'bun:test';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { fsApi, listUrl, resetFsProbes, resolveFsFilePaths } from '../../src/components/files-api.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'a-token' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b-token' });
const scopeA = daemonSessionScope(daemonA, 'same/session');
const scopeB = daemonSessionScope(daemonB, 'same/session');

describe('files API', () => {
  it('uses a paired daemon URL and credentials rather than the page origin', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const listing = await fsApi.list(daemonA, scopeA, 'src', undefined, async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } });
    });
    expect(listing.entries).toEqual([]);
    expect(listUrl(scopeA, 'src')).toBe('/v1/sessions/same%2Fsession/fs?path=src');
    expect(calls[0]?.url).toBe('https://a.example.test/v1/sessions/same%2Fsession/fs?path=src');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer a-token');
    expect(() => fsApi.list(daemonA, scopeB, '')).toThrow('file scope must belong');
  });

  it('does not share an in-flight code-reference directory lookup across daemons', async () => {
    resetFsProbes();
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ entries: [{ name: 'a.ts', type: 'file' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const [a, b] = await Promise.all([
        resolveFsFilePaths(daemonA, scopeA, ['src/a.ts']),
        resolveFsFilePaths(daemonB, scopeB, ['src/a.ts']),
      ]);
      expect(a.get('src/a.ts')).toBe('src/a.ts');
      expect(b.get('src/a.ts')).toBe('src/a.ts');
      expect(seen).toEqual([
        'https://a.example.test/v1/sessions/same%2Fsession/fs?path=src',
        'https://b.example.test/v1/sessions/same%2Fsession/fs?path=src',
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
