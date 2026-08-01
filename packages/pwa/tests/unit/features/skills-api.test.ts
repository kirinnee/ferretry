import { describe, expect, it } from 'bun:test';

import { fetchSessionSkills, skillsCatalogLoader } from '../../../src/features/skills/skills-api.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a',
});
const other = daemonConnection({
  daemonId: 'daemon/b',
  baseUrl: 'https://b.example.test',
  deviceToken: 'token-b',
});

const scope = daemonSessionScope(connection, 'sess-1');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const payload = {
  harness: 'claude',
  skills: [
    { name: 'summary', description: 'Recap the work.', scope: 'global', origin: 'claude' },
    { name: 'Floop', description: 'Review a diff.', scope: 'project', origin: 'both' },
    { name: 'kteam', description: 'Coordinate teammates.', scope: 'global', origin: 'claude' },
  ],
};

describe('fetchSessionSkills', () => {
  it('reads the session catalog from the paired daemon and sorts it by name', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const catalog = await fetchSessionSkills(connection, scope, async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return json(payload);
    });

    expect(seen[0]?.url).toBe('https://a.example.test/v1/sessions/sess-1/skills');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer token-a');
    expect(catalog.harness).toBe('claude');
    expect(catalog.skills.map(item => item.name)).toEqual(['Floop', 'kteam', 'summary']);
  });

  it('percent-encodes a session id and forwards an abort signal', async () => {
    const controller = new AbortController();
    let forwarded: AbortSignal | null | undefined;
    let requested = '';
    await fetchSessionSkills(
      connection,
      daemonSessionScope(connection, 'sess/one two'),
      async (url, init) => {
        requested = String(url);
        forwarded = init?.signal;
        return json({ harness: 'codex', skills: [] });
      },
      controller.signal,
    );

    expect(requested).toBe('https://a.example.test/v1/sessions/sess%2Fone%20two/skills');
    expect(forwarded).toBe(controller.signal);
  });

  it('refuses a connection that does not own the scope', async () => {
    await expect(fetchSessionSkills(other, scope, async () => json(payload))).rejects.toThrow(
      'the connection does not own this session scope',
    );
  });

  it('reports the daemon error body, and falls back to the status when there is none', async () => {
    await expect(
      fetchSessionSkills(connection, scope, async () => json({ error: 'no session sess-1', code: 'not-found' }, 404)),
    ).rejects.toMatchObject({ status: 404, message: 'no session sess-1', code: 'not-found' });

    const failure = await fetchSessionSkills(connection, scope, async () => new Response('nope', { status: 503 })).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(DaemonResponseError);
    expect(failure).toMatchObject({ status: 503, message: 'HTTP 503', code: undefined });
  });

  it('rejects a catalog that does not match the protocol', async () => {
    await expect(
      fetchSessionSkills(connection, scope, async () => json({ harness: 'gemini', skills: [] })),
    ).rejects.toThrow();
  });
});

describe('skillsCatalogLoader', () => {
  it('binds one connection into the loader the surface consumes', async () => {
    const loader = skillsCatalogLoader(connection, async () => json({ harness: 'codex', skills: [] }));
    const catalog = await loader(scope, new AbortController().signal);
    expect(catalog).toEqual({ harness: 'codex', skills: [] });
  });
});
