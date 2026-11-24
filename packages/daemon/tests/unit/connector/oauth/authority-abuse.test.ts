import { describe, expect, test } from 'bun:test';
import { ConnectorAuthority } from '../../../../src/lib/connector/oauth/authority.ts';
import {
  ConnectorIndex,
  ConnectorMemory,
  OAuthError,
  type ConnectorState,
  base64url,
} from '../../../../src/lib/connector/oauth/model.ts';
import { ConnectorRateLimiter } from '../../../../src/lib/connector/oauth/rate-limiter.ts';
import { fixture, redirectUri, verifier } from '../../../support/connector/oauth-fixture.ts';

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>(resolve => (open = resolve));
  return { wait, open };
};
const empty: ConnectorState = { version: 1, clients: [], grants: [] };

/** Counts every operation that enters the write queue. */
function watchQueue(memory: ConnectorMemory) {
  const entered: string[] = [];
  const run = memory.run.bind(memory);
  memory.run = ((operation, lane = 'public') => {
    entered.push(lane);
    return run(operation, lane);
  }) as ConnectorMemory['run'];
  return entered;
}
const refresh = (clientId: string, token: string, source?: string) =>
  [{ grant_type: 'refresh_token', client_id: clientId, refresh_token: token }, source ? { source } : {}] as const;

describe('shared limits cannot be exhausted by one source (finding 1)', () => {
  test.each([
    ['register', 10, 200],
    ['authorize', 20, 300],
    ['wait', 60, 1200],
  ] as const)(
    '%s: a source spends only its own budget, then a higher global ceiling applies',
    (endpoint, each, all) => {
      const f = fixture();
      for (let i = 0; i < each; i++) f.authority.admit(endpoint, 'attacker');
      expect(() => f.authority.admit(endpoint, 'attacker')).toThrow(OAuthError);
      f.authority.admit(endpoint, 'bystander');
      for (let i = 0; i < all - each - 1; i++) f.authority.admit(endpoint, `s${i}`);
      expect(() => f.authority.admit(endpoint, 'one-more')).toThrow(OAuthError);
    },
  );

  test('an absent address shares one bucket, and an oversized one is trimmed to a bounded key', () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) f.authority.admit('register');
    expect(() => f.authority.admit('register', 'unknown')).toThrow(OAuthError);
    for (let i = 0; i < 10; i++) f.authority.admit('register', 'x'.repeat(500));
    expect(() => f.authority.admit('register', 'x'.repeat(64))).toThrow(OAuthError);
  });

  test('a source whose token requests keep failing is slowed; a valid refresh from elsewhere is not', async () => {
    const f = fixture();
    const flow = await f.flow();
    const queue = watchQueue(f.memory);
    for (let i = 0; i < 30; i++)
      await expect(
        f.authority.exchange(...refresh(flow.client.client_id, 'dead', '203.0.113.9')),
      ).rejects.toMatchObject({
        error: 'invalid_grant',
      });
    expect(queue).toEqual([]);
    await expect(f.authority.exchange(...refresh(flow.client.client_id, 'dead', '203.0.113.9'))).rejects.toMatchObject({
      status: 429,
    });
    const next = await f.authority.exchange(
      ...refresh(flow.client.client_id, flow.tokens.refresh_token ?? '', '198.51.100.1'),
    );
    expect(next.access_token).toStartWith('fyc_at_');
    f.advance(300_000);
    await expect(f.authority.exchange(...refresh(flow.client.client_id, 'dead', '203.0.113.9'))).rejects.toMatchObject({
      error: 'invalid_grant',
    });
  });

  test('a client spends its own success budget (30 a minute); anonymous failures never touch it', async () => {
    const f = fixture();
    const flow = await f.flow();
    for (let i = 0; i < 25; i++)
      await expect(f.authority.exchange(...refresh(flow.client.client_id, 'dead', 'noise'))).rejects.toMatchObject({
        error: 'invalid_grant',
      });
    let token = flow.tokens.refresh_token ?? '';
    // The sign-in's own code exchange was the first success of the minute.
    for (let i = 0; i < 29; i++) {
      const next = await f.authority.exchange(...refresh(flow.client.client_id, token, 'claude'));
      token = next.refresh_token ?? '';
    }
    await expect(f.authority.exchange(...refresh(flow.client.client_id, token, 'claude'))).rejects.toMatchObject({
      status: 429,
    });
    f.advance(60_000);
    expect(
      (await f.authority.exchange(...refresh(flow.client.client_id, token, 'claude'))).refresh_token,
    ).toBeDefined();
  });

  test('a client with no grant, sign-in or code is reclaimable after an hour, and reclaimed first at the cap', async () => {
    const f = fixture();
    const make = (i: number) => f.authority.register({ redirect_uris: [redirectUri] }, { source: `s${i}` });
    const clients = [];
    for (let i = 0; i < 20; i++) clients.push(await make(i));
    await expect(make(20)).rejects.toMatchObject({ error: 'invalid_client_metadata' });
    f.advance(59 * 60_000);
    await f.authorize(clients[0]?.client_id ?? '');
    f.advance(60_000);
    const added = await make(21);
    expect(f.state().clients.map(c => c.id)).toEqual([clients[0]?.client_id ?? '', added.client_id]);
  });

  test('a never-used client waits the hour; one whose grant was revoked waits a day', async () => {
    const f = fixture();
    const fresh = await f.register();
    f.advance(59 * 60_000);
    await f.register();
    expect(f.state().clients.some(c => c.id === fresh.client_id)).toBe(true);
    const flow = await f.flow();
    await f.authority.revoke(flow.grant.id, 'admin-cli');
    f.advance(2 * 3_600_000);
    await f.register();
    expect(f.state().clients.some(c => c.id === flow.client.client_id)).toBe(true);
    f.advance(24 * 3_600_000);
    await f.register();
    expect(f.state().clients.some(c => c.id === flow.client.client_id)).toBe(false);
  });

  test('sign-ins are capped per client and per source, evicting the offender’s own oldest', async () => {
    const f = fixture();
    const [a, b, c, d] = await Promise.all([f.register(), f.register(), f.register(), f.register()]);
    const challenge = base64url(await f.options.crypto.sha256(verifier));
    const start = async (clientId: string, source: string) =>
      new URL(
        await f.authority.startAuthorization(
          {
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
          },
          { source },
        ),
      ).searchParams.get('h') ?? '';
    const first = await start(a.client_id, 'one');
    await start(a.client_id, 'one');
    await start(a.client_id, 'one');
    await expect(f.authority.waitPage(first)).rejects.toMatchObject({ error: 'invalid_request' });
    expect(await f.authority.pending()).toHaveLength(2);
    await start(b.client_id, 'one');
    expect(await f.authority.pending()).toHaveLength(3);
    await start(c.client_id, 'one');
    expect(await f.authority.pending()).toHaveLength(3);
    const other = await start(d.client_id, 'two');
    expect((await f.authority.waitPage(other)).kind).toBe('pending');
    expect(await f.authority.pending()).toHaveLength(4);
  });

  test('at the global cap the heaviest source loses its oldest sign-in, never a quiet one', async () => {
    const f = fixture();
    const challenge = base64url(await f.options.crypto.sha256(verifier));
    const start = async (source: string) => {
      const client = await f.authority.register(
        { redirect_uris: [redirectUri] },
        { source: `r-${source}-${Math.random()}` },
      );
      return (
        new URL(
          await f.authority.startAuthorization(
            {
              response_type: 'code',
              client_id: client.client_id,
              redirect_uri: redirectUri,
              code_challenge: challenge,
              code_challenge_method: 'S256',
            },
            { source },
          ),
        ).searchParams.get('h') ?? ''
      );
    };
    const quiet = await start('quiet');
    const noisy: string[] = [];
    for (const source of ['n1', 'n2', 'n3']) for (let i = 0; i < 3; i++) noisy.push(await start(source));
    // 10 undecided now; the next arrival makes room by dropping the oldest of the busiest source.
    await start('n4');
    expect((await f.authority.waitPage(quiet)).kind).toBe('pending');
    await expect(f.authority.waitPage(noisy[0] ?? '')).rejects.toMatchObject({ error: 'invalid_request' });
    expect((await f.authority.pending()).length).toBeLessThanOrEqual(10);
  });

  test('a decided sign-in does not count against the caps', async () => {
    const f = fixture();
    const client = await f.register();
    const first = await f.authorize(client.client_id);
    await f.authority.approve((await f.authority.pending())[0]?.id ?? '', 'admin-cli');
    await f.authorize(client.client_id);
    await f.authorize(client.client_id);
    expect((await f.authority.waitPage(first)).kind).toBe('redirect');
  });
});

describe('the public read paths never enter the write queue (finding 2)', () => {
  test('bearer checks, waiting-page polls, unknown handles, tokens and credentials never queue', async () => {
    const f = fixture();
    const flow = await f.flow();
    const pendingClient = await f.register();
    const handle = await f.authorize(pendingClient.client_id);
    await f.authority.verify(flow.tokens.access_token);
    await f.memory.idle();
    const queue = watchQueue(f.memory);
    expect(await f.authority.verify(flow.tokens.access_token)).toMatchObject({ grantId: flow.grant.id });
    expect(await f.authority.verify(`fyc_at_${'A'.repeat(43)}`)).toBeUndefined();
    expect((await f.authority.waitPage(handle)).kind).toBe('pending');
    await expect(f.authority.waitPage('B'.repeat(43))).rejects.toMatchObject({ error: 'invalid_request' });
    await expect(
      f.authority.exchange({ ...flow.exchange, code: 'unknown-code', redirect_uri: redirectUri }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    await expect(f.authority.exchange(...refresh(flow.client.client_id, 'unknown'))).rejects.toMatchObject({
      error: 'invalid_grant',
    });
    await expect(f.authority.exchange(...refresh('fycl_unknownxxx', 'unknown'))).rejects.toMatchObject({
      error: 'invalid_client',
    });
    await f.authority.revokeToken({ client_id: flow.client.client_id, token: 'unknown' });
    expect(queue).toEqual([]);
  });

  test('a stalled write does not delay a bearer check or a waiting-page poll', async () => {
    const f = fixture();
    const flow = await f.flow();
    const handle = await f.authorize((await f.register()).client_id);
    const stalled = gate();
    const held = f.memory.run(() => stalled.wait, 'owner');
    expect(await f.authority.verify(flow.tokens.access_token)).toMatchObject({ grantId: flow.grant.id });
    expect((await f.authority.waitPage(handle)).kind).toBe('pending');
    stalled.open();
    await held;
  });

  test('an approval is honoured by a poll without reading storage, and only one poll gets the code', async () => {
    const f = fixture();
    const client = await f.register();
    const handle = await f.authorize(client.client_id);
    await f.authority.approve((await f.authority.pending())[0]?.id ?? '', 'admin-cli');
    f.breakStore();
    const polls = await Promise.allSettled([f.authority.waitPage(handle), f.authority.waitPage(handle)]);
    expect(polls.map(p => p.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  test('a poll for an approval whose grant was revoked is refused', async () => {
    const f = fixture();
    const client = await f.register();
    const handle = await f.authorize(client.client_id);
    const approval = await f.authority.approve((await f.authority.pending())[0]?.id ?? '', 'admin-cli');
    if (!approval.ok) throw new Error('approval failed');
    await f.authority.revoke(approval.value.id, 'admin-cli');
    await expect(f.authority.waitPage(handle)).rejects.toMatchObject({ error: 'invalid_request' });
  });

  test('the owner’s acts run before queued public writes; public writes are bounded', async () => {
    const f = fixture();
    const flow = await f.flow();
    const order: string[] = [];
    const stalled = gate();
    const held = f.memory.run(async () => {
      await stalled.wait;
      order.push('running');
    });
    const registers: Promise<unknown>[] = [];
    for (let i = 0; i < 32; i++)
      registers.push(f.authority.register({ redirect_uris: [redirectUri] }, { source: `r${i}`, admitted: true }));
    for (const r of registers) r.catch(() => undefined);
    await expect(
      f.authority.register({ redirect_uris: [redirectUri] }, { source: 'late', admitted: true }),
    ).rejects.toMatchObject({ error: 'temporarily_unavailable', status: 503, retryAfter: 5 });
    const revoked = f.authority.revoke(flow.grant.id, 'admin-cli').then(() => order.push('revoke'));
    registers.forEach((r, i) => void r.then(() => i === 0 && order.push('register')).catch(() => undefined));
    stalled.open();
    await Promise.all([held, revoked, ...registers.map(r => r.catch(() => undefined))]);
    expect(order.slice(0, 3)).toEqual(['running', 'revoke', 'register']);
  });

  test('token exchanges for known credentials are bounded separately from anonymous writes', async () => {
    const memory = new ConnectorMemory();
    const stalled = gate();
    const held = memory.run(() => stalled.wait, 'owner');
    const queued = Array.from({ length: 64 }, () => memory.run(async () => 1, 'token'));
    await expect(memory.run(async () => 1, 'token')).rejects.toMatchObject({ error: 'temporarily_unavailable' });
    const publicRun = memory.run(async () => 1, 'public');
    stalled.open();
    await Promise.all([held, publicRun, ...queued]);
  });

  test('a last-use write refused for a full queue is retried by a later bearer check', async () => {
    const f = fixture();
    const flow = await f.flow();
    const stalled = gate();
    const held = f.memory.run(() => stalled.wait, 'owner');
    for (let i = 0; i < 32; i++) void f.memory.run(async () => undefined);
    f.advance(61_000);
    await f.authority.verify(flow.tokens.access_token);
    const before = f.saves();
    stalled.open();
    await held;
    await f.memory.idle();
    expect(f.saves()).toBe(before);
    await f.authority.verify(flow.tokens.access_token);
    await f.memory.idle();
    expect(f.saves()).toBe(before + 1);
  });

  test('a last-use write skips a grant revoked meanwhile and one used within the minute', async () => {
    const f = fixture();
    const flow = await f.flow();
    f.advance(61_000);
    const stalled = gate();
    const held = f.memory.run(() => stalled.wait, 'owner');
    await f.authority.verify(flow.tokens.access_token);
    const revoked = f.authority.revoke(flow.grant.id, 'admin-cli');
    stalled.open();
    await Promise.all([held, revoked]);
    await f.memory.idle();
    expect((await f.authority.grants())[0]?.lastUsedAt).toBeUndefined();
  });

  test('queue operations that fail do not stop the queue; idle resolves when it drains', async () => {
    const memory = new ConnectorMemory();
    await memory.idle();
    const failing = memory.run(async () => {
      throw new Error('boom');
    });
    const after = memory.run(async () => 'ok');
    const drained = memory.idle();
    await expect(failing).rejects.toThrow('boom');
    expect(await after).toBe('ok');
    await drained;
  });
});

describe('the digest index', () => {
  test('loads once, lets a write win a race, and retries after a failed load', async () => {
    const index = new ConnectorIndex();
    let loads = 0;
    const slow = gate();
    const load = async () => {
      loads++;
      await slow.wait;
      return empty;
    };
    const first = index.ensure(load);
    const second = index.ensure(load);
    index.replace({ ...empty, clients: [] });
    slow.open();
    await Promise.all([first, second]);
    expect(loads).toBe(1);
    await index.ensure(load);
    expect(loads).toBe(1);
    const broken = new ConnectorIndex();
    await expect(
      broken.ensure(async () => {
        throw new Error('damaged');
      }),
    ).rejects.toThrow('damaged');
    await broken.ensure(async () => empty);
    expect(broken.grantLive('cg_x')).toBe(false);
  });

  test('a grant revoked by a write disappears from the index at once', async () => {
    const f = fixture();
    const flow = await f.flow();
    await f.authority.revoke(flow.grant.id, 'admin-cli');
    expect(f.memory.index.grantLive(flow.grant.id)).toBe(false);
    expect(await f.authority.verify(flow.tokens.access_token)).toBeUndefined();
  });
});

describe('redirect allow-list at authorize time (finding 3)', () => {
  test('a redirect removed from the configuration stops authorizing even for a registered client', async () => {
    const f = fixture();
    const extra = `${redirectUri}?existing=1`;
    const client = await f.register({ redirect_uris: [extra] });
    const shrunk = new ConnectorAuthority({ ...f.options, allowedRedirectUris: [] });
    const challenge = base64url(await f.options.crypto.sha256(verifier));
    const input = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: extra,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const failure = await shrunk.startAuthorization(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({ error: 'invalid_request' });
    expect((failure as OAuthError).redirectTo).toBeUndefined();
    expect(await f.authority.startAuthorization(input)).toContain('/oauth/authorize/wait?h=');
  });
});

describe('OAuth error redirects (finding 4)', () => {
  const challenge = async (f: ReturnType<typeof fixture>) => base64url(await f.options.crypto.sha256(verifier));

  test.each([
    ['invalid_scope', { scope: 'fleet:read nope' }],
    ['invalid_request', { code_challenge_method: 'plain' }],
    ['invalid_request', { code_challenge: undefined }],
    ['invalid_request', { code_challenge: 'short' }],
    ['unsupported_response_type', { response_type: 'token' }],
    ['invalid_target', { resource: 'https://evil.example/mcp' }],
  ] as const)('%s after a trusted client and redirect goes back to the redirect URI', async (error, override) => {
    const f = fixture();
    const client = await f.register();
    const failure = await f.authority
      .startAuthorization({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: await challenge(f),
        code_challenge_method: 'S256',
        state: 'xyz&1',
        ...override,
      })
      .catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OAuthError);
    const location = new URL((failure as OAuthError).redirectTo ?? 'https://missing.invalid');
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      error,
      state: 'xyz&1',
      iss: 'https://connector.example',
    });
    expect(location.searchParams.get('error_description')).toBeTruthy();
  });

  test('a client that may not request codes is told so at its redirect, without a state it never sent', async () => {
    const f = fixture();
    const client = await f.register({ grant_types: ['refresh_token'] });
    const failure = await f.authority
      .startAuthorization({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: await challenge(f),
        code_challenge_method: 'S256',
      })
      .catch((caught: unknown) => caught);
    const location = new URL((failure as OAuthError).redirectTo ?? 'https://missing.invalid');
    expect(location.searchParams.get('error')).toBe('unauthorized_client');
    expect(location.searchParams.has('state')).toBe(false);
  });

  test('an unknown client or a wrong redirect URI is never redirected to', async () => {
    const f = fixture();
    const client = await f.register();
    const base = { response_type: 'token', code_challenge_method: 'plain' };
    for (const input of [
      { ...base, client_id: 'fycl_unknownxxx', redirect_uri: redirectUri },
      { ...base, client_id: client.client_id, redirect_uri: 'https://evil.example/cb' },
    ]) {
      const failure = await f.authority.startAuthorization(input).catch((caught: unknown) => caught);
      expect(failure).toMatchObject({ error: 'invalid_request' });
      expect((failure as OAuthError).redirectTo).toBeUndefined();
    }
  });
});

describe('audit initiator (finding 5)', () => {
  const revocations = (f: ReturnType<typeof fixture>) => f.events.filter(e => e.kind === 'connector.grant.revoked');

  test('an owner revocation names the owner act', async () => {
    const f = fixture();
    const flow = await f.flow();
    await f.authority.revoke(flow.grant.id, 'device:d1');
    expect(revocations(f)).toEqual([
      { kind: 'connector.grant.revoked', grantId: flow.grant.id, actor: 'device:d1', initiator: 'owner' },
    ]);
  });

  test('an RFC 7009 revocation is the client’s', async () => {
    const f = fixture();
    const flow = await f.flow();
    await f.authority.revokeToken({ client_id: flow.client.client_id, token: flow.tokens.access_token });
    expect(revocations(f)).toEqual([
      {
        kind: 'connector.grant.revoked',
        grantId: flow.grant.id,
        actor: `client:${flow.client.client_id}`,
        initiator: 'client',
      },
    ]);
  });

  test('a replayed refresh token and a replayed code are reuse detections', async () => {
    const f = fixture();
    const flow = await f.flow();
    await f.authority.exchange(...refresh(flow.client.client_id, flow.tokens.refresh_token ?? ''));
    await expect(
      f.authority.exchange(...refresh(flow.client.client_id, flow.tokens.refresh_token ?? '')),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    const replay = await f.flow();
    await expect(f.authority.exchange(replay.exchange)).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(revocations(f).map(e => (e.kind === 'connector.grant.revoked' ? e.initiator : undefined))).toEqual([
      'reuse-detected',
      'reuse-detected',
    ]);
  });
});

describe('rate limiter bounds', () => {
  test('counts check without charging, record without refusing, and sweeps expired windows', () => {
    let now = 0;
    const limiter = new ConnectorRateLimiter({ now: () => now });
    limiter.check('k', 1);
    limiter.record('k', 1000);
    expect(() => limiter.check('k', 1)).toThrow(OAuthError);
    limiter.record('k', 1000);
    expect(() => limiter.take('k', 5)).not.toThrow();
    now = 1000;
    limiter.take('k', 1);
    expect(() => limiter.take('k', 1)).toThrow(OAuthError);
  });

  test('forgets the oldest window instead of growing past its key bound', () => {
    const limiter = new ConnectorRateLimiter({ now: () => 0 }, 3);
    for (const key of ['a', 'b', 'c']) limiter.take(key, 1);
    expect(() => limiter.take('a', 1)).toThrow(OAuthError);
    limiter.take('d', 1);
    limiter.take('a', 1);
    expect(() => limiter.take('d', 1)).toThrow(OAuthError);
  });
});

describe('edges the queue rewrite must keep', () => {
  test('refuses unsupported grant types and clients not registered for a grant type without a queue slot', async () => {
    const f = fixture();
    const flow = await f.flow();
    const codeOnly = await f.register({ grant_types: ['authorization_code'] });
    const queue = watchQueue(f.memory);
    await expect(
      f.authority.exchange({ grant_type: 'password', client_id: flow.client.client_id }),
    ).rejects.toMatchObject({ error: 'unsupported_grant_type' });
    await expect(f.authority.exchange(...refresh(codeOnly.client_id, 'x'))).rejects.toMatchObject({
      error: 'unauthorized_client',
    });
    expect(queue).toEqual([]);
  });

  test('a registration naming another response type is refused before it is queued', async () => {
    const f = fixture();
    await expect(
      f.authority.register({ redirect_uris: [redirectUri], response_types: ['token'] }),
    ).rejects.toMatchObject({ error: 'invalid_client_metadata' });
  });

  test('owner acts on unknown or expired things answer plainly', async () => {
    const f = fixture();
    const client = await f.register();
    await f.authorize(client.client_id);
    const request = (await f.authority.pending())[0];
    expect(await f.authority.revoke('cg_missing', 'admin-cli')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await f.authority.deny('nope', 'admin-cli')).toMatchObject({ ok: false, code: 'not_found' });
    f.advance(600_000);
    expect(await f.authority.deny(request?.id ?? '', 'admin-cli')).toMatchObject({ ok: false, code: 'expired' });
  });

  test('an audit sink that throws never interrupts a decision', async () => {
    const f = fixture();
    const authority = new ConnectorAuthority({
      ...f.options,
      audit: {
        record: async () => {
          throw new Error('disk full');
        },
      },
    });
    expect((await authority.register({ redirect_uris: [redirectUri] })).client_id).toStartWith('fycl_');
  });

  test('a colliding sign-in id or match code is drawn again', async () => {
    const f = fixture();
    const script = { ids: [1, 1, 2], codes: [1, 1, 2] };
    let counter = 0;
    const crypto = {
      sha256: f.options.crypto.sha256,
      randomBytes: (length: number) => {
        if (length === 10) return new Uint8Array(10).fill(script.ids.shift() ?? 9);
        if (length === 6) return new Uint8Array(6).fill(script.codes.shift() ?? 9);
        counter++;
        return new Uint8Array(length).fill(counter);
      },
    };
    const authority = new ConnectorAuthority({ ...f.options, crypto, memory: new ConnectorMemory() });
    const client = await authority.register({ redirect_uris: [redirectUri] });
    const challenge = base64url(await crypto.sha256(verifier));
    const input = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    await authority.startAuthorization(input);
    await authority.startAuthorization(input, { source: 'elsewhere' });
    const views = await authority.pending();
    expect(new Set(views.map(v => v.id)).size).toBe(2);
    expect(new Set(views.map(v => v.matchCode)).size).toBe(2);
  });
});
