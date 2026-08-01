import { describe, expect, it } from 'bun:test';
import { loadAttachmentBlob } from '../../src/lib/attachment-source.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemon = daemonConnection({
  daemonId: 'files-daemon',
  baseUrl: 'https://files.example.test',
  deviceToken: 'files-token',
});
const scope = daemonSessionScope(daemon, 'files/session');

const other = daemonConnection({
  daemonId: 'other-daemon',
  baseUrl: 'https://other.example.test',
  deviceToken: 'other-token',
});

describe('loading an attachment blob', () => {
  it('reads from the daemon that owns the session', async () => {
    const seen: string[] = [];
    const blob = await loadAttachmentBlob(daemon, scope, 'a 1', undefined, async (url, init) => {
      seen.push(String(url));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer files-token');
      return new Response('bytes', { headers: { 'content-type': 'image/png' } });
    });
    expect(await blob.text()).toBe('bytes');
    expect(seen).toEqual(['https://files.example.test/v1/sessions/files%2Fsession/attachments/a%201']);
  });

  it('uses the browser’s own fetch when no transport is injected', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response('bytes', { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    try {
      expect(await (await loadAttachmentBlob(daemon, scope, 'a1')).text()).toBe('bytes');
      expect(seen).toEqual(['https://files.example.test/v1/sessions/files%2Fsession/attachments/a1']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses a scope belonging to another daemon', async () => {
    await expect(loadAttachmentBlob(other, scope, 'a1', undefined, async () => new Response(''))).rejects.toThrow(
      'attachment scope must belong to the requested daemon',
    );
  });

  it('surfaces a shaped daemon error and falls back to the status line', async () => {
    const shaped = loadAttachmentBlob(
      daemon,
      scope,
      'a1',
      undefined,
      async () =>
        new Response(JSON.stringify({ error: 'attachment expired', code: 'gone' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(shaped).rejects.toBeInstanceOf(DaemonResponseError);
    await expect(shaped).rejects.toThrow('attachment expired');

    await expect(
      loadAttachmentBlob(daemon, scope, 'a1', undefined, async () => new Response('nope', { status: 500 })),
    ).rejects.toThrow('HTTP 500');
  });
});
