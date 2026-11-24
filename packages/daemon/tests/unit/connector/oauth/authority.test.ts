import { describe, expect, test } from 'bun:test';
import { ConnectorAuthority } from '../../../../src/lib/connector/oauth/authority.ts';
import { ConnectorMemory, OAuthError, canonicalResource } from '../../../../src/lib/connector/oauth/model.ts';
import { endpoints, fixture, redirectUri, verifier } from '../../../support/connector/oauth-fixture.ts';

describe('connector authority', () => {
  test('mints only digest-backed tokens, codes, handles and client secrets', async () => {
    const f = fixture();
    const flow = await f.approved({ token_endpoint_auth_method: 'client_secret_post' });
    const tokens = await f.authority.exchange(flow.exchange);
    expect(tokens.access_token).toMatch(/^fyc_at_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^fyc_rt_[A-Za-z0-9_-]{43}$/);
    expect(flow.client.client_id).toMatch(/^fycl_[a-z2-7]{10}$/);
    expect(flow.grant.id).toMatch(/^cg_[a-z2-7]{10}$/);
    expect(tokens.expires_in).toBe(3600);
    const serialized = JSON.stringify(f.state());
    for (const raw of [flow.code, flow.handle, flow.client.client_secret, tokens.access_token, tokens.refresh_token]) {
      expect(typeof raw).toBe('string');
      expect(serialized.includes(raw ?? '')).toBe(false);
      expect(JSON.stringify(f.events).includes(raw ?? '')).toBe(false);
      expect(JSON.stringify([...f.memory.pending, ...f.memory.codes]).includes(raw ?? '')).toBe(false);
    }
    expect(f.state().grants[0]?.refresh[0]?.expiresAt).toBe(f.options.clock.now() + 30 * 86_400_000);
    expect(await f.authority.verify(tokens.access_token)).toEqual({
      grantId: flow.grant.id,
      tokenId: f.state().grants[0]?.access[0]?.digest.slice(0, 12) ?? '',
      scopes: ['fleet:read', 'fleet:write'],
      clientName: 'MCP client',
    });
  });

  test.each(['plain', undefined, 's256'])('requires PKCE S256, refusing %s', async method => {
    const f = fixture();
    const client = await f.register();
    await expect(f.authorize(client.client_id, { code_challenge_method: method })).rejects.toMatchObject({
      error: 'invalid_request',
    });
    await expect(f.authorize(client.client_id, { code_challenge: undefined })).rejects.toMatchObject({
      error: 'invalid_request',
    });
  });

  test('DCR rejects any redirect outside the explicit list and supports the Claude default', async () => {
    const f = fixture();
    for (const uri of ['https://evil.example/cb', `${redirectUri}/`, 'https://claude.com/api/mcp/auth_callback']) {
      await expect(f.register({ redirect_uris: [redirectUri, uri] })).rejects.toMatchObject({
        error: 'invalid_redirect_uri',
      });
    }
    const authority = new ConnectorAuthority({ ...f.options, allowedRedirectUris: [] });
    expect((await authority.register({ redirect_uris: [redirectUri] })).client_id).toStartWith('fycl_');
  });

  test('requires an exact registered redirect and a known client', async () => {
    const f = fixture();
    const client = await f.register();
    for (const uri of [`${redirectUri}/`, `${redirectUri}?x=1`, 'https://evil.example']) {
      await expect(f.authorize(client.client_id, { redirect_uri: uri })).rejects.toMatchObject({
        error: 'invalid_request',
      });
    }
    await expect(f.authorize('unknown')).rejects.toMatchObject({ error: 'invalid_request' });
  });

  test('canonical resource comparison is identical at authorize and token', async () => {
    const f = fixture();
    expect(canonicalResource('HTTPS://CONNECTOR.EXAMPLE:443/mcp/')).toBe(endpoints.resource);
    const flow = await f.approved({}, { resource: 'HTTPS://CONNECTOR.EXAMPLE:443/mcp/' });
    for (const resource of [
      'https://evil.example/mcp',
      `${endpoints.resource}//`,
      `${endpoints.resource}?other=1`,
      `${endpoints.resource}#x`,
      'broken',
    ]) {
      await expect(f.authority.exchange({ ...flow.exchange, resource })).rejects.toMatchObject({
        error: 'invalid_target',
      });
      await expect(f.authorize(flow.client.client_id, { resource })).rejects.toMatchObject({ error: 'invalid_target' });
    }
    expect(
      (await f.authority.exchange({ ...flow.exchange, resource: 'https://CONNECTOR.example:443/mcp/' })).access_token,
    ).toStartWith('fyc_at_');
  });

  test('refuses scope escalation and preserves narrowing over refresh rotations', async () => {
    const f = fixture();
    const client = await f.register();
    await expect(f.authorize(client.client_id, { scope: 'fleet:read secrets:read' })).rejects.toMatchObject({
      error: 'invalid_scope',
    });
    const flow = await f.flow();
    const reduced = await f.authority.exchange({
      grant_type: 'refresh_token',
      client_id: flow.client.client_id,
      refresh_token: flow.tokens.refresh_token,
      scope: 'fleet:read',
    });
    expect((await f.authority.verify(reduced.access_token))?.scopes).toEqual(['fleet:read']);
    await expect(
      f.authority.exchange({
        grant_type: 'refresh_token',
        client_id: flow.client.client_id,
        refresh_token: reduced.refresh_token,
        scope: 'fleet:write',
      }),
    ).rejects.toMatchObject({ error: 'invalid_scope' });
    const again = await f.authority.exchange({
      grant_type: 'refresh_token',
      client_id: flow.client.client_id,
      refresh_token: reduced.refresh_token,
    });
    expect(again.scope).toBe('fleet:read');
    expect((await f.authority.verify(flow.tokens.access_token))?.scopes).toEqual(['fleet:read', 'fleet:write']);
  });

  test('checks client, redirect and verifier before spending a code', async () => {
    const f = fixture();
    const flow = await f.approved();
    const other = await f.register();
    for (const override of [
      { client_id: other.client_id },
      { redirect_uri: `${redirectUri}/` },
      { code_verifier: 'bad' },
      { code_verifier: 'w'.repeat(43) },
      { code_verifier: undefined },
    ]) {
      await expect(f.authority.exchange({ ...flow.exchange, ...override })).rejects.toMatchObject({
        error: 'invalid_grant',
      });
    }
    expect((await f.authority.exchange(flow.exchange)).access_token).toStartWith('fyc_at_');
  });

  test('code replay revokes the whole grant, even after the code expires', async () => {
    const f = fixture();
    const flow = await f.flow();
    f.advance(61_000);
    await expect(f.authority.exchange(flow.exchange)).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(await f.authority.verify(flow.tokens.access_token)).toBeUndefined();
    expect((await f.authority.grants())[0]?.revokedAt).toBeDefined();
  });

  test('authorization codes expire at 60 seconds', async () => {
    const f = fixture();
    const flow = await f.approved();
    f.advance(60_000);
    await expect(f.authority.exchange(flow.exchange)).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  test('concurrent exchanges spend a code only once and the replay revokes the first token', async () => {
    const f = fixture();
    const flow = await f.approved();
    const answers = await Promise.allSettled([
      f.authority.exchange(flow.exchange),
      f.authority.exchange(flow.exchange),
    ]);
    expect(answers.map(a => a.status)).toEqual(['fulfilled', 'rejected']);
    const first = answers[0];
    if (first?.status !== 'fulfilled') throw new Error('missing token');
    expect(await f.authority.verify(first.value.access_token)).toBeUndefined();
  });

  test('refresh rotates; a rotated token used again after the retry window revokes all access and emits the reuse audit', async () => {
    const f = fixture();
    const flow = await f.flow();
    const next = await f.authority.exchange({
      grant_type: 'refresh_token',
      client_id: flow.client.client_id,
      refresh_token: flow.tokens.refresh_token,
    });
    expect(next.refresh_token).not.toBe(flow.tokens.refresh_token);
    expect(await f.authority.verify(next.access_token)).toBeDefined();
    f.advance(61_000);
    await expect(
      f.authority.exchange({
        grant_type: 'refresh_token',
        client_id: flow.client.client_id,
        refresh_token: flow.tokens.refresh_token,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(await f.authority.verify(next.access_token)).toBeUndefined();
    expect(await f.authority.verify(flow.tokens.access_token)).toBeUndefined();
    expect(f.events).toContainEqual({ kind: 'connector.refresh.reused', grantId: flow.grant.id });
  });

  test('dead refresh values and 30-day-expired refresh return invalid_grant', async () => {
    const f = fixture();
    const flow = await f.flow();
    await expect(
      f.authority.exchange({ grant_type: 'refresh_token', client_id: flow.client.client_id, refresh_token: 'dead' }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    f.advance(30 * 86_400_000);
    await expect(
      f.authority.exchange({
        grant_type: 'refresh_token',
        client_id: flow.client.client_id,
        refresh_token: flow.tokens.refresh_token,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  test('access expires at one hour and is bound to the exact configured audience', async () => {
    const f = fixture();
    const flow = await f.flow();
    const foreign = new ConnectorAuthority({
      ...f.options,
      endpoints: { ...endpoints, resource: 'https://other.example/mcp' },
    });
    expect(await foreign.verify(flow.tokens.access_token)).toBeUndefined();
    f.advance(3_600_000);
    expect(await f.authority.verify(flow.tokens.access_token)).toBeUndefined();
  });

  test('last use is persisted at most once per minute', async () => {
    const f = fixture();
    const flow = await f.flow();
    const before = f.saves();
    await f.authority.verify(flow.tokens.access_token);
    await f.authority.verify(flow.tokens.access_token);
    f.advance(59_999);
    await f.authority.verify(flow.tokens.access_token);
    await f.memory.idle();
    expect(f.saves()).toBe(before + 1);
    f.advance(1);
    await f.authority.verify(flow.tokens.access_token);
    await f.memory.idle();
    expect(f.saves()).toBe(before + 2);
  });

  test('revocation immediately refuses access and refresh; revoking again succeeds', async () => {
    const f = fixture();
    const flow = await f.flow();
    expect((await f.authority.revoke(flow.grant.id, 'admin-cli')).ok).toBe(true);
    expect((await f.authority.revoke(flow.grant.id, 'admin-cli')).ok).toBe(true);
    expect(await f.authority.verify(flow.tokens.access_token)).toBeUndefined();
    await expect(
      f.authority.exchange({
        grant_type: 'refresh_token',
        client_id: flow.client.client_id,
        refresh_token: flow.tokens.refresh_token,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  test('RFC7009 ignores unknown tokens, restricts revocation to the authenticated client', async () => {
    const f = fixture();
    const flow = await f.flow();
    const other = await f.register();
    await f.authority.revokeToken({ client_id: other.client_id, token: flow.tokens.access_token });
    expect(await f.authority.verify(flow.tokens.access_token)).toBeDefined();
    await f.authority.revokeToken({ client_id: flow.client.client_id, token: 'unknown' });
    await f.authority.revokeToken({ client_id: flow.client.client_id, token: flow.tokens.refresh_token ?? '' });
    expect(await f.authority.verify(flow.tokens.access_token)).toBeUndefined();
  });

  test('expired sign-ins can no longer be approved or redirected, and free their place', async () => {
    const f = fixture();
    const client = await f.register();
    const handles = [await f.authorize(client.client_id), await f.authorize(client.client_id)];
    f.advance(600_000);
    expect(
      await f.authority.approve((await f.options.memory.pending.values().next().value)?.view.id ?? '', 'admin-cli'),
    ).toMatchObject({ ok: false, code: 'expired' });
    expect(await f.authority.pending()).toEqual([]);
    for (const handle of handles) await expect(f.authority.waitPage(handle)).rejects.toBeInstanceOf(OAuthError);
    expect(await f.authorize(client.client_id)).toHaveLength(43);
  });

  test('match code omits ambiguous symbols; approval accepts lowercase without hyphen', async () => {
    const f = fixture();
    const client = await f.register();
    await f.authorize(client.client_id);
    const pending = (await f.authority.pending())[0];
    expect(pending?.id).toMatch(/^cr_[a-z2-7]{10}$/);
    expect(pending?.matchCode).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    expect((await f.authority.approve(pending?.matchCode.toLowerCase().replace('-', '') ?? '', 'device:test')).ok).toBe(
      true,
    );
    expect(await f.authority.deny(pending?.id ?? '', 'admin-cli')).toMatchObject({ code: 'already_decided' });
  });

  test('denial redirects with state and issuer, preserving an existing query', async () => {
    const f = fixture();
    const client = await f.register({ redirect_uris: [`${redirectUri}?existing=1`] });
    const handle = await f.authorize(client.client_id, {
      redirect_uri: `${redirectUri}?existing=1`,
      state: 'state&value',
    });
    const pending = (await f.authority.pending())[0];
    await f.authority.deny(pending?.matchCode ?? '', 'admin-cli');
    const result = await f.authority.waitPage(handle);
    if (result.kind !== 'redirect') throw new Error('missing redirect');
    const url = new URL(result.location);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      existing: '1',
      state: 'state&value',
      iss: endpoints.issuer,
      error: 'access_denied',
    });
    expect(f.events.some(event => event.kind === 'connector.grant.denied')).toBe(true);
    await expect(f.authority.waitPage(handle)).rejects.toMatchObject({ error: 'invalid_request' });
  });

  test('approval redirect preserves state and consumes the handle', async () => {
    const f = fixture();
    const client = await f.register({ redirect_uris: [`${redirectUri}?existing=1`] });
    const handle = await f.authorize(client.client_id, {
      redirect_uri: `${redirectUri}?existing=1`,
      state: 'state&value',
    });
    await f.authority.approve((await f.authority.pending())[0]?.id ?? '', 'admin-cli');
    const result = await f.authority.waitPage(handle);
    if (result.kind !== 'redirect') throw new Error('missing redirect');
    const url = new URL(result.location);
    expect(url.searchParams.get('existing')).toBe('1');
    expect(url.searchParams.get('state')).toBe('state&value');
    expect(url.searchParams.get('iss')).toBe(endpoints.issuer);
    expect(url.searchParams.get('code')).toHaveLength(43);
    await expect(f.authority.waitPage(handle)).rejects.toMatchObject({ error: 'invalid_request' });
  });

  test('a restart drops pending requests and codes but keeps digest-backed tokens', async () => {
    const f = fixture();
    const flow = await f.flow();
    const another = await f.approved();
    const restarted = new ConnectorAuthority({ ...f.options, memory: new ConnectorMemory() });
    expect(await restarted.pending()).toEqual([]);
    await expect(restarted.exchange(another.exchange)).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(await restarted.verify(flow.tokens.access_token)).toBeDefined();
  });

  test.each(['client_secret_post', 'client_secret_basic'] as const)(
    'authenticates %s with only a secret digest',
    async method => {
      const f = fixture();
      const flow = await f.approved({ token_endpoint_auth_method: method });
      expect(f.state().clients[0]?.secretDigest).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        f.authority.exchange({ ...flow.exchange, authMethod: method, client_secret: 'wrong' }),
      ).rejects.toMatchObject({ error: 'invalid_client' });
      await expect(
        f.authority.exchange({ ...flow.exchange, authMethod: 'none', client_secret: undefined }),
      ).rejects.toMatchObject({ error: 'invalid_client' });
      await expect(
        f.authority.exchange({
          ...flow.exchange,
          authMethod: method === 'client_secret_basic' ? 'client_secret_post' : 'client_secret_basic',
        }),
      ).rejects.toMatchObject({ error: 'invalid_client' });
      expect((await f.authority.exchange({ ...flow.exchange, authMethod: method })).access_token).toStartWith(
        'fyc_at_',
      );
    },
  );

  test('public clients default to none and reject an attempted secret method', async () => {
    const f = fixture();
    const flow = await f.approved();
    expect(flow.client.client_secret).toBeUndefined();
    expect(flow.client.token_endpoint_auth_method).toBe('none');
    await expect(f.authority.exchange({ ...flow.exchange, client_secret: 'unrequested' })).rejects.toMatchObject({
      error: 'invalid_client',
    });
  });

  test('registered grant types govern authorization and refresh issuance', async () => {
    const f = fixture();
    const refreshOnly = await f.register({ grant_types: ['refresh_token'] });
    await expect(f.authorize(refreshOnly.client_id)).rejects.toMatchObject({ error: 'unauthorized_client' });
    const flow = await f.approved({ grant_types: ['authorization_code'] });
    expect((await f.authority.exchange(flow.exchange)).refresh_token).toBeUndefined();
  });

  test('client names have control characters removed before presentation or audit', async () => {
    const f = fixture();
    const client = await f.register({ client_name: 'My\nClient\u0000' });
    expect(client.client_name).toBe('MyClient');
    expect(f.events[0]).toMatchObject({ clientName: 'MyClient' });
  });

  test('DCR admits 10 registrations per hour per source', async () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) await f.register();
    await expect(f.register()).rejects.toMatchObject({ status: 429, retryAfter: 3600 });
    await f.authority.register({ redirect_uris: [redirectUri] }, { source: '198.51.100.7' });
    f.advance(3_600_000);
    await f.register();
  });

  test('pruning keeps an older client with a live refresh grant', async () => {
    const f = fixture();
    const flow = await f.flow();
    f.advance(25 * 3_600_000);
    await f.register();
    expect(f.state().clients.some(c => c.id === flow.client.client_id)).toBe(true);
  });

  test('pruning retains an older client whose approved code is still redeemable', async () => {
    const f = fixture();
    const client = await f.register();
    f.advance(25 * 3_600_000);
    const handle = await f.authorize(client.client_id);
    await f.authority.approve((await f.authority.pending())[0]?.id ?? '', 'admin-cli');
    const waiting = await f.authority.waitPage(handle);
    if (waiting.kind !== 'redirect') throw new Error('missing code');
    await f.register();
    expect(f.state().clients.some(c => c.id === client.client_id)).toBe(true);
    const answer = await f.authority.exchange({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: new URL(waiting.location).searchParams.get('code') ?? '',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(await f.authority.verify(answer.access_token)).toBeDefined();
  });

  test('authorize admits 20 per source per minute, and a rejected request still spends it', async () => {
    const f = fixture();
    for (let i = 0; i < 20; i++)
      await expect(f.authorize('unknown')).rejects.toMatchObject({ error: 'invalid_request' });
    await expect(f.authorize('unknown')).rejects.toMatchObject({ status: 429 });
    f.advance(60_000);
    await expect(f.authorize('unknown')).rejects.toMatchObject({ error: 'invalid_request' });
  });

  test('unreadable storage fails closed on a cold start; malformed access tokens never throw', async () => {
    const f = fixture();
    const flow = await f.flow();
    f.breakStore();
    const cold = new ConnectorAuthority({ ...f.options, memory: new ConnectorMemory() });
    expect(await cold.verify(flow.tokens.access_token)).toBeUndefined();
    await expect(
      cold.startAuthorization({ response_type: 'code', client_id: 'x', redirect_uri: redirectUri }),
    ).rejects.toThrow();
    for (const token of ['', 'anything', 'fyc_at_short', `fyc_rt_${verifier}`])
      expect(await f.authority.verify(token)).toBeUndefined();
  });
});

describe('connector authority — edges of the sign-in flow', () => {
  test('a failing audit sink never stops a sign-in being approved', async () => {
    const f = fixture();
    const authority = new ConnectorAuthority({
      ...f.options,
      audit: {
        record: async () => {
          throw new Error('log unwritable');
        },
      },
    });
    const client = await authority.register({ redirect_uris: [redirectUri] });
    const challenge = (await import('../../../../src/lib/connector/oauth/model.ts')).base64url(
      await f.options.crypto.sha256(verifier),
    );
    await authority.startAuthorization({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    const pending = (await authority.pending())[0];
    const approval = await authority.approve(pending?.id ?? '', 'admin-cli');
    expect(approval.ok).toBe(true);
  });

  test('refuses any response type but code', async () => {
    const f = fixture();
    const client = await f.register();
    await expect(f.authorize(client.client_id, { response_type: 'token' })).rejects.toMatchObject({
      error: 'unsupported_response_type',
    });
  });

  test('draws a new request id and match code when the first draw is already waiting', async () => {
    const f = fixture();
    const draws: Record<number, number[]> = { 10: [5, 1, 1, 2], 6: [1, 1, 2] };
    let unique = 0;
    const authority = new ConnectorAuthority({
      ...f.options,
      crypto: {
        sha256: f.options.crypto.sha256,
        randomBytes: length => {
          const queued = draws[length]?.shift();
          if (queued !== undefined) return new Uint8Array(length).fill(queued);
          unique += 1;
          return Uint8Array.from({ length }, (_, index) => (unique * 7 + index) % 251);
        },
      },
    });
    const client = await authority.register({ redirect_uris: [redirectUri] });
    const { base64url } = await import('../../../../src/lib/connector/oauth/model.ts');
    const challenge = base64url(await f.options.crypto.sha256(verifier));
    const ask = () =>
      authority.startAuthorization({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge_method: 'S256',
        code_challenge: challenge,
      });
    await ask();
    await ask();
    const waiting = await authority.pending();
    expect(waiting).toHaveLength(2);
    expect(new Set(waiting.map(p => p.id)).size).toBe(2);
    expect(new Set(waiting.map(p => p.matchCode)).size).toBe(2);
  });

  test('a day-old client with nothing live is dropped to make room, while another sign-in is waiting', async () => {
    const f = fixture();
    await f.register();
    f.advance(25 * 3_600_000);
    const fresh = await f.register();
    await f.authorize(fresh.client_id);
    await f.register();
    const stored = f.state().clients.map(client => client.id);
    expect(stored).toContain(fresh.client_id);
    expect(stored).toHaveLength(2);
  });

  test('cannot deny a sign-in that expired while it waited', async () => {
    const f = fixture();
    const client = await f.register();
    await f.authorize(client.client_id);
    const pending = (await f.authority.pending())[0];
    f.advance(11 * 60_000);
    expect(await f.authority.deny(pending?.id ?? '', 'admin-cli')).toMatchObject({ ok: false });
  });

  test('cannot revoke a grant that does not exist', async () => {
    const f = fixture();
    expect(await f.authority.revoke('cg_nonexistent', 'admin-cli')).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  test('refuses a token request for a grant type the client was not registered for', async () => {
    const f = fixture();
    const refreshOnly = await f.register({ grant_types: ['refresh_token'] });
    await expect(
      f.authority.exchange({
        grant_type: 'authorization_code',
        client_id: refreshOnly.client_id,
        code: 'a-code',
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    ).rejects.toMatchObject({ error: 'unauthorized_client' });
    const codeOnly = await f.register({ grant_types: ['authorization_code'] });
    await expect(
      f.authority.exchange({ grant_type: 'refresh_token', client_id: codeOnly.client_id, refresh_token: 'fyc_rt_x' }),
    ).rejects.toMatchObject({ error: 'unauthorized_client' });
  });
});

describe('connector authority — client metadata', () => {
  test('registers only clients that use the code response type', async () => {
    const f = fixture();
    await expect(f.register({ response_types: ['token'] })).rejects.toMatchObject({
      error: 'invalid_client_metadata',
    });
    await expect(f.register({ response_types: ['code', 'token'] })).rejects.toMatchObject({
      error: 'invalid_client_metadata',
    });
    expect((await f.register({ response_types: ['code'] })).client_id).toStartWith('fycl_');
  });
});
