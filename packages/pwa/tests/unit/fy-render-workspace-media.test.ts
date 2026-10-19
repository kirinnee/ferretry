/**
 * The far side of a `fy-render` media block's workspace read.
 *
 * Every outcome here is one of the closed set the renderer turns into a card,
 * and the request it makes is the same bounded preview read an `@file` click
 * makes. The fetcher is a fake behind the `DaemonFetch` port, so nothing in this
 * file touches the network.
 */
import { describe, test } from 'bun:test';
import should from 'should';
import { readWorkspaceMedia } from '../../src/components/fy-render-workspace-media.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';

const connection = daemonConnection({ baseUrl: 'https://a.example.test', daemonId: 'daemon-a', deviceId: 'a-token' });
const scope = daemonSessionScope(connection, 'session-1');

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetcher that answers every request with one response and records what was asked. */
const answering = (respond: () => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetcher: DaemonFetch = async (url, init) => {
    calls.push({ init, url: String(url) });
    return await respond();
  };
  return { calls, fetcher };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });

const file = (extra: Record<string, unknown>): Response => json(200, { path: 'assets/a.png', size: 3, ...extra });

const read = async (fetcher: DaemonFetch, path = 'assets/a.png', cwd: string | undefined = '/repo') =>
  await readWorkspaceMedia(connection, scope, path, cwd, fetcher, new AbortController().signal);

describe('readWorkspaceMedia path resolution', () => {
  test('should answer missing without a request for an absolute path outside the session folder', async () => {
    // Arrange
    const { calls, fetcher } = answering(() => file({ base64: 'AAEC' }));

    // Act
    const actual = await read(fetcher, '/elsewhere/a.png');

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'missing' });
    should(calls.length).equal(0);
  });

  test('should answer missing without a request for a path that is not openable', async () => {
    // Arrange
    const { calls, fetcher } = answering(() => file({ base64: 'AAEC' }));

    // Act
    const actual = await read(fetcher, 'assets/../../a.png');

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'missing' });
    should(calls.length).equal(0);
  });

  test('should ask the bounded base64 preview route for the session-relative path', async () => {
    // Arrange
    const { calls, fetcher } = answering(() => file({ base64: 'AAEC' }));
    const controller = new AbortController();

    // Act
    await readWorkspaceMedia(connection, scope, '/repo/assets/a.png', '/repo', fetcher, controller.signal);

    // Assert
    should(calls.map(call => call.url)).deepEqual([
      'https://a.example.test/v1/sessions/session-1/fs/file?format=base64&path=assets%2Fa.png',
    ]);
    should(calls[0]?.init?.signal === controller.signal).be.true();
  });
});

describe('readWorkspaceMedia outcomes', () => {
  test('should answer the decoded bytes for a served file', async () => {
    // Arrange
    const { fetcher } = answering(() => file({ base64: 'AAEC' }));

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual.ok).be.true();
    should(actual.ok ? [...actual.bytes] : null).deepEqual([0, 1, 2]);
  });

  test('should answer denied when the reader’s grants refuse the read', async () => {
    // Arrange
    const { fetcher } = answering(() => json(403, { code: 'grant_denied', error: 'forbidden' }));

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'denied' });
  });

  test('should answer missing when the daemon has no such file', async () => {
    // Arrange
    const { fetcher } = answering(() => json(404, { error: 'not found' }));

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'missing' });
  });

  test('should answer unavailable when the daemon fails', async () => {
    // Arrange
    const { fetcher } = answering(() => json(500, { error: 'boom' }));

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'unavailable' });
  });

  test('should answer unavailable when the carrier itself throws', async () => {
    // Arrange
    const { fetcher } = answering(() => {
      throw new TypeError('network down');
    });

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'unavailable' });
  });

  test('should rethrow an abort rather than calling it a refusal', async () => {
    // Arrange
    const { fetcher } = answering(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    // Act
    const actual = await read(fetcher).then(
      () => 'resolved',
      (error: unknown) => (error as { name?: string }).name,
    );

    // Assert
    should(actual).equal('AbortError');
  });

  for (const [label, extra] of [
    ['denylisted', { denied: true }],
    ['gitignored', { ignored: true }],
    ['refused with a reason', { reason: 'escapes' }],
  ] as const) {
    test(`should answer not-served for a file the daemon declines to serve (${label})`, async () => {
      // Arrange
      const { fetcher } = answering(() => file(extra));

      // Act
      const actual = await read(fetcher);

      // Assert
      should(actual).deepEqual({ ok: false, reason: 'not-served' });
    });
  }

  test('should carry the daemon’s rule with a refusal, so the reader is told which rule', async () => {
    // Arrange
    const { fetcher } = answering(() =>
      file({ ignored: true, reason: 'ignored', rule: 'Git ignores it (.gitignore:3: *.png)' }),
    );

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'not-served', rule: 'Git ignores it (.gitignore:3: *.png)' });
  });

  for (const [code, rule] of [
    ['escapes_root', 'it resolves outside the session folder (a link pointing out of it)'],
    ['denied', 'the protected-secrets list refuses this name'],
    ['ignored', 'Git ignores it'],
  ] as const) {
    test(`should name the rule behind a path refusal at 403 (${code}) rather than blame the reader’s access`, async () => {
      // Arrange
      const { fetcher } = answering(() => json(403, { code, error: 'path is not served' }));

      // Act
      const actual = await read(fetcher);

      // Assert
      should(actual).deepEqual({ ok: false, reason: 'not-served', rule });
    });
  }

  test('should read a media-folder file by its own path, through the media scope', async () => {
    // Arrange
    const { calls, fetcher } = answering(() => file({ base64: 'AAEC' }));

    // Act — no cwd resolution: the path is already relative to the media folder.
    const actual = await readWorkspaceMedia(
      connection,
      scope,
      'card.png',
      undefined,
      fetcher,
      new AbortController().signal,
      'media',
    );

    // Assert
    should(actual.ok).be.true();
    should(calls.map(call => call.url)).deepEqual([
      'https://a.example.test/v1/sessions/session-1/fs/file?format=base64&scope=media&path=card.png',
    ]);
  });

  test('should answer too-large for a file over the preview bound', async () => {
    // Arrange
    const { fetcher } = answering(() => file({ tooLarge: true }));

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'too-large' });
  });

  test('should answer unavailable when the answer carries no bytes', async () => {
    // Arrange
    const { fetcher } = answering(() => file({}));

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'unavailable' });
  });

  test('should answer unavailable when the bytes are not valid base64', async () => {
    // Arrange
    const { fetcher } = answering(() => file({ base64: '!!!not base64!!!' }));

    // Act
    const actual = await read(fetcher);

    // Assert
    should(actual).deepEqual({ ok: false, reason: 'unavailable' });
  });
});
