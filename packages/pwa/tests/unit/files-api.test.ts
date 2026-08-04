import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  changesUrl,
  codeReferenceRelativePath,
  describeFsError,
  diffUrl,
  fileUrl,
  fsApi,
  fsTabAvailable,
  isAbort,
  isUnknownRoute,
  listUrl,
  loadFsChanges,
  readFsProbe,
  resetFsProbes,
  resolveFsFilePaths,
  useFsProbe,
} from '../../src/components/files-api.ts';
import { render, runAsync } from '../support/react.ts';

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

  it('uses every filesystem endpoint, preserves daemon errors, and validates reference candidates', async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/diff')) return new Response('diff text', { headers: { 'content-type': 'text/plain' } });
      if (url.includes('/file'))
        return new Response(JSON.stringify({ path: 'a.ts' }), { headers: { 'content-type': 'application/json' } });
      if (url.includes('/changes'))
        return new Response(JSON.stringify({ repo: true, changes: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      return new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } });
    };
    expect(fileUrl(scopeA, 'a.ts', 'head')).toContain('/file?rev=head&path=a.ts');
    expect(changesUrl(scopeA)).toContain('/changes');
    expect(diffUrl(scopeA, 'a.ts')).toContain('/diff?path=a.ts');
    expect(await fsApi.file(daemonA, scopeA, 'a.ts', 'head', undefined, fetcher)).toMatchObject({ path: 'a.ts' });
    expect(await fsApi.changes(daemonA, scopeA, undefined, fetcher)).toMatchObject({ repo: true });
    expect(await fsApi.diff(daemonA, scopeA, 'a.ts', undefined, fetcher)).toBe('diff text');
    await expect(
      fsApi.list(daemonA, scopeA, '', undefined, async () => new Response('nope', { status: 500 })),
    ).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
    expect(codeReferenceRelativePath('/work/src/a.ts', '/work/')).toBe('src/a.ts');
    expect(codeReferenceRelativePath('/other/a.ts', '/work')).toBeNull();
    expect(codeReferenceRelativePath('/work/a.ts')).toBeNull();
    expect(codeReferenceRelativePath('/work/a.ts')).toBeNull();
    expect(codeReferenceRelativePath('./src/a.ts')).toBe('src/a.ts');
    expect(isAbort(new DOMException('', 'AbortError'))).toBeTrue();
    expect(isAbort(new Error('no'))).toBeFalse();
    expect(describeFsError(new TypeError('offline'))).toBe('could not reach the daemon');
    expect(describeFsError(new Error('offline'))).toBe('offline');
    expect(describeFsError('offline')).toBe('offline');
    expect(fsTabAvailable('ready')).toBeTrue();
    expect(fsTabAvailable('error')).toBeTrue();
    expect(fsTabAvailable('absent')).toBeFalse();
    // A daemon that cannot serve the surface KEEPS the tab: the reason has to be stated somewhere,
    // and a silently missing tab states nothing.
    expect(fsTabAvailable('unsupported')).toBeTrue();
  });

  it('settles on unsupported and keeps the daemon’s own reason for the disclosure', async () => {
    resetFsProbes();
    const original = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = (async () => {
      asked += 1;
      return new Response(
        JSON.stringify({ error: 'file browsing is not available on macOS yet', code: 'unsupported' }),
        {
          status: 501,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as unknown as typeof fetch;
    try {
      await loadFsChanges(daemonA, scopeA);
      expect(readFsProbe(scopeA)).toMatchObject({
        state: 'unsupported',
        changes: null,
        error: 'file browsing is not available on macOS yet',
      });
      // Settled, not merely failed: re-asking a machine what it is spends a request to hear the same
      // answer, so only a forced refresh may repeat it.
      await loadFsChanges(daemonA, scopeA);
      expect(asked).toBe(1);
    } finally {
      globalThis.fetch = original;
      resetFsProbes();
    }
  });

  it('keeps failed lookups absent and supports cancellable proof resolution', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    try {
      expect(await resolveFsFilePaths(daemonA, scopeA, ['src/a.ts'])).toEqual(new Map());
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ entries: [] }), {
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch;
      const liveController = new AbortController();
      expect(await resolveFsFilePaths(daemonA, scopeA, ['src/a.ts'], undefined, liveController.signal)).toEqual(
        new Map(),
      );
      globalThis.fetch = (async () => {
        throw new Error('offline again');
      }) as unknown as typeof fetch;
      expect(await resolveFsFilePaths(daemonA, scopeA, ['src/a.ts'], undefined, new AbortController().signal)).toEqual(
        new Map(),
      );
      const controller = new AbortController();
      controller.abort('stopped');
      await expect(resolveFsFilePaths(daemonA, scopeA, ['src/a.ts'], undefined, controller.signal)).rejects.toBe(
        'stopped',
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('publishes daemon-scoped probes and exposes the subscribed hook snapshot', async () => {
    resetFsProbes();
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ repo: true, changes: [] }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      await loadFsChanges(daemonA, scopeA);
      expect(readFsProbe(scopeA)).toMatchObject({ state: 'ready', refreshing: false });
      await loadFsChanges(daemonA, scopeA);
      let probe!: ReturnType<typeof useFsProbe>;
      const Probe = () => {
        probe = useFsProbe(daemonA, scopeA);
        return null;
      };
      render(createElement(Probe));
      await runAsync(async () => {
        probe.refresh();
        await Promise.resolve();
      });
      expect(probe.state).toBe('ready');
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ code: 'unknown_route' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch;
      await loadFsChanges(daemonA, scopeA, true);
      expect(readFsProbe(scopeA).state).toBe('absent');
      expect(isUnknownRoute({})).toBeFalse();
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch;
      await loadFsChanges(daemonA, scopeA, true);
      expect(readFsProbe(scopeA)).toMatchObject({ state: 'error', error: 'denied' });
    } finally {
      globalThis.fetch = original;
    }
  });
});
