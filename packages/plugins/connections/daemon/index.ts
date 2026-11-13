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
  /** Key order never decides whether two lists say the same thing. */
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, inner: unknown) =>
      inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
        : inner,
    );
  const bootRelays = canonical(relays);
  /**
   * THE FILE'S STATE AT BOOT, taken once. An `invalid` file whose accepted last good version is IN EFFECT governs this
   * boot (the kernel says that version survives a restart): `config` above is that accepted document. An `invalid` file with
   * no accepted version in effect has no authority at all, so discovery stays off. A state that cannot be read is no authority either.
   */
  const bootInvalid: { readonly inEffect: boolean } | undefined = (() => {
    try {
      const status = ctx.kernel.config.fileState(configFile);
      return status.state === 'invalid' ? { inEffect: status.inEffect } : undefined;
    } catch {
      return { inEffect: false };
    }
  })();
  const bootHasAuthority = bootInvalid === undefined || bootInvalid.inEffect;
  /**
   * THE ONE GATE. A DISCOVERED RELAY IS PUBLISHED OR DIALLED ONLY WHEN THIS SAYS 'open', ASKED AT THE LAST MOMENT.
   *
   * Every path that publishes or dials a discovered relay — the boot read's answer, the boot carrier start after
   * `initialise`, each carrier start after the previous one's `await`, a recovery's answer, a recovery's dial — asks
   * `mayDialDiscovered()` after its final `await` and nowhere else decides. There is no default that lets one through.
   *
   * - `stopped`: discovery was aborted (the carrier's stop signal, which the Kernel aborts first, or the plugin's own stop).
   * - `unreadable`: the CURRENT configuration is not a clean read. The kernel's config service answers `undefined` or the
   *   last good version for a file it cannot read, never an exception, so the file's STATE is asked as well as its value:
   *   an `invalid` file vetoes whatever its effective value says, EXCEPT the one that was already `invalid` at boot with its
   *   accepted last good version in effect and still is: that accepted document governs (and with no accepted version
   *   in effect at boot nothing governs, so it always vetoes). A file that is simply absent is a clean read.
   * - `changed`: the current relay list differs from the one this boot resolved (a relay of the operator's own,
   *   `enabled: false` included, a discovery entry switched off or removed, any other edit).
   *
   * The current file is read every time — never a copy taken at boot, never a value held across an await.
   */
  const verdict = (): 'open' | 'stopped' | 'unreadable' | 'changed' => {
    if (shuttingDown()) return 'stopped';
    if (!bootHasAuthority) return 'unreadable';
    try {
      const status = ctx.kernel.config.fileState(configFile);
      // Invalid NOW is a veto unless it was invalid at boot too and the accepted version it started from is still in effect.
      if (status.state === 'invalid' && !(bootInvalid !== undefined && status.inEffect)) return 'unreadable';
      return canonical(relaysOf(ctx.kernel.config.file(configFile))) === bootRelays ? 'open' : 'changed';
    } catch {
      return 'unreadable';
    }
  };
  const mayDialDiscovered = (): boolean => verdict() === 'open';
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
  /**
   * THE ONE DISCOVERY CONTROLLER, owned by this plugin. The first read and every retry read use its signal, and it is
   * aborted SYNCHRONOUSLY when shutdown begins. The Kernel aborts every carrier's signal FIRST (before the jobs stop and
   * before any plugin's `onStop` runs, which come one slow `await` at a time), so the carrier's signal — not this plugin's
   * own `onStop` — ends discovery; `onStop` stays as the backstop for a daemon whose carrier never started.
   */
  const discovery = new AbortController();
  const stopRecovery = (): void => {
    discovery.abort();
    retry.stop();
  };
  const shuttingDown = (): boolean => discovery.signal.aborted || ctx.kernel.lifecycle.signal.aborted;
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
    publishSources();
    return resolved;
  };
  /** Publishes the carriers this boot's `sources` say, and the tunnel while there is one. */
  const publishSources = (): void => {
    published = new PublishedCarrierSet(bindings?.directUrl, sources);
    if (tunnelUrl !== undefined) published.tunnel(tunnelUrl);
    ctx.kernel.events.publish(CarriersChanged, { kinds: published.current().map(c => c.kind) });
  };
  /**
   * A veto landed after a discovered relay was already published (the boot read answered, then the gate said no at
   * the carrier start): the discovered source becomes a direct-only one, so the published set, `resolvers.relay()` and the
   * doctor row all agree that nothing dials. Nothing is announced while the daemon stops.
   */
  const withdrawDiscovered = (): void => {
    if (!sources.some(source => source.kind === 'discovered')) return;
    sources = sources.map(source =>
      source.kind === 'discovered' ? { kind: 'direct-only' as const, reason: relayWrittenMeanwhile } : source,
    );
    if (!shuttingDown()) publishSources();
  };
  /** Nothing a late answer says is applied: the sentence says restart, and nothing is resolved, published or dialled. */
  const giveUp = (): void => {
    ctx.kernel.log.info(
      `relay directory retries stopped — the relay configuration in config/${configFile.file} changed or could not be read; restart to apply it`,
    );
    sources = sources.map(source =>
      source.kind === 'direct-only' && source.retrying === true
        ? { kind: 'direct-only' as const, reason: relayWrittenMeanwhile }
        : source,
    );
  };
  const relayWrittenMeanwhile = `the relay configuration in config/${configFile.file} changed or could not be read and the hosted directory was not reached first; restart to dial it`;
  /**
   * A transient failure of the boot read is asked again here, in the background: the same `discovered` source, links
   * and relay carrier as a first-read success once it answers. Definitive answers never come here, and any change to
   * the relay configuration meanwhile (an explicit relay, `enabled: false` too) wins (`relaysUnchanged`) and stops it.
   * Shutdown stops it the moment the carrier's signal aborts, before any slower teardown reaches `onStop`.
   */
  const retry = new RelayDirectoryRetry(
    {
      read: async signal => await directory().read(AbortSignal.any([signal, discovery.signal])),
      after: (ms, fn) => ctx.kernel.clock.after(milliseconds(ms), fn),
      random: Math.random,
      nowMs: () => ctx.kernel.clock.nowMs(),
      stillNeeded: mayDialDiscovered,
    },
    {
      // Still failing: only the sentence changes (the next try's time), so nothing is republished.
      waiting: failed => void adopt(failed, false),
      settled: answer => {
        // The gate before anything is resolved or published. The dial asks again right before each discovered carrier.
        const asked = verdict();
        if (asked === 'stopped') return;
        if (asked !== 'open') return giveUp();
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
      abandoned: () => giveUp(),
    },
  );
  ctx.kernel.lifecycle.onStop(stopRecovery);
  const initialise = (): Promise<void> =>
    (initial ??= (async () => {
      const asked = relayCarriersNeedDiscovery(relays);
      let advertisement = asked ? await directory().read(discovery.signal) : NO_RELAY_DIRECTORY;
      // The gate applies to the FIRST read like every other path: once the daemon is stopping, whatever the read answered
      // is dropped and NOTHING is adopted or published (a configured sibling included); a relay the operator wrote
      // meanwhile (enabled:false too) or a configuration that cannot be read wins over the answer.
      if (shuttingDown()) return;
      if (asked && !mayDialDiscovered()) advertisement = { kind: 'undetermined', reason: relayWrittenMeanwhile };
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
   *
   * A carrier is built and registered only at the moment it is about to start, so a veto reserves nothing. The
   * DISCOVERED one passes `mayDialDiscovered()` immediately before that, after every earlier carrier's `await`; the
   * ones the operator wrote do not (they are not discovery) and stop only for shutdown. A veto withdraws the
   * discovered source, so what was published, what resolves and what dials stay one fact. Dials run one at a time:
   * the boot start and a recovery never both see the same source as unbuilt.
   */
  let dialling: Promise<void> = Promise.resolve();
  const dial = (layer: SessionLayer, signal: AbortSignal): Promise<void> => {
    const next = dialling.then(
      () => dialOne(layer, signal),
      () => dialOne(layer, signal),
    );
    dialling = next.catch(() => undefined);
    return next;
  };
  const dialOne = async (layer: SessionLayer, signal: AbortSignal): Promise<void> => {
    if (bindings === undefined) return;
    for (const source of sources) {
      if (source.kind === 'direct-only' || built.has(builtKey(source))) continue;
      if (signal.aborted || shuttingDown()) return;
      if (source.kind === 'discovered' && !mayDialDiscovered()) {
        withdrawDiscovered();
        continue;
      }
      const carrier = new RelayCarrier({
        config: source.config,
        identity: bindings.identity,
        scheduler,
        now: () => ctx.kernel.clock.nowMs(),
        random: Math.random,
        socketFactory: bindings.socketFactory ?? nativeRelaySocket,
        log: line => ctx.kernel.log.info(line),
      });
      built.set(builtKey(source), carrier);
      held = [...held, carrier];
      await carrier.start(layer, signal);
    }
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
    const start = carrierStart;
    if (start === undefined) return;
    await dial(start.layer, start.signal);
  };
  const relay: Carrier = {
    start: async (layer, signal) => {
      if (signal.aborted) stopRecovery();
      else signal.addEventListener('abort', stopRecovery, { once: true });
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
