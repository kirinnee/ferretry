import { describe, expect, test } from 'bun:test';
import { doorPeer } from '../../daemon/lib/peer.ts';
import { door, OWN_DOOR, signIn, TUNNEL_DOOR, world } from '../support/world.ts';

/** S1/S2/S3/S4/S17: whether the connector is on, where it is served, and who may see it. */
describe('which arrivals the connector serves', () => {
  test('off by default: no door answers, and the status says why', async () => {
    const w = world();
    expect(w.service.serving({ arrival: OWN_DOOR })).toBe(false);
    expect(w.service.serving({ arrival: TUNNEL_DOOR })).toBe(false);
    expect(await w.service.status()).toMatchObject({ enabled: false, switchedOn: false, pending: [], grants: [] });
  });

  test('an own address is served on its own door only; the tunnel never serves it (explicit publicUrl wins)', async () => {
    const w = world({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7481 });
    expect(w.service.serving({ arrival: OWN_DOOR })).toBe(true);
    expect(w.service.serving({ arrival: TUNNEL_DOOR })).toBe(false);
    w.tunnel = 'https://abc.ferretry.stream';
    expect(w.service.serving({ arrival: TUNNEL_DOOR })).toBe(false);
    expect(w.service.endpoints.issuer).toBe('https://mcp.example.com');
  });

  test('with no publicUrl the issuer is the tunnel hostname: served on the tunnel only once it has one', async () => {
    const w = world({ enabled: true });
    expect(w.service.serving({ arrival: TUNNEL_DOOR })).toBe(false);
    expect(await w.service.status()).toMatchObject({ enabled: false, switchedOn: true });
    expect((await w.service.status()).disabledReason).toContain('waiting for this machine');
    w.tunnel = 'https://abc.ferretry.stream';
    expect(w.service.serving({ arrival: TUNNEL_DOOR })).toBe(true);
    expect(w.service.serving({ arrival: OWN_DOOR })).toBe(false);
    expect(await w.service.status()).toMatchObject({
      enabled: true,
      switchedOn: true,
      publicUrlSource: 'tunnel',
      publicUrl: 'https://abc.ferretry.stream',
      mcpUrl: 'https://abc.ferretry.stream/mcp',
    });
  });

  test('a hostname change changes the issuer and the audience, so a token minted for the old one is refused', async () => {
    const w = world({ enabled: true });
    w.tunnel = 'https://old.ferretry.stream';
    const first = w.service.endpoints.resource;
    expect(first).toBe('https://old.ferretry.stream/mcp');
    // A live token for the old audience (minted through the real flow below in the e2e): here, the audience is the thing that moved.
    w.tunnel = 'https://new.ferretry.stream';
    expect(w.service.endpoints.issuer).toBe('https://new.ferretry.stream');
    expect(w.service.endpoints.resource).toBe('https://new.ferretry.stream/mcp');
    expect(w.service.endpoints.resourceMetadataUrl).toBe(
      'https://new.ferretry.stream/.well-known/oauth-protected-resource/mcp',
    );
  });

  test('a request that is not a door arrival is never served', () => {
    const w = world({ enabled: true, publicUrl: 'https://mcp.example.com' });
    expect(w.service.serving({ arrival: { kind: 'local', privileged: false } as never })).toBe(false);
  });

  test('a config file with nothing in effect reads as off, with the file named', () => {
    const w = world();
    w.config.state = { state: 'invalid', inEffect: false, sentences: ['"publicUrl" must be https://'] };
    expect(w.service.settings()).toMatchObject({ kind: 'disabled' });
    expect((w.service.settings() as { reason: string }).reason).toContain('config/connector.yaml is not valid');
  });
});

describe('the own-address listener follows the config, live', () => {
  test('opens for an operator address while on, on its port, and closes when it goes off', async () => {
    const w = world({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7482 });
    await w.service.start();
    expect(w.opened.map(o => [o.port, o.closed])).toEqual([[7482, false]]);
    w.config.set({ enabled: false, publicUrl: 'https://mcp.example.com', port: 7482 });
    await w.service.reconcile();
    expect(w.opened[0]?.closed).toBe(true);
    await w.service.stop();
  });

  test('a changed port re-opens it live; a tunnel-only config opens nothing', async () => {
    const w = world({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7482 });
    await w.service.start();
    w.config.set({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7483 });
    await w.service.reconcile();
    expect(w.opened.map(o => [o.port, o.closed])).toEqual([
      [7482, true],
      [7483, false],
    ]);
    w.config.set({ enabled: true });
    await w.service.reconcile();
    expect(w.opened.every(o => o.closed)).toBe(true);
    await w.service.stop();
  });

  test('the config watch drives it without anyone asking', async () => {
    const w = world();
    await w.service.start();
    w.config.set({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7484 });
    await w.service.reconcile();
    expect(w.opened.map(o => o.port)).toEqual([7484]);
    await w.service.stop();
  });

  test('a port that is taken is said, and the status is waiting, not on', async () => {
    const w = world({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7485 });
    w.failOpen = 'EADDRINUSE';
    await w.service.start();
    const status = await w.service.status();
    expect(status).toMatchObject({ enabled: false, switchedOn: true });
    expect(status.disabledReason).toContain('127.0.0.1:7485');
    expect(status.disabledReason).toContain('EADDRINUSE');
  });

  test('stopping closes the listener and ends the watch', async () => {
    const w = world({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7486 });
    await w.service.start();
    await w.service.stop();
    expect(w.opened[0]?.closed).toBe(true);
  });
});

describe('the switch (PUT /v1/connector)', () => {
  test('writes ONLY enabled, records security.changed for the connector, and answers ok', async () => {
    const w = world({ publicUrl: 'https://mcp.example.com', port: 7487 });
    const result = await w.service.change({ enabled: true }, 'device:d1');
    expect(result).toEqual({ ok: true });
    expect(w.config.writes).toEqual([{ enabled: true }]);
    expect(w.events).toContainEqual({ kind: 'connector.switched', enabled: true, actor: 'device:d1' });
    expect(w.opened.map(o => o.port)).toEqual([7487]);
    expect(await w.service.change({ enabled: false }, 'device:d1')).toEqual({ ok: true });
    expect(w.config.writes).toEqual([{ enabled: true }, { enabled: false }]);
    expect(w.opened[0]?.closed).toBe(true);
  });

  test('a switch-on the config judge holds for the owner is a refusal with its sentence, and nothing opens', async () => {
    const w = world({ publicUrl: 'https://mcp.example.com', port: 7487 });
    w.config.next = { kind: 'held', etag: 'e', id: 'h1', sentences: ['Turns the Claude connector on.'] };
    const result = await w.service.change({ enabled: true }, 'device:d1');
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain('waiting for your confirmation');
    expect(w.opened).toEqual([]);
    expect(w.events).toEqual([]);
  });

  test('a taken port refuses the switch and leaves the file saying off', async () => {
    const w = world({ publicUrl: 'https://mcp.example.com', port: 7488 });
    w.failOpen = 'EADDRINUSE';
    const result = await w.service.change({ enabled: true }, 'admin-cli');
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain('127.0.0.1:7488');
    expect(w.config.writes).toEqual([{ enabled: true }, { enabled: false }]);
    expect(w.config.file?.enabled).toBe(false);
    expect(w.events).toEqual([]);
  });

  test('a damaged connector.json refuses the switch-on and the file is not written', async () => {
    const w = world();
    w.state.damaged = true;
    const result = await w.service.change({ enabled: true }, 'admin-cli');
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain('unreadable or damaged');
    expect(w.config.writes).toEqual([]);
  });

  test('an invalid config file with nothing in effect refuses the switch-on with its first sentence', async () => {
    const w = world();
    w.config.state = { state: 'invalid', inEffect: false, sentences: ['"publicUrl" is not a URL'] };
    const result = await w.service.change({ enabled: true }, 'admin-cli');
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain('"publicUrl" is not a URL');
  });

  test('a conflicting or refused write is a refusal in words', async () => {
    const w = world();
    w.config.next = { kind: 'conflict' };
    expect(((await w.service.change({ enabled: true }, 'admin-cli')) as { message: string }).message).toContain(
      'changed while',
    );
    w.config.next = { kind: 'refused', reason: 'schema', issues: [{ path: 'enabled', message: 'must be a boolean' }] };
    expect(((await w.service.change({ enabled: true }, 'admin-cli')) as { message: string }).message).toContain(
      'must be a boolean',
    );
  });

  test('while OFF, the grants that were given are still listed (so one can be revoked)', async () => {
    const w = world({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7489 });
    const flow = await signIn(w);
    expect(flow.wait).toContain('/oauth/authorize/wait');
    expect((await w.service.authority.pending()).length).toBe(1);
    const [pending] = await w.service.authority.pending();
    await w.service.authority.approve(pending?.id ?? '', 'admin-cli');
    w.config.set({ enabled: false, publicUrl: 'https://mcp.example.com', port: 7489 });
    const status = await w.service.status();
    expect(status.enabled).toBe(false);
    expect(status.grants).toHaveLength(1);
  });
});

describe('who is the rate-limit source of an own-address arrival', () => {
  test('CF-Connecting-IP only, an IPv6 address by its /64, anything else one shared bucket', () => {
    const headers = (value?: string) => new Map(value === undefined ? [] : [['cf-connecting-ip', value]]);
    expect(doorPeer(headers('203.0.113.9'))).toBe('203.0.113.9');
    expect(doorPeer(headers('2001:db8:1:2:3:4:5:6'))).toBe('2001:db8:1:2::/64');
    expect(doorPeer(headers('2001:db8:1:2:ffff::1'))).toBe('2001:db8:1:2::/64');
    expect(doorPeer(headers('::ffff:203.0.113.9'))).toBe('203.0.113.9');
    expect(doorPeer(headers('::ffff:300.1.1.1'))).toBe('door');
    expect(doorPeer(headers('not an address'))).toBe('door');
    expect(doorPeer(headers())).toBe('door');
    expect(door('GET', '/').headers.get('cf-connecting-ip')).toBeUndefined();
  });
});

describe('the redirect URIs the owner allowed apply live, and the boot notice says where it is served', () => {
  const register = async (w: ReturnType<typeof world>, redirect: string) => {
    const [oauth] = w.service.handlers;
    const answer = await oauth?.handle(
      door('POST', '/oauth/register', {
        contentType: 'application/json',
        body: JSON.stringify({
          client_name: 'Inspector',
          redirect_uris: [redirect],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    return answer?.status;
  };

  test('an extra redirect URI is accepted while on, and refused again when it leaves the file', async () => {
    const w = world({
      enabled: true,
      publicUrl: 'https://mcp.example.com',
      port: 7481,
      extraRedirectUris: ['http://localhost:6274/cb'],
    });
    expect(await register(w, 'http://localhost:6274/cb')).toBe(201);
    expect(await register(w, 'http://localhost:9999/cb')).toBe(400);
    w.config.set({ enabled: true, publicUrl: 'https://mcp.example.com', port: 7481 });
    expect(await register(w, 'http://localhost:6274/cb')).toBe(400);
  });

  test('over the tunnel the notice says so, with no listener named', () => {
    expect(world({ enabled: true }).service.bootNotice()).toBe(
      'connector on, served over the built-in tunnel once it has a hostname',
    );
  });
});
