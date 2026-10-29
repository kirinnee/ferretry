/**
 * The carrier walk under a CONNECTION PREFERENCE (`docs/relay-protocol.md` §15 "The choice").
 *
 * Every case asks the same two questions: did the walk dial only what the preference allows, in the
 * preference's order — and when it carried nothing, did it say why in a sentence naming the preference,
 * rather than falling back to a carrier the person excluded?
 */

import { describe, it } from 'bun:test';
import type { ConnectionMethod } from '@ferretry/relay';
import should from 'should';
import {
  CARRIER_PREFERENCE_KEY,
  type CarrierPreference,
  CarrierPreferenceStore,
} from '../../src/lib/carrier-preference.ts';
import { type DaemonConnection, daemonConnection, type RelayCarrier } from '../../src/lib/daemon-connection.ts';
import {
  type CarrierDialers,
  type CarrierSocket,
  DaemonCarrierRouter,
  type DaemonCarrierRouterOptions,
  DeviceNotAcceptedError,
  DIRECT_SESSION_DEADLINE_MS,
  CONTROL_UNREACHABLE,
  RELAY_UNAVAILABLE,
  TUNNEL_LOOKUP_REUSE_MS,
  WEBRTC_UNAVAILABLE,
  type WebRtcDialContext,
} from '../../src/lib/relay-carrier.ts';
import type { TunnelServiceState } from '../../src/lib/tunnel-service.ts';
import { autoDial, newDaemonIdentity, relayCrypto, ScriptedSocket, settle, testDevice } from '../support/relay.ts';

const DAEMON_URL = 'https://studio.example';
const DIRECT_HOST = 'studio.example';
const TUNNEL_URL = 'https://k3x9.tunnels.example.com';
const TUNNEL_HOST = 'k3x9.tunnels.example.com';
const RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.example', operator: 'self' };
const HOSTED: RelayCarrier = { kind: 'relay', relayUrl: 'https://hosted.example', operator: 'hosted' };
const TUNNEL: ConnectionMethod = { kind: 'tunnel', tunnelUrl: TUNNEL_URL };
const DIRECT: ConnectionMethod = { kind: 'direct', daemonUrl: DAEMON_URL };
const DEVICE_ID = 'fy_device_id_preferenceTestDevice0001';
const device = await testDevice(DEVICE_ID);
/**
 * The network a router reads a daemon's liveness route over, offline. A router given none uses the real
 * `fetch`, and a walk whose direct socket failed then dialled `studio.example` from the test runner.
 */
const offline = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

type Reach = 'live' | 'refuse' | 'silent';

interface Setup {
  /** The daemon's published set, after its direct address. */
  readonly published?: readonly ConnectionMethod[];
  /** How each dialled host behaves; anything unnamed refuses. */
  readonly reach?: Readonly<Record<string, Reach>>;
  readonly preference?: CarrierPreference | ((daemonId: string) => CarrierPreference);
  readonly dialers?: CarrierDialers;
  readonly tunnelService?: TunnelServiceState;
  readonly hostedRelay?: string;
  readonly heartbeat?: DaemonCarrierRouterOptions['heartbeat'];
  /** How the scripted daemon answers what reaches it. */
  readonly answer?: Parameters<typeof autoDial>[1];
  /** The set the daemon answers `GET /v1/carriers` with, after its direct address; absent answers no set. */
  readonly publishes?: readonly ConnectionMethod[];
  readonly now?: () => number;
  readonly stepUp?: DaemonCarrierRouterOptions['stepUp'];
  readonly tunnelSwitchedOff?: boolean;
}

/** The daemon's `GET /v1/carriers` view, in its own wire spelling. */
const carriersView = (methods: readonly ConnectionMethod[]) => ({
  carriers: methods.map(method =>
    method.kind === 'direct'
      ? { kind: 'direct', url: method.daemonUrl }
      : method.kind === 'tunnel'
        ? { kind: 'tunnel', url: method.tunnelUrl }
        : { kind: 'relay', url: (method as RelayCarrier).relayUrl },
  ),
});

const setup = async (options: Setup = {}) => {
  const identity = await newDaemonIdentity();
  const daemon = daemonConnection({
    daemonId: identity.daemonId,
    baseUrl: DAEMON_URL,
    deviceId: DEVICE_ID,
    carriers: [DIRECT, ...(options.published ?? [])],
  });
  const publishes = options.publishes;
  const live = autoDial(identity, {
    devicePublicKey: device.publicKey,
    ...(publishes === undefined
      ? {}
      : {
          respond: request =>
            request.path === '/v1/carriers' ? { body: carriersView([DIRECT, ...publishes]) } : { body: {} },
        }),
    ...options.answer,
  });
  const learned: (readonly ConnectionMethod[])[] = [];
  const dialled: string[] = [];
  const dial = (url: string): ScriptedSocket => {
    dialled.push(url);
    const reach = options.reach?.[new URL(url).hostname] ?? 'refuse';
    if (reach === 'silent') return new ScriptedSocket();
    if (reach === 'refuse') {
      const refused = new ScriptedSocket();
      queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
      return refused;
    }
    return live.dial();
  };
  let tunnelReads = 0;
  let hostedReads = 0;
  // Auto unless a case names one: these cases prove each walk, and Relay (the app's default) is walked below.
  const preference = options.preference ?? 'auto';
  const router = new DaemonCarrierRouter({
    crypto: relayCrypto,
    deviceKey: async () => device.claim.key,
    dial,
    heartbeat: options.heartbeat ?? (() => () => undefined),
    network: offline,
    preference: typeof preference === 'function' ? preference : () => preference,
    ...(options.dialers === undefined ? {} : { dialers: options.dialers }),
    ...(options.tunnelService === undefined
      ? {}
      : {
          tunnelService: async () => {
            tunnelReads += 1;
            return options.tunnelService as TunnelServiceState;
          },
        }),
    hostedRelay: async () => {
      hostedReads += 1;
      return options.hostedRelay;
    },
    learned: (_daemon, carriers) => {
      learned.push(carriers);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }),
    ...(options.tunnelSwitchedOff === undefined ? {} : { tunnelSwitchedOff: () => options.tunnelSwitchedOff === true }),
  });
  router.resolvePaired(() => [daemon]);
  const hosts = (): string[] => dialled.map(url => new URL(url).hostname);
  return {
    router,
    daemon,
    identity,
    live,
    dialled,
    hosts,
    tunnelReads: () => tunnelReads,
    hostedReads: () => hostedReads,
    learned,
    /** The paths the daemon was asked for, over every carrier, in order. */
    paths: (): string[] =>
      live.requests.flatMap(request => {
        const asked = (request as { readonly path?: unknown }).path;
        return typeof asked === 'string' ? [asked] : [];
      }),
  };
};

/**
 * A WebRTC dialer that hands back a scripted daemon's socket — delivering nothing until the router has
 * taken it, as the {@link CarrierSocket} contract requires of a real one.
 */
const scriptedWebRtc = (identity: Awaited<ReturnType<typeof newDaemonIdentity>>) => {
  const live = autoDial(identity, { devicePublicKey: device.publicKey });
  const contexts: WebRtcDialContext[] = [];
  const dialer = async (context: WebRtcDialContext): Promise<CarrierSocket> => {
    contexts.push(context);
    const inner = live.dial();
    const outer = new ScriptedSocket();
    outer.send = bytes => inner.send(bytes);
    outer.close = (code, reason) => inner.close(code, reason);
    inner.onOpen = () => setTimeout(() => outer.onOpen?.(), 0);
    inner.onBinary = bytes => setTimeout(() => outer.onBinary?.(bytes), 0);
    inner.onText = text => setTimeout(() => outer.onText?.(text), 0);
    inner.onClose = (code, reason) => setTimeout(() => outer.onClose?.(code, reason), 0);
    return outer;
  };
  return { dialer, contexts, live };
};

const fetchProjects = async (router: DaemonCarrierRouter, daemon: DaemonConnection): Promise<Response> =>
  await router.send(daemon, `${DAEMON_URL}/v1/projects`);

describe('Auto', () => {
  it('should dial a published tunnel like a direct session, after direct and before every relay', async () => {
    const asked: number[] = [];
    const { router, daemon, dialled, hosts } = await setup({
      published: [TUNNEL, RELAY],
      reach: { [TUNNEL_HOST]: 'live', 'relay.example': 'live' },
      heartbeat: (_tick, interval) => {
        asked.push(interval);
        return () => undefined;
      },
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    should(hosts()).eql([DIRECT_HOST, TUNNEL_HOST]);
    should(dialled[1]).equal(`wss://${TUNNEL_HOST}/v1/rendezvous/${daemon.daemonId}/client`);
    // The direct acceptance deadline, not the relay's full grace: both attempts asked for it.
    should(asked.filter(interval => interval === DIRECT_SESSION_DEADLINE_MS)).have.length(2);
    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the tunnel did not carry the request');
    should(choice.method).eql(TUNNEL);
    should(choice.reason).equal(
      'Connected over Cloudflare tunnel because direct was not reachable (the address did not answer (1006)); WebRTC was not tried (WebRTC isn’t available in this build yet).',
    );
    should(choice.passedOver.map(skip => skip.untried === true)).eql([false, true]);
    await settle(5);
  });

  it('should walk on to the relay when the tunnel does not answer, naming both', async () => {
    const { router, daemon, hosts } = await setup({
      published: [TUNNEL, RELAY],
      reach: { 'relay.example': 'live' },
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    should(hosts()).eql([DIRECT_HOST, TUNNEL_HOST, 'relay.example']);
    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the relay did not carry the request');
    should(choice.method).eql(RELAY);
    should(choice.passedOver.map(skip => skip.method.kind)).eql(['direct', 'webrtc', 'tunnel']);
    await settle(5);
  });

  it('should try no tunnel at all when the daemon published none, and never ask the service', async () => {
    const { router, daemon, hosts, tunnelReads } = await setup({
      published: [RELAY],
      reach: { 'relay.example': 'live' },
      tunnelService: 'available',
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    should(hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(tunnelReads()).equal(0);
    await settle(5);
  });

  it('should treat a preference this build does not know, read from storage, as Relay, the default', async () => {
    const identity = await newDaemonIdentity();
    const stored = new CarrierPreferenceStore({
      getItem: key =>
        key === CARRIER_PREFERENCE_KEY ? JSON.stringify({ [identity.daemonId]: 'carrier-pigeon' }) : null,
      setItem: () => undefined,
    });
    const { router, daemon, hosts } = await setup({
      published: [TUNNEL, RELAY],
      reach: { [DIRECT_HOST]: 'live', [TUNNEL_HOST]: 'live', 'relay.example': 'live' },
      preference: daemonId => stored.preference(daemonId as never),
    });

    should((await fetchProjects(router, daemon)).status).equal(200);
    should(hosts()).eql(['relay.example']);
    should(router.choice(daemon.daemonId)?.reason).equal('Connected over your own relay.');
    await settle(5);
  });
});

describe('Tunnel only', () => {
  it('should dial the published tunnel and nothing else', async () => {
    const { router, daemon, hosts } = await setup({
      published: [TUNNEL, RELAY],
      reach: { [DIRECT_HOST]: 'live', [TUNNEL_HOST]: 'live', 'relay.example': 'live' },
      preference: 'tunnel',
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    should(hosts()).eql([TUNNEL_HOST]);
    should(router.choice(daemon.daemonId)?.reason).equal('Connected over Cloudflare tunnel.');
    await settle(5);
  });

  it('should say "not set up by the operator" when there is no tunnel and the service is off', async () => {
    const { router, daemon, hosts, paths, tunnelReads, hostedReads } = await setup({
      published: [RELAY],
      reach: { [DIRECT_HOST]: 'live', 'relay.example': 'live' },
      preference: 'tunnel',
      tunnelService: 'unavailable',
      hostedRelay: HOSTED.relayUrl,
    });

    await should(fetchProjects(router, daemon)).be.rejectedWith('Tunnel only: not set up by the operator.');

    // A stated failure, never a fall back to a carrier the person excluded: the one dial was the daemon
    // being ASKED where its tunnel is, and the person's request never left this browser.
    should(hosts()).eql([DIRECT_HOST]);
    should(paths()).eql(['/v1/carriers']);
    should(tunnelReads()).equal(1);
    should(hostedReads()).equal(0);
    const choice = router.choice(daemon.daemonId);
    should(choice?.ok).be.false();
    should(choice?.passedOver).eql([]);
  });

  it('should say "this machine has no tunnel yet" when the service is up but the daemon published none', async () => {
    const { router, daemon, hosts, paths, learned } = await setup({
      reach: { [DIRECT_HOST]: 'live' },
      preference: 'tunnel',
      tunnelService: 'available',
      publishes: [],
    });

    await should(fetchProjects(router, daemon)).be.rejectedWith('Tunnel only: this machine has no tunnel yet.');
    should(hosts()).eql([DIRECT_HOST]);
    should(paths()).eql(['/v1/carriers']);
    should(learned).eql([[DIRECT]]);
  });

  it('should say the machine’s tunnel is off, before the service’s reason, when the machine said so', async () => {
    const { router, daemon, tunnelReads } = await setup({
      reach: { [DIRECT_HOST]: 'live' },
      preference: 'tunnel',
      tunnelService: 'available',
      publishes: [],
      tunnelSwitchedOff: true,
    });

    await should(fetchProjects(router, daemon)).be.rejectedWith(
      'Tunnel only: this machine’s tunnel is off (opt-in) — turn it on in Settings › Connection.',
    );
    should(tunnelReads()).equal(0);
    await settle(5);
  });

  it('should read a build with no tunnel service as not set up by the operator', async () => {
    const { router, daemon } = await setup({ preference: 'tunnel' });
    await should(fetchProjects(router, daemon)).be.rejectedWith('Tunnel only: not set up by the operator.');
  });

  it('should say what failed, in the protocol’s words, when the one tunnel was tried and did not answer', async () => {
    const { router, daemon, hosts } = await setup({ published: [TUNNEL], preference: 'tunnel' });

    await should(fetchProjects(router, daemon)).be.rejectedWith(
      /^No configured connection worked: Cloudflare tunnel was not reachable/u,
    );
    // The tunnel, then the daemon asked over its direct address, which did not answer either.
    should(hosts()).eql([TUNNEL_HOST, DIRECT_HOST]);
  });

  it('should learn a tunnel it lost by asking the daemon over the relay, then carry the request on the tunnel', async () => {
    // Arrange — the owner's defect: the tunnel was healthy, the browser had simply lost its address.
    const { router, daemon, hosts, paths, learned } = await setup({
      published: [RELAY],
      reach: { 'relay.example': 'live', [TUNNEL_HOST]: 'live' },
      preference: 'tunnel',
      tunnelService: 'available',
      publishes: [TUNNEL, RELAY],
    });

    // Act
    const response = await fetchProjects(router, daemon);

    // Assert — the relay carried the question and nothing else; the tunnel carried the request.
    should(response.status).equal(200);
    should(hosts()).eql([DIRECT_HOST, 'relay.example', TUNNEL_HOST]);
    should(paths()).eql(['/v1/carriers', '/v1/projects']);
    should(learned).eql([[DIRECT, TUNNEL, RELAY]]);
    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the tunnel did not carry the request');
    should(choice.method).eql(TUNNEL);
    await settle(5);
  });

  it('should follow a re-provisioned hostname when the one it kept no longer answers', async () => {
    const moved: ConnectionMethod = { kind: 'tunnel', tunnelUrl: 'https://n3w.tunnels.example.com' };
    const { router, daemon, hosts, paths } = await setup({
      published: [TUNNEL, RELAY],
      reach: { 'relay.example': 'live', 'n3w.tunnels.example.com': 'live' },
      preference: 'tunnel',
      publishes: [moved, RELAY],
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    should(hosts()).eql([TUNNEL_HOST, DIRECT_HOST, 'relay.example', 'n3w.tunnels.example.com']);
    should(paths()).eql(['/v1/carriers', '/v1/projects']);
    should(router.choice(daemon.daemonId)?.ok).be.true();
    await settle(5);
  });

  it('should never hold up a connect on a lookup when the tunnel it kept answers', async () => {
    const { router, daemon, hosts, paths, learned } = await setup({
      published: [TUNNEL, RELAY],
      reach: { [DIRECT_HOST]: 'live', [TUNNEL_HOST]: 'live', 'relay.example': 'live' },
      preference: 'tunnel',
      publishes: [TUNNEL, RELAY],
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    should(hosts()).eql([TUNNEL_HOST]);
    should(paths()).eql(['/v1/projects']);
    should(learned).eql([]);
    await settle(5);
  });

  it('should not dial the kept tunnel twice when the daemon still names it', async () => {
    const { router, daemon, hosts } = await setup({
      published: [TUNNEL],
      reach: { [DIRECT_HOST]: 'live' },
      preference: 'tunnel',
      publishes: [TUNNEL],
    });

    await should(fetchProjects(router, daemon)).be.rejectedWith(
      /^No configured connection worked: Cloudflare tunnel was not reachable/u,
    );
    should(hosts()).eql([TUNNEL_HOST, DIRECT_HOST]);
  });

  it('should ask once per reuse window however many walks need the answer', async () => {
    let clock = 1_000;
    const { router, daemon, paths } = await setup({
      reach: { [DIRECT_HOST]: 'live' },
      preference: 'tunnel',
      tunnelService: 'available',
      publishes: [],
      now: () => clock,
    });

    await should(fetchProjects(router, daemon)).be.rejected();
    await should(fetchProjects(router, daemon)).be.rejected();
    should(paths()).eql(['/v1/carriers']);

    clock += TUNNEL_LOOKUP_REUSE_MS;
    await should(fetchProjects(router, daemon)).be.rejected();
    should(paths()).eql(['/v1/carriers', '/v1/carriers']);
    await settle(5);
  });

  it('should treat an answer that is not a carrier set as finding nothing, and keep nothing', async () => {
    const refused = await setup({
      reach: { [DIRECT_HOST]: 'live' },
      preference: 'tunnel',
      tunnelService: 'available',
      answer: { status: 503 },
    });
    await should(fetchProjects(refused.router, refused.daemon)).be.rejectedWith(
      'Tunnel only: this machine has no tunnel yet.',
    );
    should(refused.learned).eql([]);

    const garbled = await setup({
      reach: { [DIRECT_HOST]: 'live' },
      preference: 'tunnel',
      tunnelService: 'available',
      answer: { body: '{"carriers":"none"}' },
    });
    await should(fetchProjects(garbled.router, garbled.daemon)).be.rejectedWith(
      'Tunnel only: this machine has no tunnel yet.',
    );
    should(garbled.learned).eql([]);
    await settle(5);
  });

  it('should open a stream on the tunnel too, and refuse one with the same sentence when there is none', async () => {
    const withTunnel = await setup({ published: [TUNNEL], reach: { [TUNNEL_HOST]: 'live' }, preference: 'tunnel' });
    const session = await withTunnel.router.openStream(withTunnel.daemon, {
      path: '/v1/events',
      onData: () => undefined,
    });
    should(session.streaming()).be.true();
    should(withTunnel.hosts()).eql([TUNNEL_HOST]);

    const without = await setup({ preference: 'tunnel', tunnelService: 'available' });
    await should(
      without.router.openStream(without.daemon, { path: '/v1/events', onData: () => undefined }),
    ).be.rejectedWith('Tunnel only: this machine has no tunnel yet.');
    await settle(5);
  });
});

describe('Relay only', () => {
  it('should dial the daemon’s relay and never its direct address or its tunnel', async () => {
    const { router, daemon, hosts } = await setup({
      published: [TUNNEL, RELAY],
      reach: { [DIRECT_HOST]: 'live', [TUNNEL_HOST]: 'live', 'relay.example': 'live' },
      preference: 'relay',
    });

    should((await fetchProjects(router, daemon)).status).equal(200);
    should(hosts()).eql(['relay.example']);
    should(router.choice(daemon.daemonId)?.reason).equal('Connected over your own relay.');
    await settle(5);
  });

  it('should fall back to the hosted relay when the daemon authored none, exactly as before the choice', async () => {
    const { router, daemon, hosts } = await setup({
      reach: { [DIRECT_HOST]: 'live', 'hosted.example': 'live' },
      preference: 'relay',
      hostedRelay: HOSTED.relayUrl,
    });

    should((await fetchProjects(router, daemon)).status).equal(200);
    should(hosts()).eql(['hosted.example']);
    await settle(5);
  });

  it('should say there is no relay rather than dial anything else when there is none at all', async () => {
    const { router, daemon, hosts } = await setup({ reach: { [DIRECT_HOST]: 'live' }, preference: 'relay' });

    await should(fetchProjects(router, daemon)).be.rejectedWith(`Relay only: ${RELAY_UNAVAILABLE}.`);
    should(hosts()).eql([]);
  });
});

describe('WebRTC', () => {
  it('should be a stated failure under WebRTC only in a build with no dialer, never a silent fall back', async () => {
    const { router, daemon, hosts } = await setup({
      published: [RELAY],
      reach: { [DIRECT_HOST]: 'live', 'relay.example': 'live' },
      preference: 'webrtc',
    });

    await should(fetchProjects(router, daemon)).be.rejectedWith(`WebRTC only: ${WEBRTC_UNAVAILABLE}.`);

    should(hosts()).eql([]);
    const choice = router.choice(daemon.daemonId);
    should(choice?.passedOver).eql([{ method: { kind: 'webrtc' }, detail: WEBRTC_UNAVAILABLE, untried: true }]);
  });

  it('should carry a session over the dialer’s channel, introduced by the carriers that can introduce', async () => {
    const identity = await newDaemonIdentity();
    const webrtc = scriptedWebRtc(identity);
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [DIRECT, TUNNEL],
    });
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      deviceKey: async () => device.claim.key,
      dial: () => {
        const refused = new ScriptedSocket();
        queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
        return refused;
      },
      heartbeat: () => () => undefined,
      network: offline,
      dialers: { webrtc: webrtc.dialer },
      preference: () => 'auto',
      hostedRelay: async () => HOSTED.relayUrl,
    });
    router.resolvePaired(() => [daemon]);

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);

    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('WebRTC did not carry the request');
    should(choice.method).eql({ kind: 'webrtc' });
    should(choice.reason).match(/^Connected over WebRTC because direct was not reachable/u);
    // The tunnel never introduces — its listener serves the session route only — and the hosted relay
    // stands in for a daemon that authored no rendezvous of its own.
    should(webrtc.contexts[0]?.introducers).eql([DIRECT, HOSTED]);
    should(webrtc.contexts[0]?.daemon).equal(daemon);
    should(webrtc.contexts[0]?.signal.aborted).be.false();

    // The same channel keeps the traffic, and survives the daemon republishing a set that cannot name it.
    should((await router.send(daemon, `${DAEMON_URL}/v1/usage`)).status).equal(200);
    should(webrtc.contexts).have.length(1);
    const republished = daemonConnection({ ...daemon, carriers: [DIRECT, TUNNEL, RELAY] });
    router.resolvePaired(() => [republished]);
    should((await router.send(republished, `${DAEMON_URL}/v1/usage`)).status).equal(200);
    should(webrtc.contexts).have.length(1);
    should(router.choice(daemon.daemonId)?.ok === true && router.choice(daemon.daemonId)).match({
      method: { kind: 'webrtc' },
    });

    // An unpair abandons the attempt's signal, so a dialer still negotiating stops.
    router.clearDaemon(daemon.daemonId);
    should(webrtc.contexts[0]?.signal.aborted).be.true();
    await settle(5);
  });

  it('should hand the daemon’s own relays to the dialer, and walk on when it cannot negotiate', async () => {
    const contexts: WebRtcDialContext[] = [];
    const { router, daemon, hosts, hostedReads } = await setup({
      published: [TUNNEL, RELAY],
      reach: { 'relay.example': 'live' },
      dialers: {
        webrtc: async context => {
          contexts.push(context);
          throw new Error('ICE did not connect');
        },
      },
      hostedRelay: HOSTED.relayUrl,
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    should(contexts[0]?.introducers).eql([DIRECT, RELAY]);
    should(hostedReads()).equal(0);
    should(hosts()).eql([DIRECT_HOST, TUNNEL_HOST, 'relay.example']);
    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the relay did not carry the request');
    should(choice.reason).match(/WebRTC was not reachable \(ICE did not connect\)/u);
    await settle(5);
  });
});

describe('signalling over the introducers', () => {
  it('should send a dialer’s request over the first introducer that carries it, deciding nothing', async () => {
    const answers: number[] = [];
    const { router, daemon, hosts, live } = await setup({
      published: [TUNNEL, RELAY],
      reach: { 'relay.example': 'live' },
      preference: 'webrtc',
      answer: {
        respond: request => ({ status: request.path === '/v1/webrtc/offer' ? 201 : 404, body: { sdp: 'answer' } }),
      },
      dialers: {
        webrtc: async context => {
          const response = await context.request('/v1/webrtc/offer', { method: 'POST', body: '{"sdp":"offer"}' });
          answers.push(response.status);
          throw new Error('ICE did not connect');
        },
      },
    });

    await should(fetchProjects(router, daemon)).be.rejectedWith(/WebRTC was not reachable \(ICE did not connect\)/u);

    should(answers).eql([201]);
    // Direct refused, then the daemon's relay carried the offer — the tunnel never introduces.
    should(hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(live.requests).match([{ t: 'req', method: 'POST', path: '/v1/webrtc/offer' }]);
    should(router.choice(daemon.daemonId)?.ok).be.false();
    await settle(5);
  });

  it('should not send a write again when the session died under it, nor without any introducer', async () => {
    const outcomes: string[] = [];
    const { router, daemon, hosts } = await setup({
      published: [RELAY],
      reach: { [DIRECT_HOST]: 'live', 'relay.example': 'live' },
      preference: 'webrtc',
      answer: {
        respond: () => {
          throw new Error('the link dropped');
        },
      },
      dialers: {
        webrtc: async context => {
          await context.request('/v1/webrtc/offer', { method: 'POST', body: '{}' }).catch((reason: Error) => {
            outcomes.push(reason.message);
          });
          throw new Error('no answer to the offer');
        },
      },
    });
    await should(fetchProjects(router, daemon)).be.rejected();
    should(outcomes).have.length(1);
    should(hosts()).eql([DIRECT_HOST]);

    // A machine whose only carrier is a tunnel has nothing that can introduce WebRTC.
    const identity = await newDaemonIdentity();
    const tunnelOnly = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [TUNNEL],
    });
    const said: string[] = [];
    const bare = new DaemonCarrierRouter({
      crypto: relayCrypto,
      deviceKey: async () => device.claim.key,
      dial: () => new ScriptedSocket(),
      heartbeat: () => () => undefined,
      network: offline,
      preference: () => 'webrtc',
      dialers: {
        webrtc: async context => {
          await context.request('/v1/webrtc/offer').catch((reason: Error) => said.push(reason.message));
          throw new Error('nobody to signal through');
        },
      },
    });
    bare.resolvePaired(() => [tunnelOnly]);
    await should(bare.send(tunnelOnly, `${DAEMON_URL}/v1/projects`)).be.rejected();
    should(said).eql(['no carrier can introduce WebRTC to this machine']);
    await settle(5);
  });

  it('should return an answer as it came, after an introducer whose session never opened', async () => {
    const statuses: number[] = [];
    const { router, daemon, hosts } = await setup({
      published: [RELAY],
      reach: { 'relay.example': 'live' },
      preference: 'webrtc',
      answer: { respond: () => ({ status: 409, body: { error: 'busy' } }) },
      dialers: {
        webrtc: async context => {
          statuses.push((await context.request('/v1/webrtc/candidates')).status);
          throw new Error('stop here');
        },
      },
    });
    await should(fetchProjects(router, daemon)).be.rejected();
    should(statuses).eql([409]);
    should(hosts()).eql([DIRECT_HOST, 'relay.example']);
    await settle(5);
  });
});

describe('changing the preference', () => {
  it('should forget the winner, close what it held, and walk the new preference', async () => {
    let preference: CarrierPreference = 'auto';
    const changes: number[] = [];
    const { router, daemon, hosts, live } = await setup({
      published: [RELAY],
      reach: { [DIRECT_HOST]: 'live', 'relay.example': 'live' },
      preference: () => preference,
    });
    const unsubscribe = router.subscribe(() => changes.push(1));

    should((await fetchProjects(router, daemon)).status).equal(200);
    should(router.choice(daemon.daemonId)?.reason).equal('Connected over direct.');
    const directSocket = live.sockets[0];

    preference = 'relay';
    const before = changes.length;
    router.rewalk(daemon.daemonId);
    should(changes.length).equal(before + 1);
    should(router.choice(daemon.daemonId)).be.undefined();
    await settle(5);
    should(directSocket?.closed).not.be.null();

    should((await fetchProjects(router, daemon)).status).equal(200);
    should(hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(router.choice(daemon.daemonId)?.reason).equal('Connected over your own relay.');
    unsubscribe();
    await settle(5);
  });

  it('should stop a walk that was in flight under the old preference instead of deciding with it', async () => {
    // Direct drops its packets; its acceptance deadline is fired by hand, after the preference changed.
    const deadlines: (() => void)[] = [];
    const { router, daemon, hosts } = await setup({
      published: [RELAY],
      reach: { [DIRECT_HOST]: 'silent', 'relay.example': 'live' },
      heartbeat: (tick, interval) => {
        if (interval === DIRECT_SESSION_DEADLINE_MS) deadlines.push(tick);
        return () => undefined;
      },
    });
    const pending = fetchProjects(router, daemon);
    await settle(2);
    router.rewalk(daemon.daemonId);
    for (const deadline of deadlines) deadline();
    await should(pending).be.rejectedWith(/connection preference changed/u);
    should(router.choice(daemon.daemonId)).be.undefined();
    // The old walk never reached the relay it would have dialled next.
    should(hosts()).eql([DIRECT_HOST]);
  });

  it('should keep a device refusal across a re-walk, and do nothing for a machine it never walked', async () => {
    const { router, daemon } = await setup();
    router.rewalk(daemon.daemonId);
    should(router.choice(daemon.daemonId)).be.undefined();

    const refused = await setup({ reach: { [DIRECT_HOST]: 'live' } });
    const rejecting = autoDial(refused.identity, { rejectDevice: true });
    const router2 = new DaemonCarrierRouter({
      crypto: relayCrypto,
      deviceKey: async () => device.claim.key,
      dial: () => rejecting.dial(),
      preference: () => 'auto',
      heartbeat: () => () => undefined,
      network: offline,
    });
    router2.resolvePaired(() => [refused.daemon]);
    await should(router2.send(refused.daemon, `${DAEMON_URL}/v1/projects`)).be.rejected();
    should(router2.deviceRefused(refused.daemon.daemonId)).be.true();
    router2.rewalk(refused.daemon.daemonId);
    should(router2.deviceRefused(refused.daemon.daemonId)).be.true();
    await settle(5);
  });
});

describe('the reason a faster carrier is not carrying (WebRTC, docs/relay-protocol.md §16)', () => {
  const failingWebRtc = {
    webrtc: async (): Promise<never> => {
      throw new Error('no direct path found in 8 s');
    },
  };

  it('should carry WebRTC’s own sentence beside the relay that won after it failed', async () => {
    const { router, daemon } = await setup({
      published: [RELAY],
      reach: { 'relay.example': 'live' },
      dialers: failingWebRtc,
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the relay did not carry the request');
    const missed = choice.passedOver.find(skip => skip.method.kind === 'webrtc');
    should(choice.method.kind).equal('relay');
    should(choice.fallbackReason).equal(missed?.detail);
    should(choice.fallbackReason).match(/no direct path found in 8 s/u);
    await settle(5);
  });

  it('should give no fallback reason when WebRTC was never tried in this build', async () => {
    const { router, daemon } = await setup({ published: [RELAY], reach: { 'relay.example': 'live' } });

    should((await fetchProjects(router, daemon)).status).equal(200);

    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the relay did not carry the request');
    should(choice.passedOver.some(skip => skip.method.kind === 'webrtc' && skip.untried === true)).be.true();
    should(choice.fallbackReason).be.undefined();
    await settle(5);
  });

  it('should give no fallback reason to a direct carrier, which outranks WebRTC', async () => {
    const { router, daemon } = await setup({
      published: [RELAY],
      reach: { [DIRECT_HOST]: 'live' },
      dialers: failingWebRtc,
    });

    should((await fetchProjects(router, daemon)).status).equal(200);

    const choice = router.choice(daemon.daemonId);
    should(choice).match({ ok: true, method: { kind: 'direct' } });
    should(choice?.ok === true ? choice.fallbackReason : 'not ok').be.undefined();
    await settle(5);
  });
});

describe('carrier control (GET/PUT /v1/tunnel, §15)', () => {
  const PUT = { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' };

  it('should reach a "Tunnel only" machine whose tunnel is off over a relay, and remember no winner', async () => {
    const { router, daemon, hosts, paths } = await setup({
      published: [RELAY],
      reach: { 'relay.example': 'live' },
      preference: 'tunnel',
      answer: { body: '{"enabled":true}' },
    });

    const response = await router.control(daemon, `${DAEMON_URL}/v1/tunnel`, PUT);

    should(response.status).equal(200);
    should(hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(paths()).eql(['/v1/tunnel']);
    should(router.choice(daemon.daemonId)).be.undefined();
    await settle(5);
  });

  it('should never ride the tunnel it may be switching off, nor WebRTC', async () => {
    const webrtc: string[] = [];
    const { router, daemon, hosts } = await setup({
      published: [TUNNEL, RELAY],
      reach: { [TUNNEL_HOST]: 'live', 'relay.example': 'live' },
      preference: 'auto',
      dialers: {
        webrtc: async () => {
          webrtc.push('dialled');
          throw new Error('not here');
        },
      },
    });

    should((await router.control(daemon, `${DAEMON_URL}/v1/tunnel?x=1`)).status).equal(200);
    should(hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(webrtc).eql([]);
    await settle(5);
  });

  it('should ask for the passkey the daemon wants, then send the switch once more', async () => {
    const asked: Array<string | undefined> = [];
    let answered = 0;
    const { router, daemon, paths } = await setup({
      reach: { [DIRECT_HOST]: 'live' },
      preference: 'tunnel',
      answer: {
        respond: () => {
          answered += 1;
          return answered === 1
            ? {
                status: 403,
                body: { code: 'grant_step_up_required', message: 'Confirm with your passkey.' },
              }
            : { body: { ok: true } };
        },
      },
      stepUp: async (_daemon, act) => {
        asked.push(act);
        return true;
      },
    });

    should((await router.control(daemon, `${DAEMON_URL}/v1/tunnel`, PUT)).status).equal(200);
    should(asked).have.length(1);
    should(paths()).eql(['/v1/tunnel', '/v1/tunnel']);
    await settle(5);
  });

  it('should say plainly when nothing but the tunnel could carry it', async () => {
    const { router, daemon } = await setup({ reach: { [TUNNEL_HOST]: 'live' }, preference: 'tunnel' });
    const tunnelOnly = daemonConnection({ ...daemon, carriers: [TUNNEL] });
    router.resolvePaired(() => [tunnelOnly]);

    await should(router.control(tunnelOnly, `${DAEMON_URL}/v1/tunnel`)).be.rejectedWith(CONTROL_UNREACHABLE);
  });

  it('should send nothing for a device the daemon refused', async () => {
    const refused = await setup({ reach: { [DIRECT_HOST]: 'live' } });
    const rejecting = autoDial(refused.identity, { rejectDevice: true });
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      deviceKey: async () => device.claim.key,
      dial: () => rejecting.dial(),
      preference: () => 'auto',
      heartbeat: () => () => undefined,
      network: offline,
    });
    router.resolvePaired(() => [refused.daemon]);
    await should(router.send(refused.daemon, `${DAEMON_URL}/v1/projects`)).be.rejected();

    await should(router.control(refused.daemon, `${DAEMON_URL}/v1/tunnel`)).be.rejectedWith(DeviceNotAcceptedError);
    await settle(5);
  });
});
