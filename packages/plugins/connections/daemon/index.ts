import {
  ApiError,
  jsonResponse,
  type Carrier,
  type CarrierStatus,
  type ConfigFileDef,
  type RouteHandler,
  type KernelPorts,
  type SessionLayer,
} from '@ferretry/kernel/contract';
import { implementDaemon, type DaemonContext } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import {
  CarriersChanged,
  type ConnectionAdvertisement,
  type ConnectionsConfig,
  type TunnelStatusView,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { RelayCarrier, type RelayWebSocketFactory } from './adapters/relay/bun-relay-carrier.ts';
import { HostedRelayDirectory } from './adapters/relay/hosted-relay-directory.ts';
import { nativeRelaySocket, randomSessionBytes } from './adapters/relay/native.ts';
import { DirectCarrier } from './lib/relay/direct.ts';
import {
  chooseRelayCarrierSources,
  describeAbsentRelayCarrier,
  dialledRelayUrl,
  NO_RELAY_DIRECTORY,
  relayCarriersNeedDiscovery,
  type RelayCarrierSource,
  type RelayDirectoryPort,
} from './lib/relay/discovery.ts';
import type { OpenCarrierSession, RendezvousSigner } from './lib/relay/session-ports.ts';
import { DISCOVERED_RELAY_CARRIER, type DaemonRelayCarrierEntry } from './lib/runtime/relay-config.ts';
import { decideAdvertisement } from './lib/runtime/advertisement.ts';
import { carrierRoutes } from './lib/runtime/mounts/carriers.ts';
import { PublishedCarrierSet } from './lib/runtime/published-carriers.ts';

/** Host-facing listener facts plus the Kernel identity and fixed-label claim signer. */
export interface ConnectionBindings {
  readonly identity: RendezvousSigner;
  readonly openSession: OpenCarrierSession;
  readonly directUrl?: string;
  readonly host?: string;
  readonly port?: number;
  readonly publicUrl?: string;
  readonly directoryOrigin?: string;
  readonly directory?: RelayDirectoryPort;
  readonly socketFactory?: RelayWebSocketFactory;
  readonly randomBytes?: (length: number) => Uint8Array;
}
/** The second port half supplies these after its tunnel/WebRTC services are built. */
export interface OtherConnections {
  readonly tunnel: Carrier;
  readonly webrtc: Carrier;
  readonly tunnelStatus: () => Promise<TunnelStatusView>;
  readonly tunnelChange: RouteHandler;
  readonly webrtcOffer: RouteHandler;
}
class UnavailableCarrier implements Carrier {
  constructor(private readonly sentence: string) {}
  async start(_layer: SessionLayer, _signal: AbortSignal): Promise<void> {}
  status(): CarrierStatus {
    return { state: 'failed', sentence: this.sentence };
  }
}
const unavailable = () => {
  throw new ApiError(503, 'This carrier is unavailable.', 'plugin_unavailable');
};
const configFile = manifest.data.config[0] as ConfigFileDef<ConnectionsConfig>;

/** build is synchronous; the one discovery read is an after-listen job, before the relay starts. */
export function buildConnections(
  ctx: DaemonContext<typeof manifest>,
  bindings?: ConnectionBindings,
  other?: OtherConnections,
) {
  const config = ctx.kernel.config.file(configFile);
  const relays: readonly DaemonRelayCarrierEntry[] =
    config?.relay === undefined ? [DISCOVERED_RELAY_CARRIER] : [{ kind: 'relay', ...config.relay }];
  const scheduler = {
    after: (ms: number, fn: () => void) => ({ cancel: ctx.kernel.clock.after(milliseconds(ms), fn) }),
  };
  let published = new PublishedCarrierSet(bindings?.directUrl, []);
  let sources: readonly RelayCarrierSource[] = [];
  let initial: Promise<void> | undefined;
  const initialise = (): Promise<void> =>
    (initial ??= (async () => {
      const advertisement = relayCarriersNeedDiscovery(relays)
        ? await (
            bindings?.directory ??
            new HostedRelayDirectory(bindings?.directoryOrigin, {
              fetcher: (url, init) => ctx.kernel.fetch.request(url, init),
            })
          ).read()
        : NO_RELAY_DIRECTORY;
      const resolved = chooseRelayCarrierSources(relays, advertisement);
      if (resolved.kind === 'refused') throw new ApiError(503, resolved.reason, 'plugin_failed');
      sources = resolved.sources;
      published = new PublishedCarrierSet(bindings?.directUrl, sources);
      ctx.kernel.events.publish(CarriersChanged, { kinds: published.current().map(c => c.kind) });
    })());
  ctx.kernel.jobs.add({
    id: 'relay-discovery',
    schedule: { onceAfterStart: true },
    run: async () => {
      await initialise();
    },
  });
  let direct: DirectCarrier | undefined;
  if (bindings !== undefined)
    direct = new DirectCarrier({
      identity: bindings.identity,
      scheduler,
      clock: { now: () => ctx.kernel.clock.nowMs() },
      randomBytes: bindings.randomBytes ?? randomSessionBytes,
      openSession: bindings.openSession,
    });
  const directProvider = direct ?? new UnavailableCarrier('The direct carrier is unavailable.');
  let held: RelayCarrier[] = [];
  const relay: Carrier = {
    start: async (layer, signal) => {
      await initialise();
      if (signal.aborted) return;
      if (bindings === undefined) return;
      const dialled = sources.flatMap(source =>
        source.kind === 'direct-only'
          ? []
          : [
              {
                source,
                carrier: new RelayCarrier({
                  config: source.config,
                  identity: bindings.identity,
                  scheduler,
                  now: () => ctx.kernel.clock.nowMs(),
                  random: Math.random,
                  socketFactory: bindings.socketFactory ?? nativeRelaySocket,
                  log: line => ctx.kernel.log.info(line),
                }),
              },
            ],
      );
      held = dialled.map(entry => entry.carrier);
      const started = new Map<string, CarrierStatus>();
      for (const { carrier, source } of dialled) {
        await carrier.start(layer, signal);
        const relayUrl = dialledRelayUrl(source);
        if (relayUrl !== undefined) started.set(relayUrl, carrier.status());
      }
      for (const line of relayBootTrail(sources, started, {
        configFile: configFile.file,
        host: bindings.host ?? config?.direct?.host ?? '127.0.0.1',
      }))
        ctx.kernel.log.info(line);
    },
    status: () => {
      if (bindings === undefined) return { state: 'failed', sentence: 'The relay carrier is unavailable.' };
      return (
        held.find(c => c.status().state === 'ready')?.status() ??
        held[0]?.status() ?? {
          state: 'off',
          sentence: sources[0]?.kind === 'direct-only' ? sources[0].reason : 'no relay is configured',
        }
      );
    },
  };
  const carriers = () => {
    if (bindings === undefined) unavailable();
    return published.current();
  };
  const carrierRoute = carrierRoutes({ current: () => published.current() })[0]!;
  return {
    routes: {
      'GET /v1/carriers': async (call: Parameters<RouteHandler>[0]) => {
        carriers();
        return carrierRoute.handle(call);
      },
      'GET /v1/tunnel': async () => jsonResponse(await (other?.tunnelStatus() ?? unavailable())),
      'PUT /v1/tunnel': other?.tunnelChange ?? unavailable,
      'POST /v1/webrtc/offer': other?.webrtcOffer ?? unavailable,
    },
    sockets: { 'GET /v1/rendezvous/:daemonId/client': direct?.route.accept ?? (async () => unavailable()) },
    provides: {
      connections: {
        carriers,
        advertisement: (): ConnectionAdvertisement => {
          if (bindings === undefined) unavailable();
          return {
            advertisement: decideAdvertisement({
              host: bindings?.host ?? config?.direct?.host ?? '127.0.0.1',
              port: bindings?.port ?? config?.direct?.port,
              ...(bindings?.publicUrl === undefined ? {} : { operatorPublicUrl: bindings.publicUrl }),
            }),
            ...(bindings?.port === undefined ? {} : { port: bindings.port }),
            ...(() => {
              const discovered = sources.find(s => s.kind === 'discovered');
              return discovered?.kind === 'discovered' && discovered.config.enabled
                ? { discoveredRelayUrl: discovered.config.url }
                : {};
            })(),
          };
        },
        tunnel: () =>
          other?.tunnelStatus() ??
          Promise.reject(new ApiError(503, 'the tunnel carrier is unavailable', 'plugin_unavailable')),
      },
    },
    hooks: {
      'carriers:direct': directProvider,
      'carriers:relay': relay,
      'carriers:tunnel': other?.tunnel ?? new UnavailableCarrier('the tunnel carrier is unavailable'),
      'carriers:webrtc': other?.webrtc ?? new UnavailableCarrier('the WebRTC carrier is unavailable'),
    },
  };
}
/**
 * What the boot trail says about the relay set once every carrier has started (copied from today's boot).
 *
 * A REFUSAL IS SAID OUT LOUD AND THE DAEMON KEEPS SERVING. The consequence and remedy are GLOBAL and therefore
 * emitted once, only when the entire set dials nothing. An inactive entry beside a working relay receives the
 * specific line instead.
 */
function relayBootTrail(
  sources: readonly RelayCarrierSource[],
  started: ReadonlyMap<string, CarrierStatus>,
  where: { readonly configFile: string; readonly host: string },
): readonly string[] {
  const lines: string[] = [];
  const activeCount = [...started.values()].filter(status => status.state !== 'off').length;
  const inactiveDetail = (source: RelayCarrierSource, detail?: string): string => {
    if (detail !== undefined) return detail;
    if (source.kind === 'direct-only') return source.reason;
    if (!source.config.enabled)
      return `the configured relay ${source.config.url} is switched off in this daemon's configuration`;
    return `the relay ${source.config.url} did not produce an active carrier`;
  };
  let globalAbsenceReported = false;
  for (const source of sources) {
    const relayUrl = dialledRelayUrl(source);
    const status = relayUrl === undefined ? undefined : started.get(relayUrl);
    if (status === undefined || status.state === 'off') {
      const detail = inactiveDetail(source, status?.sentence);
      if (activeCount > 0 || globalAbsenceReported) {
        lines.push(`relay carrier inactive — ${detail}`);
        continue;
      }
      lines.push(
        ...describeAbsentRelayCarrier({
          source,
          carrierDetail: detail,
          configFile: where.configFile,
          host: where.host,
        }),
      );
      globalAbsenceReported = true;
      continue;
    }
    lines.push(`dialling the relay — ${relayUrl}`);
  }
  return lines;
}
/** The production session opener: the Kernel calls `proved` only after it verified a device or member proof. */
export const openKernelSession: OpenCarrierSession = (layer, key, peer, proved) => layer.open(key, { ...peer, proved });
export function kernelConnectionBindings(kernel: KernelPorts): ConnectionBindings {
  const config = kernel.config.file(configFile);
  return {
    identity: { daemonId: kernel.identity.daemonId, sign: request => kernel.signer.sign(request) },
    openSession: openKernelSession,
    socketFactory: url => kernel.websocket.connect(url),
    ...(config?.direct?.host === undefined ? {} : { host: config.direct.host }),
    ...(config?.direct?.port === undefined ? {} : { port: config.direct.port }),
  };
}
export default implementDaemon(manifest, { build: ctx => buildConnections(ctx, kernelConnectionBindings(ctx.kernel)) });
