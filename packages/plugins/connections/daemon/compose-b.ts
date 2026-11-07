/**
 * The tunnel and WebRTC carriers, composed through kernel ports (§2.3), as today's `fyd.ts` wired them.
 *
 * THE TUNNEL IS OPT-IN and WebRTC is on demand: neither starts a native library or a child at boot unless the
 * operator's `connections.yaml` asked. A tunnelled or WebRTC arrival is NEVER loopback — the arrival each carrier
 * stamps is `{ kind: 'carried' }` (the kernel's carrier listener, `webrtcArrival`), which the kernel can never read
 * as local. Nothing here logs a connector token, a tunnel credential, a code or a key: the token goes from a
 * provision straight to the child's environment (`BunConnectorProcesses`).
 */
import type {
  Carrier,
  CarrierKey,
  CarrierStatus,
  ConfigFileDef,
  KernelPorts,
  RouteHandler,
} from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { FileTunnelHolding } from './adapters/tunnel/file-tunnel-holding.ts';
import { BunConnectorProcesses } from './adapters/tunnel/bun-connector-process.ts';
import { HostedTunnelProvisioner } from './adapters/tunnel/hosted-tunnel-provisioner.ts';
import { HostedTunnelService } from './adapters/tunnel/hosted-tunnel-service.ts';
import { NodeDataChannelEngine } from './adapters/webrtc/node-datachannel-engine.ts';
import {
  DEFAULT_WEBRTC_ICE_SERVERS,
  HOSTED_RELAY_DIRECTORY_ORIGIN,
  type TunnelState,
  type TunnelStatusView,
  type ConnectionsConfig,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { createConnectionB, verifiedWebRtcDevice } from './connection-b.ts';
import type { OtherConnections } from './index.ts';
import type { CloudflaredLocatorPort } from './lib/tunnel/connector.ts';
import { tunnelPeer } from './lib/tunnel/listener.ts';
import { tunnelServiceOrigin } from './lib/tunnel/service.ts';
import type { WebRtcAvailability } from './lib/webrtc/carrier.ts';
import type { SessionLayer } from '@ferretry/kernel/contract';

/** What the tunnel needs from the machine beyond the kernel's ports: where `cloudflared` is. */
export interface TunnelHostPort {
  readonly cloudflared: CloudflaredLocatorPort;
}

const NO_CLOUDFLARED_SENTENCE = 'this daemon cannot run a tunnel yet: the kernel offers no way to find cloudflared';

/**
 * The host the kernel's ports can build today: it says out loud that the tunnel cannot run, instead of looking around
 * the kernel for a binary. The tunnel carrier then reports itself `unavailable` with this sentence.
 */
export function kernelTunnelHost(): TunnelHostPort {
  return { cloudflared: { locate: () => ({ kind: 'absent', reason: NO_CLOUDFLARED_SENTENCE }) } };
}

/**
 * The tunnel's session route: the direct carrier's own declared socket, served on the kernel's carrier listener so a
 * forwarded arrival is remote and lands nowhere else (§15, G15, G16).
 */
const TUNNEL_SOCKET = (manifest.actions.sockets[0] as { readonly key: string }).key;
const TUNNEL_CARRIER = 'tunnel' as CarrierKey;

const TUNNEL_CARRIER_STATE: Readonly<Record<TunnelState, CarrierStatus['state']>> = {
  off: 'off',
  unavailable: 'failed',
  provisioning: 'starting',
  connecting: 'starting',
  up: 'ready',
};

export interface ComposeInput {
  readonly kernel: KernelPorts;
  readonly config: ConnectionsConfig | undefined;
  readonly directoryOrigin?: string;
  readonly host: TunnelHostPort;
  /** Publishes the tunnel's address in the carrier set (or withdraws it with `undefined`). */
  readonly publishTunnel: (tunnelUrl: string | undefined) => void;
}

export function composeOtherConnections(input: ComposeInput): OtherConnections {
  const { kernel, config } = input;
  const scheduler = {
    after: (ms: number, action: () => void) => ({ cancel: kernel.clock.after(milliseconds(ms), action) }),
  };
  const fetcher = (url: string, init?: RequestInit) => kernel.fetch.request(url, init);
  const directoryOrigin = input.directoryOrigin ?? HOSTED_RELAY_DIRECTORY_ORIGIN;
  const webrtcConfig = config?.webrtc ?? { enabled: true, iceServers: DEFAULT_WEBRTC_ICE_SERVERS };
  const availability: WebRtcAvailability = webrtcConfig.enabled
    ? { kind: 'ready' }
    : {
        kind: 'refused',
        code: 'webrtc_disabled',
        reason: `peer-to-peer connections are switched off in ${(manifest.data.config[0] as ConfigFileDef<ConnectionsConfig> | undefined)?.file ?? 'connections.yaml'}`,
      };
  let layer: SessionLayer | undefined;
  const built = createConnectionB({
    tunnel: {
      entry: { kind: 'tunnel', source: 'discovery', enabled: config?.tunnel?.enabled ?? false },
      explicit: config?.tunnel !== undefined,
      discoveryOrigin: tunnelServiceOrigin(directoryOrigin),
      cloudflared: input.host.cloudflared,
      service: new HostedTunnelService(directoryOrigin, { fetcher }),
      // THAT a tunnel is held, and where from — never its connector token, which stays in memory.
      holding: new FileTunnelHolding(kernel.state),
      // The key PAIRING minted, signed through the kernel's fixed-label tunnel signer: the key never leaves it.
      identity: async () => ({
        ok: true,
        identity: {
          daemonId: kernel.identity.daemonId,
          sign: async request => await kernel.signer.signTunnel(request),
        },
      }),
      provisioner: origin => new HostedTunnelProvisioner(origin, { fetcher }),
      openListener: () =>
        kernel.carrierListener.open({
          carrier: TUNNEL_CARRIER,
          // Rate limits key by the address Cloudflare's edge saw, else one shared bucket.
          surface: { socket: TUNNEL_SOCKET, peer: tunnelPeer },
        }),
      // The kernel's spawn port supplies the child's base environment; only the token is added to this child's.
      processes: new BunConnectorProcesses({}, kernel.spawn, kernel.clock),
      scheduler,
      random: Math.random,
      publish: input.publishTunnel,
      notices: {
        step: (what, detail) => kernel.log.info(detail === undefined ? what : `${what} — ${detail}`),
        state: line => kernel.log.info(line),
      },
    },
    tunnelStore: {
      write: async entry => {
        const outcome = await kernel.config.write(manifest.data.config[0]!, undefined, {
          patch: { tunnel: { enabled: entry.enabled } },
        });
        if (outcome.kind === 'held')
          throw new Error('turning the tunnel on widens how this daemon is reached: it waits for the owner to confirm');
        if (outcome.kind !== 'written') throw new Error('the tunnel setting could not be written to its document');
      },
    },
    webrtc: {
      availability,
      engine: new NodeDataChannelEngine({ clock: kernel.clock }),
      iceServers: webrtcConfig.iceServers,
      scheduler,
      peerId: () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    },
    sessionLayer: () => layer,
    device: verifiedWebRtcDevice,
    onStop: stop => kernel.lifecycle.onStop(stop),
  });
  const tunnelStatus = (): TunnelStatusView => built.tunnel.view();
  const tunnel: Carrier = {
    start: async (carrierLayer: SessionLayer) => {
      layer = carrierLayer;
      built.startTunnel();
    },
    status: () => {
      const view = tunnelStatus();
      return { state: TUNNEL_CARRIER_STATE[view.state], sentence: view.sentence };
    },
  };
  const webrtc: Carrier = {
    start: async (carrierLayer: SessionLayer) => {
      layer = carrierLayer;
    },
    status: () =>
      availability.kind === 'refused'
        ? { state: 'off', sentence: availability.reason }
        : { state: 'ready', sentence: 'peer-to-peer connections are answered on demand' },
  };
  return {
    tunnel,
    webrtc,
    tunnelStatus: async () => tunnelStatus(),
    tunnelChange: built.routes['PUT /v1/tunnel'] as RouteHandler,
    webrtcOffer: built.routes['POST /v1/webrtc/offer'] as RouteHandler,
  };
}
