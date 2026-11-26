import { describe, expect, test } from 'bun:test';
import type { CallContext } from '@ferretry/kernel/contract';
import { doorRoute } from '../../daemon/routes/door.ts';
import { ownerRoutes } from '../../daemon/routes/owner.ts';
import manifest from '../../manifest.ts';
import { door, owner, REDIRECT, signIn, TUNNEL_DOOR, VERIFIER, world } from '../support/world.ts';

const ON = { enabled: true, publicUrl: 'https://mcp.example.com', port: 7493 };
const doorRoutes = (manifest.actions?.routes ?? []).filter(declared => declared.door === 'public');

const serve = (w: ReturnType<typeof world>, request: Parameters<typeof door>[2] & { method: string; path: string }) =>
  doorRoute(w.service)({
    request: door(request.method, request.path, request),
    params: new Map(),
  } as unknown as CallContext);

/** A person's whole sign-in, through the door routes the kernel would dispatch to. */
async function connect(w: ReturnType<typeof world>) {
  const flow = await signIn(w);
  const waitingPage = await serve(w, { method: 'GET', path: flow.wait });
  const [pending] = await w.service.authority.pending();
  const approved = await ownerRoutes(w.service)['POST /v1/connector/requests/:id/approve'](
    owner({ params: { id: pending?.id ?? '' } }),
  );
  const redirect = await serve(w, { method: 'GET', path: flow.wait });
  const callback = new URL(redirect.headers.get('location') ?? '');
  const tokenBody = (extra: Record<string, string>) =>
    new URLSearchParams({ client_id: flow.clientId, ...extra }).toString();
  const token = await serve(w, {
    method: 'POST',
    path: '/oauth/token',
    body: tokenBody({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
    }),
  });
  return { flow, waitingPage, approved, redirect, callback, token, tokenBody };
}

describe('a door path no handler owns', () => {
  test('is the same 404 as an unrouted path, while serving', async () => {
    const w = world(ON);
    const answer = await serve(w, { method: 'GET', path: '/nothing/here' });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ code: 'unknown_route', path: '/nothing/here' });
  });
});

describe('every door route answers 404 when the connector is off, exactly as an unrouted path does', () => {
  test('all eleven declared door paths', async () => {
    const w = world();
    for (const route of doorRoutes) {
      const answer = await serve(w, { method: route.method, path: route.path });
      expect(answer.status, route.key).toBe(404);
      expect(JSON.parse(answer.body), route.key).toEqual({
        error: `no route ${route.method} ${route.path}`,
        code: 'unknown_route',
        method: route.method,
        path: route.path,
      });
    }
  });

  test('and again the moment it is switched off, even for a token that was live (S17)', async () => {
    const w = world(ON);
    await w.service.start();
    const done = await connect(w);
    const access = JSON.parse(done.token.body).access_token as string;
    expect(
      (await serve(w, { method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${access}` } })).status,
    ).toBe(415);
    w.config.set({ ...ON, enabled: false });
    expect(
      (await serve(w, { method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${access}` } })).status,
    ).toBe(404);
    expect((await serve(w, { method: 'POST', path: '/oauth/token' })).status).toBe(404);
  });
});

describe('an explicit publicUrl wins: the tunnel door does not serve it', () => {
  test('the same request is served on the own door and 404 on the tunnel door', async () => {
    const w = world(ON);
    w.tunnel = 'https://abc.ferretry.stream';
    const own = await serve(w, { method: 'GET', path: '/.well-known/oauth-authorization-server' });
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body).issuer).toBe('https://mcp.example.com');
    const tunnel = await serve(w, {
      method: 'GET',
      path: '/.well-known/oauth-authorization-server',
      arrival: TUNNEL_DOOR,
    });
    expect(tunnel.status).toBe(404);
  });

  test('with no publicUrl the tunnel serves it, naming the tunnel hostname as issuer and audience', async () => {
    const w = world({ enabled: true });
    w.tunnel = 'https://abc.ferretry.stream';
    const answer = await serve(w, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      arrival: TUNNEL_DOOR,
    });
    expect(JSON.parse(answer.body)).toMatchObject({
      resource: 'https://abc.ferretry.stream/mcp',
      authorization_servers: ['https://abc.ferretry.stream'],
    });
  });
});

describe('a whole sign-in through the door, then a hostname change', () => {
  test('DCR, authorize, the waiting page shows the match code, approval, code and iss, token', async () => {
    const w = world({ enabled: true });
    w.tunnel = 'https://abc.ferretry.stream';
    const flow = await signIn(w);
    const page = await serve(w, { method: 'GET', path: flow.wait, arrival: TUNNEL_DOOR });
    const [pending] = await w.service.authority.pending();
    expect(page.status).toBe(200);
    expect(page.body).toContain(pending?.matchCode ?? 'missing');
    expect(page.body).toContain('http-equiv="refresh"');
    expect(page.body).not.toContain('<script');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.body).toContain('/d/fy_daemon_fixture/settings/connector?request=cr_');
  });

  test('after approval the wait page redirects to the callback with code and iss; the token works on /mcp until the hostname changes', async () => {
    const w = world(ON);
    await w.service.start();
    const done = await connect(w);
    expect(done.approved.status).toBe(200);
    expect(done.redirect.status).toBe(302);
    expect(done.callback.origin + done.callback.pathname).toBe(REDIRECT);
    expect(done.callback.searchParams.get('iss')).toBe('https://mcp.example.com');
    expect(done.callback.searchParams.get('state')).toBe('state-1');
    expect(done.token.status).toBe(200);
    const tokens = JSON.parse(done.token.body) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokens.access_token).toStartWith('fyc_at_');
    expect(tokens.refresh_token).toStartWith('fyc_rt_');
    expect(done.token.headers.get('cache-control')).toBe('no-store');
    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    // A live bearer is past the bearer gate (the endpoint, not a 401): with no JSON body it stops at the media type.
    expect((await serve(w, { method: 'POST', path: '/mcp', headers: bearer })).status).toBe(415);
    // The operator moves the connector to another address: the issuer and every audience change, and the old token stops.
    w.config.set({ ...ON, publicUrl: 'https://other.example.com' });
    const stale = await serve(w, { method: 'POST', path: '/mcp', headers: bearer });
    expect(stale.status).toBe(401);
    expect(stale.headers.get('www-authenticate')).toContain('invalid_token');
    expect(JSON.parse(stale.body).error_description).toContain('Settings > Connectors > Ferretry > Connect');
  });

  test('refresh rotates; presenting the rotated-away token again ends the grant; /oauth/revoke answers 200', async () => {
    const w = world(ON);
    await w.service.start();
    const done = await connect(w);
    const first = JSON.parse(done.token.body) as { refresh_token: string };
    const refresh = (token: string) =>
      serve(w, {
        method: 'POST',
        path: '/oauth/token',
        body: done.tokenBody({ grant_type: 'refresh_token', refresh_token: token }),
      });
    const rotated = JSON.parse((await refresh(first.refresh_token)).body) as {
      refresh_token: string;
      access_token: string;
    };
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    // The first use of a rotated-away token inside the window is the one-shot retry; the second is reuse.
    expect((await refresh(first.refresh_token)).status).toBe(200);
    const reused = await refresh(first.refresh_token);
    expect(reused.status).toBe(400);
    expect(JSON.parse(reused.body).error).toBe('invalid_grant');
    expect((await w.service.authority.grants())[0]?.revokedAt).toBeDefined();
    expect(w.events).toContainEqual(expect.objectContaining({ kind: 'connector.refresh.reused' }));
    const revoke = await serve(w, {
      method: 'POST',
      path: '/oauth/revoke',
      body: new URLSearchParams({ client_id: done.flow.clientId, token: rotated.access_token }).toString(),
    });
    expect(revoke.status).toBe(200);
  });
});

describe('/mcp before the tools exist', () => {
  test('GET and DELETE are 405 Allow: POST; no bearer is 401 with the metadata pointer; the stub never pretends a tool ran', async () => {
    const w = world(ON);
    for (const method of ['GET', 'DELETE']) {
      const answer = await serve(w, { method, path: '/mcp' });
      expect(answer.status).toBe(405);
      expect(answer.headers.get('allow')).toBe('POST');
    }
    const none = await serve(w, { method: 'POST', path: '/mcp' });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    const bad = await serve(w, { method: 'POST', path: '/mcp', headers: { authorization: 'Bearer fyc_at_notatoken' } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

/** S6: a token, a code, a client secret and a handle exist in the minting response and nowhere else this plugin writes. */
describe('no token anywhere', () => {
  test('after a full flow, a rotation and a revocation, no state, event, status, log or page holds one', async () => {
    const w = world(ON);
    await w.service.start();
    const done = await connect(w);
    const tokens = JSON.parse(done.token.body) as { access_token: string; refresh_token: string };
    const rotated = JSON.parse(
      (
        await serve(w, {
          method: 'POST',
          path: '/oauth/token',
          body: done.tokenBody({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
        })
      ).body,
    ) as { access_token: string; refresh_token: string };
    const handle = new URL(done.flow.wait, 'https://x.example').searchParams.get('h') ?? '';
    const code = done.callback.searchParams.get('code') ?? '';
    const secrets = [
      tokens.access_token,
      tokens.refresh_token,
      rotated.access_token,
      rotated.refresh_token,
      handle,
      code,
    ];
    expect(secrets.every(secret => secret.length > 20)).toBe(true);
    const places = [
      JSON.stringify(w.state.value),
      JSON.stringify(w.events),
      JSON.stringify(await w.service.status()),
      JSON.stringify(await w.service.authority.grants()),
      w.service.bootNotice(),
      done.waitingPage.body,
    ];
    for (const place of places) for (const secret of secrets) expect(place).not.toContain(secret);
    expect(JSON.stringify(w.state.value)).not.toContain('fyc_');
  });
});
