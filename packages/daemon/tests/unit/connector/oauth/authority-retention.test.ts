import { describe, expect, test } from 'bun:test';
import { ConnectorAuthority } from '../../../../src/lib/connector/oauth/authority.ts';
import { ConnectorMemory, base64url, connectorStateSchema } from '../../../../src/lib/connector/oauth/model.ts';
import { ConnectorRateLimiter } from '../../../../src/lib/connector/oauth/rate-limiter.ts';
import { fixture, redirectUri, verifier } from '../../../support/connector/oauth-fixture.ts';

const DAY = 86_400_000;
type Fixture = ReturnType<typeof fixture>;
const refresh = (clientId: string, token: string) =>
  [{ grant_type: 'refresh_token', client_id: clientId, refresh_token: token }, {}] as const;

/** A sign-in from one named source (the fixture's `authorize` always comes from the shared unknown source). */
async function startFrom(f: Fixture, clientId: string, source: string): Promise<string> {
  const challenge = base64url(await f.options.crypto.sha256(verifier));
  const location = await f.authority.startAuthorization(
    {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
    { source },
  );
  return new URL(location).searchParams.get('h') ?? '';
}
const registerFrom = (f: Fixture, source: string) => f.authority.register({ redirect_uris: [redirectUri] }, { source });

describe('the limiter keeps its global ceilings when sources flood it (finding 1)', () => {
  test('filling the source map to its bound never resets a fixed key', () => {
    const limiter = new ConnectorRateLimiter({ now: () => 0 }, 3);
    limiter.take('register:all', 2);
    limiter.take('register:all', 2);
    for (let i = 0; i < 50; i++) limiter.take(`register:source:${i}`, 1, 60_000, 'source');
    expect(() => limiter.take('register:all', 2)).toThrow(expect.objectContaining({ status: 429 }));
  });

  test('through the authority: a flood of distinct sources cannot reopen the overall registration ceiling', () => {
    const f = fixture();
    const authority = new ConnectorAuthority({
      ...f.options,
      memory: new ConnectorMemory(),
      limiter: new ConnectorRateLimiter(f.options.clock, 5),
    });
    for (let i = 0; i < 200; i++) authority.admit('register', `source-${i}`);
    expect(() => authority.admit('register', 'one-more')).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => authority.admit('register', 'source-0')).toThrow(expect.objectContaining({ status: 429 }));
  });

  test('a per-client token budget survives a flood of source keys', async () => {
    const f = fixture();
    const authority = new ConnectorAuthority({ ...f.options, limiter: new ConnectorRateLimiter(f.options.clock, 4) });
    const flow = await f.flow();
    let token = flow.tokens.refresh_token ?? '';
    for (let i = 0; i < 30; i++) {
      const next = await authority.exchange(...refresh(flow.client.client_id, token));
      token = next.refresh_token ?? '';
    }
    for (let i = 0; i < 20; i++) authority.admit('wait', `flood-${i}`);
    await expect(authority.exchange(...refresh(flow.client.client_id, token))).rejects.toMatchObject({ status: 429 });
  });
});

describe('rotated refresh digests are bounded (finding 2)', () => {
  test('a daily refresh for 90 days keeps only the digests that can still matter', async () => {
    const f = fixture();
    const flow = await f.flow();
    let token = flow.tokens.refresh_token ?? '';
    for (let day = 0; day < 90; day++) {
      f.advance(DAY);
      token = (await f.authority.exchange(...refresh(flow.client.client_id, token))).refresh_token ?? '';
    }
    const used = f.state().grants[0]?.usedRefresh ?? [];
    expect(used.length).toBeLessThanOrEqual(31);
    expect(used.length).toBeGreaterThan(20);
    for (const entry of used)
      expect(entry.expiresAt).toBeGreaterThan(Date.parse('2026-11-24T10:00:00.000Z') + 90 * DAY);
  });

  test('an expired token replayed is just invalid_grant: the grant lives', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    f.advance(DAY);
    await f.authority.exchange(...refresh(flow.client.client_id, first));
    f.advance(30 * DAY);
    await expect(f.authority.exchange(...refresh(flow.client.client_id, first))).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(f.state().grants[0]?.revokedAt).toBeUndefined();
    expect(f.events.some(e => e.kind === 'connector.refresh.reused')).toBe(false);
  });

  test('an entry that outlives the pruning but not its token expiry is invalid, not theft', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    await f.authority.exchange(...refresh(flow.client.client_id, first));
    // No write happens for 31 days, so the entry is still stored when the old token is replayed.
    f.advance(31 * DAY);
    await expect(f.authority.exchange(...refresh(flow.client.client_id, first))).rejects.toMatchObject({
      error: 'invalid_grant',
      description: 'Invalid or expired refresh token.',
    });
    expect(f.state().grants[0]?.revokedAt).toBeUndefined();
  });

  test('a connector.json from before expiries still loads, still revokes on reuse, and is stamped on the next write', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    const second = (await f.authority.exchange(...refresh(flow.client.client_id, first))).refresh_token ?? '';
    f.advance(61_000);
    const old = f.state();
    const legacy = { ...old, grants: old.grants.map(g => ({ ...g, usedRefresh: g.usedRefresh.map(u => u.digest) })) };
    expect(typeof legacy.grants[0]?.usedRefresh[0]).toBe('string');
    expect(() => connectorStateSchema.parse(legacy)).not.toThrow();
    await f.store.save(legacy as never);
    f.memory.index.replace(await f.store.load());
    // The next write of the grant stamps the bare digest to expire 30 days on.
    const third = (await f.authority.exchange(...refresh(flow.client.client_id, second))).refresh_token ?? '';
    const stamped = f.state().grants[0]?.usedRefresh ?? [];
    // The old bare digest gets 30 days from this write; the entry this write made carries its own token's expiry.
    expect(stamped.map(u => u.expiresAt)).toEqual([
      Date.parse('2026-11-24T10:00:00.000Z') + 61_000 + 30 * DAY,
      Date.parse('2026-11-24T10:00:00.000Z') + 30 * DAY,
    ]);
    // And a legacy entry has no retry window: replaying it revokes.
    await expect(f.authority.exchange(...refresh(flow.client.client_id, first))).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(f.state().grants[0]?.revokedAt).toBeDefined();
    expect(third).not.toBe('');
  });

  test('a revoked grant is kept for 30 days, then dropped on the next write, with its digests', async () => {
    const f = fixture();
    const flow = await f.flow();
    await f.authority.exchange(...refresh(flow.client.client_id, flow.tokens.refresh_token ?? ''));
    await f.authority.revoke(flow.grant.id, 'admin-cli');
    expect(f.state().grants[0]?.usedRefresh).toEqual([]);
    f.advance(29 * DAY);
    await f.register();
    expect(f.state().grants).toHaveLength(1);
    f.advance(2 * DAY);
    await f.register();
    expect(f.state().grants).toEqual([]);
  });
});

describe('sign-in and client slots never displace the owner by a tie (finding 3)', () => {
  test('when every source holds exactly one sign-in, the newcomer is refused and nothing is displaced', async () => {
    const f = fixture();
    const handles: string[] = [];
    for (let i = 0; i < 10; i++) {
      const client = await registerFrom(f, `reg-${i}`);
      handles.push(await startFrom(f, client.client_id, `src-${i}`));
    }
    const late = await registerFrom(f, 'reg-late');
    await expect(startFrom(f, late.client_id, 'src-late')).rejects.toMatchObject({
      error: 'temporarily_unavailable',
      status: 503,
    });
    expect(await f.authority.pending()).toHaveLength(10);
    for (const handle of handles) expect((await f.authority.waitPage(handle)).kind).toBe('pending');
  });

  test('a source holding more than one still pays for a newcomer, and the oldest sign-in of the rest survives', async () => {
    const f = fixture();
    const handles: string[] = [];
    for (let i = 0; i < 8; i++) {
      const client = await registerFrom(f, `reg-${i}`);
      handles.push(await startFrom(f, client.client_id, `src-${i}`));
    }
    const heavy = await registerFrom(f, 'reg-heavy');
    const other = await registerFrom(f, 'reg-heavy-2');
    const own = await startFrom(f, heavy.client_id, 'src-heavy');
    await startFrom(f, other.client_id, 'src-heavy');
    const late = await registerFrom(f, 'reg-late');
    const newcomer = await startFrom(f, late.client_id, 'src-late');
    await expect(f.authority.waitPage(own)).rejects.toMatchObject({ error: 'invalid_request' });
    expect((await f.authority.waitPage(handles[0] ?? '')).kind).toBe('pending');
    expect((await f.authority.waitPage(newcomer)).kind).toBe('pending');
  });

  test('with every client slot taken, the oldest client holding nothing is reclaimed whatever its age', async () => {
    const f = fixture();
    const clients = [];
    for (let i = 0; i < 20; i++) clients.push(await registerFrom(f, `s${i}`));
    // The oldest two are in use (a waiting sign-in; an approved grant); the third is the oldest idle one.
    const waiting = await startFrom(f, clients[0]?.client_id ?? '', 'a');
    await startFrom(f, clients[1]?.client_id ?? '', 'b');
    await f.authority.approve((await f.authority.pending())[1]?.id ?? '', 'admin-cli');
    const added = await registerFrom(f, 'newcomer');
    const ids = f.state().clients.map(c => c.id);
    expect(ids).toHaveLength(20);
    expect(ids).toContain(clients[0]?.client_id ?? '');
    expect(ids).toContain(clients[1]?.client_id ?? '');
    expect(ids).not.toContain(clients[2]?.client_id ?? '');
    expect(ids.at(-1)).toBe(added.client_id);
    expect((await f.authority.waitPage(waiting)).kind).toBe('pending');
  });

  test('with every client slot in use, a registration is still refused', async () => {
    const f = fixture();
    for (let i = 0; i < 20; i++) {
      const client = await registerFrom(f, `s${i}`);
      await startFrom(f, client.client_id, `a${i}`);
      const waiting = await f.authority.pending();
      await f.authority.approve(waiting[waiting.length - 1]?.id ?? '', 'admin-cli');
    }
    await expect(registerFrom(f, 'newcomer')).rejects.toMatchObject({ error: 'invalid_client_metadata' });
    expect(f.state().clients).toHaveLength(20);
  });
});

describe('a lost refresh response costs a retry, not the grant (finding 4)', () => {
  test('the same token again inside the window issues a fresh pair and supersedes the first', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    const lost = await f.authority.exchange(...refresh(flow.client.client_id, first));
    f.advance(59_000);
    const retried = await f.authority.exchange(...refresh(flow.client.client_id, first));
    expect(retried.refresh_token).not.toBe(lost.refresh_token);
    expect(retried.access_token).not.toBe(lost.access_token);
    expect(await f.authority.verify(retried.access_token)).toBeDefined();
    // The pair the client never saw is dead, but nothing was revoked or reported as theft.
    expect(await f.authority.verify(lost.access_token)).toBeUndefined();
    await expect(
      f.authority.exchange(...refresh(flow.client.client_id, lost.refresh_token ?? '')),
    ).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(f.state().grants[0]?.revokedAt).toBeUndefined();
    expect(f.events.some(e => e.kind === 'connector.refresh.reused')).toBe(false);
    // The client then carries on with the new pair.
    const onward = await f.authority.exchange(...refresh(flow.client.client_id, retried.refresh_token ?? ''));
    expect(await f.authority.verify(onward.access_token)).toBeDefined();
  });

  test('a retry never extends the window: past a minute from the rotation the reuse revokes', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    await f.authority.exchange(...refresh(flow.client.client_id, first));
    f.advance(40_000);
    const retried = await f.authority.exchange(...refresh(flow.client.client_id, first));
    f.advance(21_000);
    await expect(f.authority.exchange(...refresh(flow.client.client_id, first))).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(f.state().grants[0]?.revokedAt).toBeDefined();
    expect(await f.authority.verify(retried.access_token)).toBeUndefined();
    expect(f.events).toContainEqual({ kind: 'connector.refresh.reused', grantId: flow.grant.id });
  });

  test('outside the window the reuse revokes the grant', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    const next = await f.authority.exchange(...refresh(flow.client.client_id, first));
    f.advance(61_000);
    await expect(f.authority.exchange(...refresh(flow.client.client_id, first))).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(f.state().grants[0]?.revokedAt).toBeDefined();
    expect(await f.authority.verify(next.access_token)).toBeUndefined();
  });

  test('a token rotated two generations ago revokes even inside the window', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    const second = await f.authority.exchange(...refresh(flow.client.client_id, first));
    // The client DID receive the second pair and used it, so the first token is now two generations back.
    const third = await f.authority.exchange(...refresh(flow.client.client_id, second.refresh_token ?? ''));
    f.advance(1000);
    await expect(f.authority.exchange(...refresh(flow.client.client_id, first))).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    expect(f.state().grants[0]?.revokedAt).toBeDefined();
    expect(await f.authority.verify(third.access_token)).toBeUndefined();
  });

  test('a retry keeps the narrowed scopes and cannot widen them', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    const narrowed = await f.authority.exchange({
      grant_type: 'refresh_token',
      client_id: flow.client.client_id,
      refresh_token: first,
      scope: 'fleet:read',
    });
    expect(narrowed.scope).toBe('fleet:read');
    await expect(
      f.authority.exchange({
        grant_type: 'refresh_token',
        client_id: flow.client.client_id,
        refresh_token: first,
        scope: 'fleet:read fleet:write',
      }),
    ).rejects.toMatchObject({ error: 'invalid_scope' });
    const retried = await f.authority.exchange(...refresh(flow.client.client_id, first));
    expect(retried.scope).toBe('fleet:read');
  });

  test('only digests and the rotation time are stored for the retry', async () => {
    const f = fixture();
    const flow = await f.flow();
    const first = flow.tokens.refresh_token ?? '';
    const next = await f.authority.exchange(...refresh(flow.client.client_id, first));
    const stored = JSON.stringify(f.state());
    for (const secret of [first, next.refresh_token ?? '', next.access_token]) expect(stored).not.toContain(secret);
    expect(f.state().grants[0]?.usedRefresh[0]?.rotatedAt).toBe(Date.parse('2026-11-24T10:00:00.000Z'));
  });
});
