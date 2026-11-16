/**
 * The browser carrier router (`app/carriers/router.ts`) as the shell's carrier, through the production path: the
 * shell's `connector` and sealed sessions, Connections' socket walk, and the REAL kernel session layer, with a paired
 * device the kernel admits. Only the network and the timers are scripted. Shared by the router's suites.
 */
import type { PairedDaemon } from '@ferretry/app';
import { connector, fakeDeviceClaims, WebCryptoRelayCrypto } from '@ferretry/app/testing';
import type { BrowserSocket } from '../../app/adapters/browser-relay-dial.ts';
import { CarrierRouter, type CarrierRouterDependencies } from '../../app/carriers/router.ts';
import type { CarrierPreference } from '../../app/lib/carrier-preference.ts';
import { BrowserNetwork, HandTimers, type ScriptedHost } from './browser-network.ts';
import { type KernelFixture, kernelFixture } from './kernel-session.ts';

const shellCrypto = new WebCryptoRelayCrypto();
const DIRECT = 'https://laptop.example.test';

export interface Rig {
  readonly fx: KernelFixture;
  readonly network: BrowserNetwork;
  readonly timers: HandTimers;
  readonly router: CarrierRouter;
  readonly daemon: PairedDaemon;
  readonly connect: (target?: PairedDaemon) => ReturnType<ReturnType<typeof connector>>;
}

export async function rig(
  hosts: Record<string, ScriptedHost>,
  carriers: readonly unknown[],
  preference: CarrierPreference | (() => CarrierPreference) = 'auto',
  hosted: string | null = null,
  openSocket?: (network: BrowserNetwork, fx: KernelFixture) => (url: string) => BrowserSocket,
  /** More router dependencies (a WebRTC dialer, an introducer, a clock); they may override the defaults above. */
  extra:
    | Partial<CarrierRouterDependencies>
    | ((fx: KernelFixture, network: BrowserNetwork, timers: HandTimers) => Partial<CarrierRouterDependencies>) = {},
): Promise<Rig> {
  const fx = await kernelFixture();
  const device = await fx.paired();
  const network = new BrowserNetwork(fx, hosts);
  const timers = new HandTimers();
  const router = new CarrierRouter({
    openSocket: openSocket?.(network, fx) ?? network.openSocket,
    after: timers.after,
    now: () => 0,
    preference: typeof preference === 'function' ? preference : () => preference,
    hostedRelay: async () => hosted ?? undefined,
    ...(typeof extra === 'function' ? extra(fx, network, timers) : extra),
  });
  const daemon: PairedDaemon = {
    daemon: fx.daemonId,
    machine: 'laptop',
    deviceId: device.deviceId,
    address: DIRECT,
    // A pairing made by the current code over the direct address: the positive mark the fallback requires.
    pairedOver: 'direct',
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
  const connect = (target: PairedDaemon = daemon) =>
    connector({
      crypto: shellCrypto,
      claims,
      carriers: [router.dialer()],
      direct: () => {
        throw new Error('the shell’s own direct dial is not used once Connections registered a carrier');
      },
    })(target);
  return { fx, network, timers, router, daemon, connect };
}

export const carriedOver = (fx: KernelFixture): readonly string[] =>
  fx.requests.map(
    request => `${request.path} ${request.arrival.kind === 'carried' ? request.arrival.carrier : 'local'}`,
  );
