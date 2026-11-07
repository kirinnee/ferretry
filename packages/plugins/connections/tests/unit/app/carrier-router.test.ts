/**
 * The browser carrier router (`app/carriers/router.ts`) as the shell's carrier, through the production path: the
 * shell's `connector` and sealed sessions, Connections' socket walk, and the REAL kernel session layer, with a paired
 * device the kernel admits. Only the network and the timers are scripted.
 */
import { describe, expect, test } from 'bun:test';
import { CONTROL_UNREACHABLE, type ConnectPorts, type PairedDaemon } from '@ferretry/app';
import { connector, fakeDeviceClaims, WebCryptoRelayCrypto } from '@ferretry/app/testing';
import connections from '../../../app/index.ts';
import { CarrierRouter, daemonCarriers } from '../../../app/carriers/router.ts';
import { documentRelayDiscovery } from '../../../app/discovery/hosted-relay.ts';
import type { CarrierPreference } from '../../../app/lib/carrier-preference.ts';
import { BrowserNetwork, HandTimers, type ScriptedHost } from '../../support/browser-network.ts';
import { type KernelFixture, kernelFixture } from '../../support/kernel-session.ts';

const shellCrypto = new WebCryptoRelayCrypto();
const DIRECT = 'https://laptop.example.test';
const TUNNEL = 'https://abc.tunnel.example';
const RELAY = 'wss://relay.example';

interface Rig {
  readonly fx: KernelFixture;
  readonly network: BrowserNetwork;
  readonly timers: HandTimers;
  readonly router: CarrierRouter;
  readonly daemon: PairedDaemon;
  readonly connect: () => ReturnType<ReturnType<typeof connector>>;
}

async function rig(
  hosts: Record<string, ScriptedHost>,
  carriers: readonly unknown[],
  preference: CarrierPreference = 'auto',
  hosted: string | null = null,
): Promise<Rig> {
  const fx = await kernelFixture();
  const device = await fx.paired();
  const network = new BrowserNetwork(fx, hosts);
  const timers = new HandTimers();
  const router = new CarrierRouter({
    openSocket: network.openSocket,
    after: timers.after,
    now: () => 0,
    preference: () => preference,
    hostedRelay: async () => hosted ?? undefined,
  });
  const daemon: PairedDaemon = {
    daemon: fx.daemonId,
    machine: 'laptop',
    deviceId: device.deviceId,
    address: DIRECT,
    carriers: [...carriers],
    pairedAt: 1,
    lastSelectedAt: 1,
  };
  const claims = fakeDeviceClaims({
    claims: {
      [fx.daemonId]: {
        deviceId: device.deviceId,
        key: shellCrypto.deviceKeyHandle(device.privateKey),
        appSession: device.appSession,
      },
    },
  });
  const connect = () =>
    connector({
      crypto: shellCrypto,
      claims,
      carriers: [router.dialer()],
      direct: () => {
        throw new Error('the shell’s own direct dial is not used once Connections registered a carrier');
      },
    })(daemon);
  return { fx, network, timers, router, daemon, connect };
}

const carriedOver = (fx: KernelFixture): readonly string[] =>
  fx.requests.map(
    request => `${request.path} ${request.arrival.kind === 'carried' ? request.arrival.carrier : 'local'}`,
  );

describe('carrier control (R634)', () => {
  test('R634 GET and PUT /v1/tunnel ride the direct address even under "Tunnel only", and remember no winner', async () => {
    // Arrange — the daemon publishes a tunnel, its own address and a relay; this device chose "Tunnel only".
    const r = await rig(
      {
        [new URL(TUNNEL).host]: { kind: 'carries', carrier: 'tunnel' },
        [new URL(DIRECT).host]: { kind: 'carries', carrier: 'direct' },
        [new URL(RELAY).host]: { kind: 'carries', carrier: 'relay' },
      },
      [
        { kind: 'tunnel', url: TUNNEL },
        { kind: 'direct', url: DIRECT },
        { kind: 'relay', url: RELAY },
      ],
      'tunnel',
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');

    // Act — carrier control first, then an ordinary read.
    await transport.request({ method: 'GET', path: '/v1/tunnel' });
    await transport.request({ method: 'PUT', path: '/v1/tunnel', body: { enabled: true } });
    const winnerAfterControl = r.router.choice(r.fx.daemonId);
    await transport.request({ method: 'GET', path: '/v1/carriers' });

    // Assert — control rode direct (an introducer), never the tunnel; it decided nothing; the read rode the tunnel.
    expect(carriedOver(r.fx)).toEqual(['/v1/tunnel direct', '/v1/tunnel direct', '/v1/carriers tunnel']);
    expect(winnerAfterControl).toBeUndefined();
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'tunnel' } });
    r.fx.layer.close();
  });

  test('R634 with neither a direct address nor a relay that answers, control is refused with today’s sentence', async () => {
    const r = await rig(
      { [new URL(TUNNEL).host]: { kind: 'carries', carrier: 'tunnel' } },
      [{ kind: 'tunnel', url: TUNNEL }],
      'tunnel',
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    // A published set with only a tunnel has no introducer at all: control is refused before anything is dialled.
    const failure = await transport.request({ method: 'GET', path: '/v1/tunnel' }).catch((error: unknown) => error);
    expect((failure as Error).message).toContain(CONTROL_UNREACHABLE);
    expect(r.fx.requests).toEqual([]);
    expect(r.network.dialled.some(url => url.startsWith('wss://abc.tunnel.example'))).toBe(false);
    r.fx.layer.close();
  });
});

describe('the walk', () => {
  test('a carrier that never opened sent nothing, so the next one is tried and becomes the remembered winner', async () => {
    const r = await rig(
      {
        [new URL(DIRECT).host]: { kind: 'dead' },
        [new URL(RELAY).host]: { kind: 'carries', carrier: 'relay' },
      },
      [
        { kind: 'direct', url: DIRECT },
        { kind: 'relay', url: RELAY },
      ],
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx)).toEqual(['/v1/carriers relay']);
    const choice = r.router.choice(r.fx.daemonId);
    expect(choice).toMatchObject({ ok: true, method: { kind: 'relay' } });
    expect(choice?.reason).toContain('was not reachable');
    // A second session starts from the winner: the dead direct address is not dialled again.
    const before = r.network.dialled.length;
    await transport.request({ method: 'GET', path: '/v1/carriers', headers: {} });
    expect(r.network.dialled.length).toBe(before);
    r.fx.layer.close();
  });

  test('"Relay only" (the default) walks only relays, and the hosted relay only when the daemon published none', async () => {
    const r = await rig(
      {
        [new URL(DIRECT).host]: { kind: 'carries', carrier: 'direct' },
        'hosted.example': { kind: 'carries', carrier: 'relay' },
      },
      [{ kind: 'direct', url: DIRECT }],
      'relay',
      'wss://hosted.example',
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx)).toEqual(['/v1/carriers relay']);
    expect(r.network.dialled.map(url => new URL(url).host)).toEqual(['hosted.example']);
    r.fx.layer.close();
  });

  test('a daemon that published nothing is reached at the address it was paired over; an odd fingerprint, direct only', () => {
    const daemon = {
      daemon: 'fy_daemon_x',
      machine: 'm',
      deviceId: 'd',
      address: DIRECT,
      carriers: [],
      pairedAt: 1,
      lastSelectedAt: 1,
    } as PairedDaemon;
    expect(daemonCarriers(daemon)).toEqual([{ kind: 'direct', daemonUrl: DIRECT }]);
    const odd = {
      ...daemon,
      carriers: [
        { kind: 'relay', url: RELAY },
        { kind: 'direct', url: DIRECT },
      ],
    };
    expect(daemonCarriers(odd).map(method => method.kind)).toEqual(['direct']);
  });
});

describe('hosted relay discovery (R580)', () => {
  test('R580 the relay is found from the build-time directory origin, read ONCE per document, never from the link', async () => {
    const asked: string[] = [];
    const directory: ConnectPorts['directory'] = async url => {
      asked.push(url);
      return new Response(JSON.stringify({ version: 1, relayUrl: 'wss://hosted.example' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const ports = {
      openSocket: () => {
        throw new Error('nothing dials here');
      },
      after: () => {},
      now: () => 0,
      daemons: { registerCache: () => () => {} },
      directory,
    } as unknown as ConnectPorts;
    // The shell builds both of Connections' parts from the same ports: one read serves the router and the walk.
    const shell = (connections as unknown as { shell: Required<import('@ferretry/app').ShellProvides> }).shell;
    // The build-time define `vite.config.ts` stamps in; the link itself carries no rendezvous to read.
    const host = globalThis as { __FY_RELAY_DIRECTORY__?: string };
    host.__FY_RELAY_DIRECTORY__ = 'https://directory.example';
    try {
      shell.carriers(ports);
      shell.pairing(ports);
      shell.carriers(ports);
      await new Promise(resolve => setTimeout(resolve, 5));
    } finally {
      delete host.__FY_RELAY_DIRECTORY__;
    }
    expect(asked).toEqual(['https://directory.example/v1/default-relay']);
  });

  test('R580 a build with no directory (or a withdrawn relay) offers nothing and dials nothing', async () => {
    expect(await documentRelayDiscovery(undefined, 'https://directory.example').hostedRelay()).toBeUndefined();
    const withdrawn = documentRelayDiscovery(
      async () => new Response(JSON.stringify({ version: 1, relayUrl: null })),
      'https://directory.example',
    );
    expect(await withdrawn.hostedRelay()).toBeUndefined();
    expect((await withdrawn.fallback()).kind).toBe('disabled');
  });
});
