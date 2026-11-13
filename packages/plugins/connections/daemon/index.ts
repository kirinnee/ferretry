import {
  ApiError,
  jsonResponse,
  type Carrier,
  type CarrierStatus,
  type ConfigFileDef,
  type RouteHandler,
  type KernelPorts,
  type SessionLayer,
  type DoctorCheck,
} from '@ferretry/kernel/contract';
import { implementDaemon, type DaemonContext } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import {
  CarriersChanged,
  HOSTED_APP_ORIGIN,
  HOSTED_RELAY_DIRECTORY_ORIGIN,
  isLoopbackHost,
  type ConnectionAdvertisement,
  type ConnectionsConfig,
  type TunnelStatusView,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { switchedWebrtcSelftest } from './adapters/webrtc/selftest.ts';
import { RelayCarrier, type RelayWebSocketFactory } from './adapters/relay/bun-relay-carrier.ts';
import { HostedRelayDirectory } from './adapters/relay/hosted-relay-directory.ts';
import { nativeRelaySocket, randomSessionBytes } from './adapters/relay/native.ts';
import { DirectCarrier } from './lib/relay/direct.ts';
import { RelayDirectoryRetry } from './lib/relay/directory-retry.ts';
import {
  chooseRelayCarrierSources,
  describeAbsentRelayCarrier,
  describeRelayCarrierPosture,
  dialledRelayUrl,
  isTransientAdvertisement,
  NO_RELAY_DIRECTORY,
  type RelayAdvertisement,
  relayCarriersNeedDiscovery,
  relayCarrierRemedy,
  type RelayCarrierSource,
  type RelayDirectoryPort,
} from './lib/relay/discovery.ts';
import type { OpenCarrierSession, RendezvousSigner } from './lib/relay/session-ports.ts';
import { DISCOVERED_RELAY_CARRIER, type DaemonRelayCarrierEntry } from './lib/runtime/relay-config.ts';
import { decideAdvertisement } from './lib/runtime/advertisement.ts';
import { browserOrigins, directoryOriginOf } from './lib/runtime/browser-origins.ts';
import { carrierRoutes } from './lib/runtime/mounts/carriers.ts';
import { tunnelSessionLog } from './lib/tunnel/session-log.ts';
import { PublishedCarrierSet } from './lib/runtime/published-carriers.ts';
import { composeOtherConnections, kernelTunnelHost, type TunnelHostPort } from './compose-b.ts';

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
  /** The browser origins this daemon answers (today's `corsOrigins`); the hosted app's by default. */
  readonly corsOrigins?: readonly string[];
  readonly socketFactory?: RelayWebSocketFactory;
  readonly randomBytes?: (length: number) => Uint8Array;
}
/** The tunnel and WebRTC services, composed by `compose-b.ts` (a suite may supply its own). */
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

/**
 * build is synchronous; the first discovery read is an after-listen job, before the relay starts. A transient
 * failure of that read is asked again in the background (`RelayDirectoryRetry`), never on the boot path.
 */
export function buildConnections(
  ctx: DaemonContext<typeof manifest>,
  bindings?: ConnectionBindings,
  supplied?: OtherConnections,
  tunnelHost?: TunnelHostPort,
) {
  const config = ctx.kernel.config.file(configFile);
  const relaysOf = (document: ConnectionsConfig | undefined): readonly DaemonRelayCarrierEntry[] =>
    document?.relay === undefined || document.relay.length === 0
      ? [DISCOVERED_RELAY_CARRIER]
      : document.relay.map(entry => ({ kind: 'relay', ...entry }));
  const relays = relaysOf(config);
  /**
   * WHERE THIS DAEMON LISTENS, asked at the moment of use. The kernel binds AFTER every plugin is built, so a value
   * captured at build would be the `connections.yaml` guess for ever. The listener the kernel really bound wins
   * (`--port`, `FY_PORT` or the default, and `--host`); `direct` in the configuration answers only while nothing is bound.
   */
  const listening = (): { readonly host: string; readonly port: number | undefined } => {
    const bound = ctx.kernel.bind.current();
    return {
      host: bound?.host ?? bindings?.host ?? config?.direct?.host ?? '127.0.0.1',
      port: bound?.port ?? bindings?.port ?? config?.direct?.port,
    };
  };
  const scheduler = {
    after: (ms: number, fn: () => void) => ({ cancel: ctx.kernel.clock.after(milliseconds(ms), fn) }),
  };
  let published = new PublishedCarrierSet(bindings?.directUrl, []);
  let sources: readonly RelayCarrierSource[] = [];
  let initial: Promise<void> | undefined;
  /** The tunnel's address while cloudflared holds a registered connection; kept across the discovery read. */
  let tunnelUrl: string | undefined;
  /** The relay carrier's layer and signal once it has started, so a later recovery can dial without a restart. */
  let carrierStart: { readonly layer: SessionLayer; readonly signal: AbortSignal } | undefined;
  let dialRecovered: () => Promise<void> = async () => {};
  let directoryPort: RelayDirectoryPort | undefined;
  const directory = (): RelayDirectoryPort =>
    (directoryPort ??=
      bindings?.directory ??
      new HostedRelayDirectory(bindings?.directoryOrigin ?? HOSTED_RELAY_DIRECTORY_ORIGIN, {
        fetcher: (url, init) => ctx.kernel.fetch.request(url, init),
      }));
  /** Resolves `advertisement` into this boot's sources. A refusal changes nothing and is returned for the caller to say. */
  const adopt = (advertisement: RelayAdvertisement, announce: boolean) => {
    const resolved = chooseRelayCarrierSources(relays, advertisement);
    if (resolved.kind === 'refused') return resolved;
    sources = resolved.sources;
    if (!announce) return resolved;
    published = new PublishedCarrierSet(bindings?.directUrl, sources);
    if (tunnelUrl !== undefined) published.tunnel(tunnelUrl);
    ctx.kernel.events.publish(CarriersChanged, { kinds: published.current().map(c => c.kind) });
    return resolved;
  };
  const relayWrittenMeanwhile = `a relay is now written in config/${configFile.file} and the hosted directory was not reached first; restart to dial it`;
  /**
   * A transient failure of the boot read is asked again here, in the background: the same `discovered` source, links
   * and relay carrier as a first-read success once it answers. Definitive answers never come here, and an explicit
   * relay written meanwhile wins (`stillNeeded`) and stops it.
   */
  const retry = new RelayDirectoryRetry(
    {
      read: async signal => await directory().read(signal),
      after: (ms, fn) => ctx.kernel.clock.after(milliseconds(ms), fn),
      random: Math.random,
      nowMs: () => ctx.kernel.clock.nowMs(),
      stillNeeded: () => relayCarriersNeedDiscovery(relaysOf(ctx.kernel.config.file(configFile))),
    },
    {
      // Still failing: only the sentence changes (the next try's time), so nothing is republished.
      waiting: failed => void adopt(failed, false),
      settled: answer => {
        const resolved = adopt(answer, true);
        if (resolved.kind === 'refused') {
          // THE RULE, STATED ONCE: a relay the operator WROTE wins and is never torn down. A duplicate rendezvous found
          // on recovery refuses only the DISCOVERED entry (it takes the refusal sentence); the configured source, the
          // published carrier set, `resolvers.relay()` and the running socket are all left exactly as they were, so
          // they cannot disagree. (At boot the same collision refuses the whole boot: there is nothing running yet.)
          ctx.kernel.log.error(resolved.reason);
          sources = sources.map(source =>
            source.kind === 'direct-only' && source.retrying === true
              ? { kind: 'direct-only' as const, reason: resolved.reason }
              : source,
          );
        }
        void dialRecovered().catch(() => ctx.kernel.log.warn('the recovered relay carrier could not start'));
      },
      abandoned: () => {
        ctx.kernel.log.info(
          `relay directory retries stopped — a relay is now written in config/${configFile.file}; restart to dial it`,
        );
        sources = sources.map(source =>
          source.kind === 'direct-only' && source.retrying === true
            ? { kind: 'direct-only' as const, reason: relayWrittenMeanwhile }
            : source,
        );
      },
    },
  );
  ctx.kernel.lifecycle.onStop(() => retry.stop());
  const initialise = (): Promise<void> =>
    (initial ??= (async () => {
      const asked = relayCarriersNeedDiscovery(relays);
      let advertisement = asked ? await directory().read(ctx.kernel.lifecycle.signal) : NO_RELAY_DIRECTORY;
      // The same two guards the background retry has, applied to the FIRST read: the answer of a read that was in
      // flight when the daemon stopped is dropped, and a relay the operator wrote meanwhile (enabled:false too) wins.
      if (asked && ctx.kernel.lifecycle.signal.aborted)
        advertisement = { kind: 'undetermined', reason: 'this daemon stopped before the relay directory answered' };
      else if (asked && !relayCarriersNeedDiscovery(relaysOf(ctx.kernel.config.file(configFile))))
        advertisement = { kind: 'undetermined', reason: relayWrittenMeanwhile };
      if (isTransientAdvertisement(advertisement)) advertisement = retry.begin(advertisement);
      const resolved = adopt(advertisement, true);
      if (resolved.kind === 'refused') throw new ApiError(503, resolved.reason, 'plugin_failed');
    })());
  const publishTunnel = (url: string | undefined): void => {
    tunnelUrl = url;
    published.tunnel(url);
    ctx.kernel.events.publish(CarriersChanged, { kinds: published.current().map(c => c.kind) });
  };
  /**
   * Today's `browserOrigins(config)`: what a passkey may name and what a tunnel upgrade's `Origin` may be. It is read
   * from the CONFIGURED `direct` block only, never from the listener the kernel bound: where the daemon listens is a
   * fact for the advertisement and the reachability check, and must not widen who a browser may speak as.
   */
  const allowedOrigins = (): readonly string[] =>
    browserOrigins({
      corsOrigins: bindings?.corsOrigins ?? [HOSTED_APP_ORIGIN],
      host: bindings?.host ?? config?.direct?.host ?? '127.0.0.1',
      ...(bindings?.publicUrl === undefined ? {} : { publicUrl: bindings.publicUrl }),
      ...((bindings?.port ?? config?.direct?.port) === undefined
        ? {}
        : { port: (bindings?.port ?? config?.direct?.port) as number }),
    });
  const other =
    supplied ??
    (bindings === undefined
      ? undefined
      : composeOtherConnections({
          kernel: ctx.kernel,
          config,
          ...(bindings.directoryOrigin === undefined ? {} : { directoryOrigin: bindings.directoryOrigin }),
          host: tunnelHost ?? kernelTunnelHost(),
          origins: allowedOrigins,
          publishTunnel,
        }));
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
      // A tunnel session's open and close are one line each in the daemon's journal; names and counts only.
      sessionLog: tunnelSessionLog({
        step: (what, detail) => ctx.kernel.log.info(detail === undefined ? what : `${what} — ${detail}`),
      }),
    });
  const directProvider = direct ?? new UnavailableCarrier('The direct carrier is unavailable.');
  let held: RelayCarrier[] = [];
  /**
   * The carriers built so far, by what they ARE: an address that dials (`on:`) or an entry that is switched off (`off:`,
   * which opens no socket). Only a carrier that really dials reserves its address, so a switched-off configured entry
   * never keeps an enabled discovered relay at the same address from starting on recovery.
   */
  const built = new Map<string, RelayCarrier>();
  const builtKey = (source: Exclude<RelayCarrierSource, { kind: 'direct-only' }>): string =>
    `${dialledRelayUrl(source) === undefined ? 'off' : 'on'}:${source.config.url}`;
  /**
   * Starts a carrier for every source not already built, then says the trail. Run at start, and again when a
   * background retry recovers (the sources then hold the discovered relay); a carrier already built is never
   * started twice. The trail is built from EVERY dialling carrier's status, so a relay already running is
   * reported as running — never as inactive just because this call did not start it.
   */
  const dial = async (layer: SessionLayer, signal: AbortSignal): Promise<void> => {
    if (bindings === undefined) return;
    const dialled = sources.flatMap(source =>
      source.kind === 'direct-only' || built.has(builtKey(source))
        ? []
        : [
            {
              key: builtKey(source),
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
    for (const { key, carrier } of dialled) {
      built.set(key, carrier);
      held = [...held, carrier];
    }
    for (const { carrier } of dialled) await carrier.start(layer, signal);
    const statuses = new Map<string, CarrierStatus>();
    for (const source of sources) {
      const relayUrl = dialledRelayUrl(source);
      const carrier = source.kind === 'direct-only' ? undefined : built.get(builtKey(source));
      if (relayUrl !== undefined && carrier !== undefined) statuses.set(relayUrl, carrier.status());
    }
    for (const line of relayBootTrail(sources, statuses, { configFile: configFile.file, host: listening().host }))
      ctx.kernel.log.info(line);
  };
  dialRecovered = async () => {
    if (carrierStart !== undefined && !carrierStart.signal.aborted) await dial(carrierStart.layer, carrierStart.signal);
  };
  const relay: Carrier = {
    start: async (layer, signal) => {
      await initialise();
      carrierStart = { layer, signal };
      if (signal.aborted) return;
      await dial(layer, signal);
    },
    status: () => {
      if (bindings === undefined) return { state: 'failed', sentence: 'The relay carrier is unavailable.' };
      // Ready first, then one that is dialling; a switched-off entry listed before an enabled one must not speak for the set.
      return (
        held.find(c => c.status().state === 'ready')?.status() ??
        held.find(c => c.status().state !== 'off')?.status() ??
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
  const reachability: DoctorCheck = {
    id: 'connections.reachability',
    title: 'How other devices reach this daemon',
    run: async () => {
      await initialise();
      const { host } = listening();
      const dialled = sources.find(source => dialledRelayUrl(source) !== undefined);
      const reachable = !isLoopbackHost(host) || dialled !== undefined;
      const lines = [
        reachable
          ? 'reachability other devices can reach this daemon through its own network or a relay'
          : 'reachability nothing off this host can reach this daemon',
        ...sources.map(source => describeRelayCarrierPosture(source, configFile.file)),
      ];
      // Global absence is said once; an inactive sibling beside an active relay is only its own posture.
      if (dialled === undefined && sources[0] !== undefined)
        lines.push(...relayCarrierRemedy(sources[0], configFile.file, host));
      return { state: reachable ? 'ok' : 'warn', detail: lines.join('\n') };
    },
  };
  return {
    // The Kernel calls this without request data, at each outbound fetch/socket. Only this boot's resolved
    // configuration and directory advertisement can grant a host; disabled entries grant nothing.
    resolvers: {
      relay: (): readonly string[] =>
        sources.flatMap(source => {
          const url = dialledRelayUrl(source);
          return url === undefined ? [] : [new URL(url).host];
        }),
    },
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
          const at = listening();
          return {
            advertisement: decideAdvertisement({
              host: at.host,
              ...(at.port === undefined ? {} : { port: at.port }),
              ...(bindings?.publicUrl === undefined ? {} : { operatorPublicUrl: bindings.publicUrl }),
            }),
            ...(at.port === undefined ? {} : { port: at.port }),
            appOrigin: HOSTED_APP_ORIGIN,
            allowedOrigins: allowedOrigins(),
            ...(() => {
              // The origin the one discovery read asks (`initialise`), so links and passkeys name the same directory.
              const origin = directoryOriginOf(bindings?.directoryOrigin ?? HOSTED_RELAY_DIRECTORY_ORIGIN);
              return origin === undefined ? {} : { directoryOrigin: origin };
            })(),
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
      'doctor.checks': () => [{ id: reachability.id, order: -100, item: reachability }],
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
export default implementDaemon(manifest, {
  build: ctx => buildConnections(ctx, kernelConnectionBindings(ctx.kernel)),
  selftest: { webrtc: switchedWebrtcSelftest(configFile) },
});
