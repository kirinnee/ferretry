import { describe, expect, test } from 'bun:test';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import { editSharedDraft, fetchSharedDraft, sharedDraftPath } from '../../src/lib/shared-draft-client.ts';

const daemon = daemonConnection({ daemonId: 'up', baseUrl: 'https://up.example.test', deviceId: 'device' });
const scope = daemonSessionScope(daemon, 'sess one');
const snapshot = {
  v: 1 as const,
  sessionId: 'sess one',
  generation: 'gen-1',
  epoch: 0,
  rev: 1,
  text: 'hi',
  items: [],
  updatedAt: '2026-11-01T00:00:00.000Z',
};

describe('shared draft client', () => {
  test('reads the session’s own draft from its own route', async () => {
    const calls: string[] = [];
    const draft = await fetchSharedDraft(daemon, scope, async input => {
      calls.push(String(input));
      return Response.json(snapshot);
    });
    expect(draft).toEqual(snapshot);
    expect(calls).toEqual(['https://up.example.test/v1/sessions/sess%20one/shared-draft']);
    expect(sharedDraftPath(scope)).toBe('/v1/sessions/sess%20one/shared-draft');
  });

  test('posts an edit as JSON and returns the edit as the daemon sequenced it', async () => {
    let sent: RequestInit | undefined;
    const result = await editSharedDraft(
      daemon,
      scope,
      { generation: 'gen-1', epoch: 0, base: 1, text: [2, '!'] },
      async (_input, init) => {
        sent = init;
        return Response.json({
          applied: { generation: 'gen-1', epoch: 0, rev: 2, text: [2, '!'], add: [], remove: [] },
          snapshot: { ...snapshot, rev: 2, text: 'hi!' },
        });
      },
    );
    expect(sent?.method).toBe('POST');
    expect(JSON.parse(String(sent?.body))).toEqual({ generation: 'gen-1', epoch: 0, base: 1, text: [2, '!'] });
    expect(result.snapshot.text).toBe('hi!');
  });

  test('keeps the daemon’s own refusal code, so the composer can tell stale from too long', async () => {
    const refused = editSharedDraft(daemon, scope, { generation: 'gen-1', epoch: 0, base: 0 }, async () =>
      Response.json({ error: 'read the draft again', code: 'shared_draft_stale' }, { status: 409 }),
    );
    await expect(refused).rejects.toMatchObject({ status: 409, code: 'shared_draft_stale' });
    const bare = fetchSharedDraft(daemon, scope, async () => new Response('nope', { status: 500 }));
    await expect(bare).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });

  test('refuses another session’s draft, a shapeless answer, and a scope from another daemon', async () => {
    const foreign = fetchSharedDraft(daemon, scope, async () => Response.json({ ...snapshot, sessionId: 'other' }));
    await expect(foreign).rejects.toBeInstanceOf(DaemonResponseError);
    const shapeless = fetchSharedDraft(daemon, scope, async () => Response.json({ text: 'hi' }));
    await expect(shapeless).rejects.toMatchObject({ status: 502 });
    const noDraft = editSharedDraft(daemon, scope, { generation: 'gen-1', epoch: 0, base: 0 }, async () =>
      Response.json({}),
    );
    await expect(noDraft).rejects.toMatchObject({ status: 502 });
    const other = daemonConnection({ daemonId: 'other', baseUrl: 'https://o.example.test', deviceId: 'd' });
    await expect(fetchSharedDraft(other, scope, async () => Response.json(snapshot))).rejects.toThrow(
      'draft scope must belong to the requested daemon',
    );
  });
});
