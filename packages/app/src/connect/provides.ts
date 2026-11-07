import type { AppImplementation, Manifest } from '@ferretry/kernel/manifest';
import type { DaemonList, PairedDaemon } from '../daemons/daemon-list.ts';
import type { RelayPairingOutcome, SessionDeviceClaim } from '../session/session-client.ts';
import type { CarrierDial } from '../session/session-transport.ts';
import type { SocketLike } from '../session/direct-dial.ts';
import type { PrivateKeyHandle, RelayCrypto } from '../session/wire/index.ts';
import type { SurfaceEntry } from '../surfaces/registry.ts';

/**
 * HOW A PLUGIN APP HALF HELPS THE SHELL REACH A DAEMON (§4.8, §4.13).
 *
 * The shell holds the sealed session and the generated per-daemon client, and nothing else: it holds no device key and
 * chooses no carrier. Two plugins bring those, each through its app half's `shell` section (see
 * {@link provideToShell}), read from the generated surfaces registry like every other half:
 *
 * - **Access** provides the {@link DeviceClaims}: the non-extractable key this device proves each session with (the
 *   `device` session mode, for request and stream sessions) and a fresh key to register (the `pair` mode).
 * - **Connections** provides the {@link CarrierDialer}s: direct, WebRTC, tunnel, relay, in its own order.
 *
 * Only those two may: like the kernel's `session.modes` and `carriers` hooks they mirror (§3.5 takers), a claim from
 * any plugin but Access and a carrier from any plugin but Connections is ignored ({@link CLAIM_TAKERS},
 * {@link CARRIER_TAKERS}). Neither ever receives a daemon client or a transport: a provider hands the shell a key
 * handle or a socket and the shell's session and guard do the rest, so the bootstrap read (§9.6) still comes first
 * and the hash guard still sits in front of every call. They are the session layer's parts, which is why they are
 * built before any daemon is contacted — the one exception to "no plugin code starts before the bootstrap read".
 */

/** The one plugin whose device claims the shell takes (the `device` and `pair` session modes are Access's). */
export const CLAIM_TAKERS: readonly string[] = Object.freeze(['access']);
/** The one plugin whose carriers the shell takes (§4.8: the carrier choice is Connections'). */
export const CARRIER_TAKERS: readonly string[] = Object.freeze(['connections']);

/** The key a `pair` session registers: its SPKI and the private half that proves this browser holds it. */
export interface PairingKey {
  readonly deviceName: string;
  /** The Ed25519 SubjectPublicKeyInfo, base64url. */
  readonly publicKey: string;
  readonly key: PrivateKeyHandle;
}

/**
 * WHICH GRANT THIS DEVICE PROVES ON A DAEMON, and the key that proves it. Access keeps the keys (IndexedDB `fy-access`,
 * §9.4); the shell asks per session and signs that session's transcript through the handle it gets back. A handle is
 * never serialised and never leaves the page.
 */
export interface DeviceClaims {
  /** The `device` claim for this daemon, or `undefined` when this device holds no key for it (it cannot reach yet). */
  claim(daemon: PairedDaemon): Promise<SessionDeviceClaim | undefined>;
  /** A fresh key for a `pair` session with this daemon; Access keeps it pending until the pairing answers. */
  pairingKey(daemonId: string): Promise<PairingKey>;
  /** The pairing was removed: the key that proved it goes with it. */
  forget(daemonId: string): Promise<void>;
}

/**
 * ONE CARRIER: how to open a socket that carries one sealed session to a daemon. Everything it carries is sealed end to
 * end and proved against the fingerprint the pairing pinned, so a carrier can delay or drop a session, never read one.
 */
export interface CarrierDialer {
  /** `direct`, `webrtc`, `tunnel`, `relay`, … */
  readonly id: string;
  /** Lower is tried first. */
  readonly order: number;
  /** A dial for this daemon, or `undefined` when this carrier cannot reach it (the next one is asked). */
  dial(daemon: PairedDaemon): CarrierDial | undefined;
}

/** What a `pair` session needs: the daemon's direct address and fingerprint from the QR, the code, and the key. */
export interface PairDirectInput {
  readonly address: string;
  readonly daemonId: string;
  readonly code: string;
  readonly key: PairingKey;
}

/**
 * The browser objects the composition root binds once and hands to the providers (`src/main.tsx`). A provider reaches
 * no global: the same rule as the shell's own modules, so a provider is testable with fakes and nothing it does can
 * walk around the session.
 */
export interface ConnectPorts {
  /** The session layer's crypto (WebCrypto). */
  readonly crypto: RelayCrypto;
  /** WebCrypto itself, for Access to mint non-extractable Ed25519 keys. */
  readonly subtle: SubtleCrypto;
  /** IndexedDB, or `null` where the browser refuses it (a private window). Each owner opens `fy-<id>` only (§9.4). */
  readonly indexedDB: IDBFactory | null;
  /** Opens one WebSocket. */
  readonly openSocket: (url: string) => SocketLike;
  readonly after: (delayMs: number, run: () => void) => void;
  readonly now: () => number;
  /** The paired daemons on this device: Access adds one after a pairing answers. */
  readonly daemons: DaemonList;
  /**
   * Opens a `pair` session and answers its sealed outcome, unopened (Access parses it). ALWAYS DIRECT: pairing can
   * never be relayed, because a relayed session opens with the device grant the pairing has not issued yet, so first
   * contact with a daemon is the shell's own direct carrier and no plugin's.
   */
  readonly pairDirect: (input: PairDirectInput) => Promise<RelayPairingOutcome>;
}

/** What a plugin app half may hand the shell. Each part is a factory over the {@link ConnectPorts}. */
export interface ShellProvides {
  /** Access only. */
  readonly claims?: (ports: ConnectPorts) => DeviceClaims;
  /** Connections only. */
  readonly carriers?: (ports: ConnectPorts) => readonly CarrierDialer[];
}

/** An app half with its `shell` section. */
export type ShellAppImplementation<M extends Manifest = Manifest> = AppImplementation<M> & {
  readonly shell: ShellProvides;
};

/**
 * Attaches the `shell` section to an app half: `export default provideToShell(implementApp(manifest, {…}), {…})`.
 * The leaf's `AppImplementation` is frozen and framework-neutral, so the shell's own extension rides beside it.
 */
export function provideToShell<M extends Manifest>(
  half: AppImplementation<M>,
  provides: ShellProvides,
): ShellAppImplementation<M> {
  return Object.freeze({ ...half, shell: Object.freeze({ ...provides }) });
}

/** The `shell` section of a registry entry's app half, or `undefined` (none, or a skeleton half). */
export function shellProvidesOf(entry: SurfaceEntry): ShellProvides | undefined {
  const half = entry.app as Partial<ShellAppImplementation> | undefined;
  if (half === undefined || half.skeleton === true) return undefined;
  const provides = half.shell;
  return typeof provides === 'object' && provides !== null ? provides : undefined;
}

/** What the registered providers gave, and which ones failed to build (said, never thrown). */
export interface RegisteredConnect {
  readonly claims: DeviceClaims | undefined;
  readonly carriers: readonly CarrierDialer[];
  readonly failures: readonly { readonly plugin: string; readonly reason: string }[];
}

/**
 * Builds whichever providers are registered: claims from Access, carriers from Connections, from the halves in the
 * generated surfaces registry. A provider that throws is left out (the shell then cannot reach, and says so); a
 * provider from any other plugin is ignored.
 */
export function registeredConnect(surfaces: readonly SurfaceEntry[], ports: ConnectPorts): RegisteredConnect {
  let claims: DeviceClaims | undefined;
  const carriers: CarrierDialer[] = [];
  const failures: { plugin: string; reason: string }[] = [];
  const attempt = <T>(plugin: string, build: () => T): T | undefined => {
    try {
      return build();
    } catch (error) {
      failures.push({ plugin, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  };
  for (const entry of surfaces) {
    const provides = shellProvidesOf(entry);
    if (provides === undefined) continue;
    const makeClaims = provides.claims;
    if (makeClaims !== undefined && claims === undefined && CLAIM_TAKERS.includes(entry.id)) {
      claims = attempt(entry.id, () => makeClaims(ports));
    }
    const makeCarriers = provides.carriers;
    if (makeCarriers !== undefined && CARRIER_TAKERS.includes(entry.id)) {
      carriers.push(...(attempt(entry.id, () => makeCarriers(ports)) ?? []));
    }
  }
  carriers.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { claims, carriers, failures };
}
