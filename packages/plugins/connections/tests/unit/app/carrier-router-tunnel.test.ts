/**
 * The tunnel in the browser's carrier walk (`docs/relay-protocol.md` §15 "The choice"): a kept tunnel is dialled first
 * and never twice (R635), and under "Tunnel only" a tunnel the browser lost is ASKED for, once per 30 s, over an
 * introducer (R636).
 *
 * Ported from v4's `pwa/tests/unit/relay-carrier-preference.test.ts` (the "Tunnel only" lookup cases) onto the 5.0 walk:
 * the real shell `connector`, sealed sessions and the real kernel session layer; only the network and the clock are
 * scripted. The lookup question travels the shell's carrier-control lane, exactly as the production half sends it.
 */
import { describe, expect, test } from 'bun:test';
import { jsonResponse } from '@ferretry/kernel/contract';
import { TUNNEL_LOOKUP_REUSE_MS } from '../../../app/carriers/router.ts';
import type { IntroducerRequest } from '../../../app/lib/introducers.ts';
import { TUNNEL_NOT_YET, TUNNEL_SWITCHED_OFF } from '../../../app/lib/tunnel-service.ts';
import type { TunnelCarrier } from '../../../app/lib/tunnel-switch.ts';
import { TUNNEL_OFF_SENTENCE, type TunnelStatusView } from '../../../contract/index.ts';
import type { ScriptedHost } from '../../support/browser-network.ts';
import { carriedOver, type Rig, rig } from '../../support/router-rig.ts';

const DIRECT = 'https://laptop.example.test';
const DIRECT_HOST = new URL(DIRECT).host;
const RELAY = 'wss://relay.example';
const RELAY_HOST = new URL(RELAY).host;
const TUNNEL_URL = 'https://abc.tunnel.example';
const TUNNEL_HOST = new URL(TUNNEL_URL).host;
const MOVED_URL = 'https://n3w.tunnel.example';
const MOVED_HOST = new URL(MOVED_URL).host;
const PUBLISHED_TUNNEL = { kind: 'tunnel', url: TUNNEL_URL } as const;
const PUBLISHED_RELAY = { kind: 'relay', url: RELAY } as const;

const upAt = (tunnelUrl: string): TunnelStatusView => ({
  enabled: true,
  explicit: true,
  state: 'up',
  tunnelUrl,
  sentence: `Tunnel: on — ${tunnelUrl}`,
});
const OFF: TunnelStatusView = {
  enabled: false,
  explicit: false,
  state: 'off',
  tunnelUrl: null,
  sentence: TUNNEL_OFF_SENTENCE,
};

interface Scenario {
  readonly hosts: Record<string, ScriptedHost>;
  readonly published?: readonly unknown[];
  /** What the daemon answers `GET /v1/tunnel` with; absent answers 503. */
  readonly status?: TunnelStatusView;
  readonly service?: 'available' | 'unavailable';
  readonly switchedOff?: boolean;
  readonly now?: () => number;
  /** No half of Connections holds a client for this machine yet. */
  readonly noClient?: boolean;
}

/** A "Tunnel only" device whose lookups travel the real control lane, and a record of what it asked and learned. */
async function tunnelOnly(scenario: Scenario) {
  const asked: string[] = [];
  const learned: Array<{ readonly daemonId: string; readonly tunnel: TunnelCarrier }> = [];
  let transport: Awaited<ReturnType<Rig['connect']>>;
  const introduce: IntroducerRequest = async (path, init) => {
    asked.push(`${init?.method ?? 'GET'} ${path}`);
    if (transport === undefined) throw new Error('no client holds this machine yet');
    const answer = await transport.request({ method: init?.method ?? 'GET', path });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const r = await rig(scenario.hosts, scenario.published ?? [], 'tunnel', null, undefined, fx => {
    const echo = fx.route;
    fx.route = async request =>
      request.path === '/v1/tunnel'
        ? scenario.status === undefined
          ? jsonResponse({ error: 'unavailable' }, 503)
          : jsonResponse(scenario.status)
        : await echo(request);
    return {
      introduce: () => (scenario.noClient === true ? undefined : introduce),
      learned: (daemonId, tunnel) => void learned.push({ daemonId, tunnel }),
      tunnelService: async () => scenario.service ?? 'unavailable',
      tunnelSwitchedOff: () => scenario.switchedOff === true,
      ...(scenario.now === undefined ? {} : { now: scenario.now }),
    };
  });
  const connected = await r.connect();
  if (connected === undefined) throw new Error('no transport');
  transport = connected;
  const request = async (path = '/v1/projects') => await connected.request({ method: 'GET', path });
  const failure = async (path = '/v1/projects'): Promise<string> => {
    const reason = await request(path).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(reason instanceof Error)) throw new Error('the request was carried, so it did not fail');
    return reason.message;
  };
  const dialledHosts = (): readonly string[] => r.network.dialled.map(url => new URL(url).host);
  return { r, asked, learned, request, failure, dialledHosts };
}

describe('R635 a kept tunnel is dialled first, and only once', () => {
  test('R635 the tunnel the stored set keeps carries the request with no question asked of the daemon', async () => {
    const t = await tunnelOnly({
      hosts: {
        [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' },
        [TUNNEL_HOST]: { kind: 'carries', carrier: 'tunnel' },
        [RELAY_HOST]: { kind: 'carries', carrier: 'relay' },
      },
      published: [PUBLISHED_TUNNEL, PUBLISHED_RELAY],
      status: upAt(TUNNEL_URL),
    });

    const answer = await t.request();

    // Only the kept tunnel was dialled: a lookup never holds up a connect that a cached address can make.
    expect(answer.status).toBe(200);
    expect(t.dialledHosts()).toEqual([TUNNEL_HOST]);
    expect(t.asked).toEqual([]);
    expect(t.learned).toEqual([]);
    expect(carriedOver(t.r.fx)).toEqual(['/v1/projects tunnel']);
    t.r.fx.layer.close();
  });

  test('R635 a kept tunnel that did not answer is not dialled a second time when the daemon names the same one', async () => {
    const t = await tunnelOnly({
      hosts: { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' } },
      published: [PUBLISHED_TUNNEL],
      status: upAt(TUNNEL_URL),
      service: 'available',
    });

    const reason = await t.failure();

    expect(reason).toContain('No configured connection worked: Cloudflare tunnel was not reachable');
    // The kept tunnel was tried once, then the daemon was asked and named the same hostname: nothing new to dial.
    expect(t.dialledHosts().filter(host => host === TUNNEL_HOST)).toHaveLength(1);
    expect(t.asked).toEqual(['GET /v1/tunnel']);
    expect(t.learned).toEqual([]);
    t.r.fx.layer.close();
  });
});

describe('R636 tunnel lookup: one question over an introducer, answered for 30 s', () => {
  test('R636 a tunnel the browser lost is asked for over the relay, then the request is carried on the tunnel', async () => {
    const t = await tunnelOnly({
      hosts: {
        [DIRECT_HOST]: { kind: 'dead' },
        [RELAY_HOST]: { kind: 'carries', carrier: 'relay' },
        [TUNNEL_HOST]: { kind: 'carries', carrier: 'tunnel' },
      },
      published: [PUBLISHED_RELAY],
      status: upAt(TUNNEL_URL),
      service: 'available',
    });

    const answer = await t.request();

    // The introducer carried the question (the relay, since direct is down) and nothing else; the tunnel carried the request.
    expect(answer.status).toBe(200);
    expect(carriedOver(t.r.fx)).toEqual(['/v1/tunnel relay', '/v1/projects tunnel']);
    expect(t.asked).toEqual(['GET /v1/tunnel']);
    expect(t.learned.map(entry => entry.tunnel)).toEqual([{ kind: 'tunnel', tunnelUrl: TUNNEL_URL }]);
    expect(t.r.router.choice(t.r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'tunnel' } });
    t.r.fx.layer.close();
  });

  test('R636 the question never rides the tunnel it asks about, or any carrier that is not an introducer', async () => {
    const t = await tunnelOnly({
      hosts: {
        [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' },
        [TUNNEL_HOST]: { kind: 'carries', carrier: 'tunnel' },
      },
      published: [],
      status: upAt(TUNNEL_URL),
    });

    await t.request();

    expect(carriedOver(t.r.fx)).toEqual(['/v1/tunnel direct', '/v1/projects tunnel']);
    t.r.fx.layer.close();
  });

  test('R636 a hostname re-provisioned since is followed when the one it kept no longer answers', async () => {
    const t = await tunnelOnly({
      hosts: {
        [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' },
        [RELAY_HOST]: { kind: 'carries', carrier: 'relay' },
        [MOVED_HOST]: { kind: 'carries', carrier: 'tunnel' },
      },
      published: [PUBLISHED_TUNNEL, PUBLISHED_RELAY],
      status: upAt(MOVED_URL),
    });

    const answer = await t.request();

    expect(answer.status).toBe(200);
    expect(t.dialledHosts().filter(host => host === TUNNEL_HOST)).toHaveLength(1);
    expect(t.dialledHosts().filter(host => host === MOVED_HOST)).toHaveLength(1);
    expect(t.learned.map(entry => entry.tunnel.tunnelUrl)).toEqual([MOVED_URL]);
    expect(t.r.router.choice(t.r.fx.daemonId)?.ok).toBe(true);
    t.r.fx.layer.close();
  });

  test('R636 the answer stands for 30 s however many walks need it, and is asked again after', async () => {
    let clock = 1_000;
    const t = await tunnelOnly({
      hosts: { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' } },
      status: OFF,
      service: 'available',
      now: () => clock,
    });

    await t.failure();
    await t.failure();
    expect(t.asked).toEqual(['GET /v1/tunnel']);

    clock += TUNNEL_LOOKUP_REUSE_MS;
    await t.failure();
    expect(t.asked).toEqual(['GET /v1/tunnel', 'GET /v1/tunnel']);
    t.r.fx.layer.close();
  });

  test('R636 an answer that is not a tunnel status finds nothing, keeps nothing, and the walk says so', async () => {
    const refused = await tunnelOnly({
      hosts: { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' } },
      service: 'available',
    });
    expect(await refused.failure()).toContain(`Tunnel only: ${TUNNEL_NOT_YET}.`);
    expect(refused.learned).toEqual([]);
    refused.r.fx.layer.close();

    // A tunnel that is not up yet (provisioning) is no hostname to dial either.
    const coming = await tunnelOnly({
      hosts: { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' } },
      status: { ...upAt(TUNNEL_URL), state: 'provisioning', tunnelUrl: null },
      service: 'available',
    });
    expect(await coming.failure()).toContain(`Tunnel only: ${TUNNEL_NOT_YET}.`);
    expect(coming.learned).toEqual([]);
    coming.r.fx.layer.close();
  });

  test('R636 a machine that switched its tunnel off is named before the service is, and nothing is dialled for it', async () => {
    const t = await tunnelOnly({
      hosts: { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' } },
      status: OFF,
      service: 'available',
      switchedOff: true,
    });

    expect(await t.failure()).toContain(`Tunnel only: ${TUNNEL_SWITCHED_OFF}.`);
    expect(t.dialledHosts().filter(host => host === TUNNEL_HOST)).toEqual([]);
    t.r.fx.layer.close();
  });

  test('R636 with no client holding the machine yet nothing is asked, and the walk says why there is no tunnel', async () => {
    const t = await tunnelOnly({
      hosts: { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' } },
      status: upAt(TUNNEL_URL),
      service: 'available',
      noClient: true,
    });

    expect(await t.failure()).toContain(`Tunnel only: ${TUNNEL_NOT_YET}.`);
    expect(t.asked).toEqual([]);
    expect(t.dialledHosts().filter(host => host === TUNNEL_HOST)).toEqual([]);
    t.r.fx.layer.close();
  });
});
