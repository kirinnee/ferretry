import type { AppImplementation, Manifest, PluginClient } from '@ferretry/kernel/manifest';
import type { MemberCarriers } from './member.ts';
import type { NavigateOptions } from '../router/router.tsx';
import type { DeclaredFragment, FragmentDecl } from '../router/address.ts';
import type { ScreenRef } from '../layout/engine.ts';
import type { PluginCommandSource } from '../shell/command-sources.ts';
import type { AppHookContext, AppHookProviders } from '../surfaces/app-hooks.ts';
import type { View } from '../surfaces/halves.ts';
import type { DaemonList, PairedDaemon } from '../daemons/daemon-list.ts';
import type { RelayPairingOutcome, SessionDeviceClaim } from '../session/session-client.ts';
import type { CarrierDial, SessionKeyRotation } from '../session/session-transport.ts';
import type { SocketLike } from '../session/direct-dial.ts';
import type { WebCryptoRelayCrypto } from '../session/webcrypto.ts';
import type { OwnerPayload, PrivateKeyHandle, RelayCrypto } from '../session/wire/index.ts';
import type { ShellPluginClient } from '../client/daemon-client.ts';
import type { SurfaceEntry } from '../surfaces/registry.ts';
import type { LinkProvision } from '../ui/external-link.tsx';
import { PASSKEY_TAKERS, type PasskeyPorts, type PasskeyProvision } from '../passkey/passkey.ts';

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
/** The one plugin whose link behaviour the shell takes (S7): where a link opens is Browsers'. */
export const LINK_TAKERS: readonly string[] = Object.freeze(['browsers']);
/** The one plugin whose carriers the shell takes (§4.8: the carrier choice is Connections'). */
export const CARRIER_TAKERS: readonly string[] = Object.freeze(['connections']);

/** The key a `pair` session registers: its SPKI and the private half that proves this browser holds it. */
export interface PairingKey {
  readonly deviceName: string;
  /** The Ed25519 SubjectPublicKeyInfo, base64url. */
  readonly publicKey: string;
  readonly key: PrivateKeyHandle;
  /** P28: validate Access's answer and persist this key only after the shell receives sealed `paired`. */
  readonly save: (response: OwnerPayload) => Promise<void>;
}

/**
 * WHICH GRANT THIS DEVICE PROVES ON A DAEMON, and the key that proves it. Access keeps the keys (IndexedDB `fy-access`,
 * §9.4); the shell asks per session and signs that session's transcript through the handle it gets back. A handle is
 * never serialised and never leaves the page.
 */
export interface DeviceClaims {
  /** The `device` claim for this daemon, or `undefined` when this device holds no key for it (it cannot reach yet). */
  claim(daemon: PairedDaemon): Promise<SessionDeviceClaim | undefined>;
  /** A fresh, memory-only key; the shell calls its `save` only after the pairing answers `paired`. */
  pairingKey(daemonId: string): Promise<PairingKey>;
  /** The pairing was removed: the key that proved it goes with it. */
  forget(daemonId: string): Promise<void>;
  /**
   * Replacing the key inside the next passkey ceremony once the daemon says it is due (R248), and the one retry with
   * the pending key that keeps a device whose answer was lost from being stranded (R252). Access's `KeyRotation` over
   * the same key store; absent, the shell never rotates (and a due device's unlock is refused).
   */
  readonly rotation?: SessionKeyRotation;
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
  /** The lane carrier-control requests ride instead (R634); absent, they ride {@link dial} like any other. */
  readonly control?: CarrierControl;
}

/**
 * WHAT ONE CARRIER-CONTROL REQUEST RIDES (§15 "The choice", R634): `GET` and `PUT /v1/tunnel` travel the daemon's own
 * address or a rendezvous, never the tunnel or WebRTC, whatever the preference is — switching the tunnel on cannot
 * ride the tunnel it turns on, and switching it off over itself would end the connection carrying the answer. The
 * shell sends every request whose path is in `paths` over a session of its own opened through `dial`, and the carrier
 * remembers no winner from it. Copied from today's `DaemonCarrierRouter.control`.
 */
export interface CarrierControl {
  /** The request paths that are carrier control, matched exactly. */
  readonly paths: readonly string[];
  /** A dial over the introducing carriers only, or `undefined` when none reaches this daemon. */
  dial(daemon: PairedDaemon): CarrierDial | undefined;
}

/** One carrier a pairing may cross, in the order the walk tries it. */
export interface PairingLeg {
  readonly kind: 'direct' | 'relay';
  /** The daemon's direct address, or the rendezvous origin. */
  readonly address: string;
  readonly dial: CarrierDial;
  /** How long this leg's session may take to answer before the walk moves on. The heartbeat grace by default. */
  readonly deadlineMs?: number;
}

/**
 * One redemption over one leg, answered by the daemon's own sealed outcome (the shell's session). Rejects with
 * `RelayPairingRefusedError` for a refusal inside the channel, with `PairingOutcomeUnknownError` when the code was sent
 * and the session ended before the answer, and with a `RelaySessionError` when nothing reached the daemon.
 */
export type PairingAttempt = (leg: PairingLeg) => Promise<RelayPairingOutcome>;

/** A pairing's sealed outcome and the carrier that carried it. */
export type PairedOver = RelayPairingOutcome & {
  readonly via: { readonly kind: 'direct' | 'relay'; readonly address: string };
};

/**
 * WHICH CARRIERS FIRST CONTACT WALKS (Connections only; R582, R633): the daemon's own address first, always, then the
 * one rendezvous this build discovered, whatever the connection preference. The shell opens each leg's sealed `pair`
 * session ({@link PairingAttempt}), so the daemon is proved against the QR's fingerprint before the code leaves the
 * page on every leg; Connections decides the order, the deadlines, when a failure advances the walk and how a walk
 * that failed everywhere is reported. Copied from today's `relay-pairing.ts` and `exchangePairing`.
 */
export interface PairingCarriers {
  pair(input: PairDirectInput, attempt: PairingAttempt): Promise<PairedOver>;
}

/**
 * The one network read a provider may make that is not a session: the hosted relay directory's public advertisement
 * (R580). The shell answers only a `GET` to the build-time directory origin (`__FY_RELAY_DIRECTORY__`) and refuses
 * every other address, so this can never become a daemon request that skips the session.
 */
export type DirectoryFetch = (url: string, init?: RequestInit) => Promise<Response>;

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
  /** The session layer's crypto (WebCrypto), with the device-key half Access mints and wraps its keys through. */
  readonly crypto: RelayCrypto & Pick<WebCryptoRelayCrypto, 'generateDeviceKey' | 'deviceKeyHandle'>;
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
  /**
   * Opens a `pair` session over the carriers Connections' {@link PairingCarriers} walks (direct first, then the one
   * discovered rendezvous; R582) and answers the outcome with the carrier that carried it. With no walk registered it
   * is {@link pairDirect} over the pairing's address.
   */
  readonly pair?: (input: PairDirectInput) => Promise<PairedOver>;
  /** The hosted relay directory read ({@link DirectoryFetch}); absent when this build names no directory. */
  readonly directory?: DirectoryFetch;
}

/**
 * WHAT A DAEMON-LESS SCREEN IS GIVEN, AND ALL IT IS GIVEN (a share link's landing page, first-run setup, the page a pairing
 * link opens on a device that has no daemon yet). It is the session layer's parts and the paired list, and no more:
 *
 * - NO CLIENT, NO TRANSPORT, NO SOCKET, NO DIRECTORY. A daemon-less screen has no daemon to talk to, so it is handed no
 *   default one, not the first, not the last used. Its only ways to a daemon are the pairing exchange ({@link pair},
 *   {@link pairDirect}: the carriers Connections' walk gives, in the order the protocol says) and, for Catalogs, its own
 *   member transport (a part of its own, never reached through here).
 * - It reads the paired list and may add to it (a pairing answers by adding the daemon it paired with).
 */
export type DaemonlessPorts = Pick<
  ConnectPorts,
  'crypto' | 'subtle' | 'indexedDB' | 'now' | 'after' | 'pairDirect' | 'pair'
> & { readonly daemons: PairedList };

/**
 * THE PAIRED LIST AS A DAEMON-LESS SCREEN MAY USE IT: read it and follow it, choose one, forget one, and add the one a
 * pairing just answered with. Nothing else of the {@link DaemonList}: not its carriers, not its caches, not a rename.
 * It holds no client; it is the list a device-less visitor already sees.
 */
export type PairedList = Pick<DaemonList, 'snapshot' | 'subscribe' | 'select' | 'remove' | 'add'>;

/**
 * THE PROPS OF A DAEMON-LESS SCREEN: where the page is (its route's parameters, an address read on demand) and how to
 * leave it. There is NO field a daemon client could ride in, by type; a test also probes what is rendered.
 */
export interface DaemonlessScreenProps {
  /** The route's parameters (`/join/:tab` → `{ tab }`). */
  readonly params: Readonly<Record<string, string>>;
  /** Moves to another address; `replace` swaps this entry instead of adding one (a link whose secret was taken). */
  readonly navigate: (to: string, options?: NavigateOptions) => void;
  /**
   * The address this tab was opened at, fragment included, READ ON DEMAND so a screen takes what it needs once and
   * keeps nothing: a pairing link's fragment carries a single-use code.
   */
  readonly location: () => string;
}

/** The daemon-less screens of one plugin, by screen id. */
export type DaemonlessViews = Readonly<Record<string, View<DaemonlessScreenProps>>>;

/** What a device view is drawn with (S3): where to go, and nothing about any daemon. */
export interface DeviceViewProps {
  readonly navigate: (to: string, options?: NavigateOptions) => void;
}

/**
 * What a background view is drawn with (S5, R3 MJ1): the paired daemon it runs for, and the plugin's OWN client there
 * in BACKGROUND passkey origin — every call from it is a background read, whatever its method, so a call to a locked
 * machine waits for the unlock and never raises a prompt. It is the `background` entry of the one client cache.
 */
export interface BackgroundViewProps {
  readonly daemon: string;
  readonly client: PluginClient;
}

/**
 * One nav entry's count on ONE machine, built per daemon and EAGERLY (like an app hook) over that daemon's cache client
 * — the half need not be built (R3 m8). The frame draws the SUM over every paired daemon where the plugin is allowed (MA5).
 */
export interface NavBadge {
  /** This machine's share; a sum of 0 draws no badge. */
  readonly count: () => number;
  readonly subscribe: (changed: () => void) => () => void;
}

/** What a plugin app half may hand the shell. Each part is a factory over the {@link ConnectPorts}. */
export interface ShellProvides {
  /**
   * Any plugin: views the frame mounts ONCE PER PAIRED DAEMON where the plugin may run, at the frame root and outside the
   * router (S5) — a watcher that renders nothing, or an overlay (a toast, a sheet). Each is handed its background-origin
   * client as a prop, and its `useEveryDaemon` rows are background-origin too (`place: 'background'`), so nothing it
   * sends raises a passkey prompt. It unmounts when the plugin is blocked or paused there or the daemon is unpaired.
   */
  readonly background?: Readonly<Record<string, View<BackgroundViewProps>>>;
  /**
   * Any plugin: the views of the panels its manifest declares in `device.settings` (S4, M3), drawn on this device's
   * settings page under the Appearance block, by order. They are drawn with NO daemon and NO client; a panel that needs
   * machines lists them with `useEveryDaemon`, one row per machine (`place: 'device-panel'`).
   */
  readonly deviceSettings?: Readonly<Record<string, View<Record<string, never>>>>;
  /**
   * Any plugin: the views of the panels its manifest declares in `nav` (S4, R3 MJ3). A nav panel is device-level: drawn
   * ONCE under the nav entries (a column nav only), with no daemon and no client, so the nav can never show one machine's
   * blocked or paused line; it lists machines with `useEveryDaemon`.
   */
  readonly navPanels?: Readonly<Record<string, View<Record<string, never>>>>;
  /**
   * Any plugin: a count on the nav entry of one of its own screens (key = the screen id, which must declare `nav`),
   * built per daemon over that daemon's cache client. The badge is the SUM across every paired daemon where the plugin
   * is allowed: a blocked, paused, skeleton or locked machine adds 0, and a machine never opened still counts.
   */
  readonly navBadges?: Readonly<Record<string, (ctx: AppHookContext) => NavBadge>>;
  /**
   * Browsers only (`LINK_TAKERS`): where a tap on an external link opens, built PER DAEMON like an app hook, over
   * Browsers' own client there. `destination(href)` says what a tap will do ON THAT MACHINE before it happens (the
   * anchor's title, the sheet's heading); the `sheet` is drawn once per machine at the frame root. Any other provider
   * is ignored.
   */
  readonly links?: (ctx: AppHookContext) => LinkProvision;
  /** Access only. */
  readonly claims?: (ports: ConnectPorts) => DeviceClaims;
  /** Connections only. */
  readonly carriers?: (ports: ConnectPorts) => readonly CarrierDialer[];
  /** Connections only: the carriers a pairing walks. */
  readonly pairing?: (ports: ConnectPorts) => PairingCarriers;
  /** Connections only; NOT IMPLEMENTED YET: the carriers a member session walks to a publisher this browser is not paired with. */
  readonly member?: (ports: ConnectPorts) => MemberCarriers;
  /**
   * Access only: the passkey handler every daemon call consults on a refusal, and the prompts the shell mounts
   * (`passkey/passkey.ts`). Built with the runtime, after the session parts: its ceremony rides Access's own client.
   */
  readonly passkey?: (ports: PasskeyPorts) => PasskeyProvision;
  /**
   * Any plugin: entries for the command bar, built per daemon over that plugin's own guarded client. Unlike the three
   * session parts (claims, carriers, pairing) it is NOT built before the bootstrap read: the bar builds it on a daemon.
   */
  readonly commands?: PluginCommandSource;
  /**
   * Any plugin: values for the app hooks another plugin's half offers (`<offerer>.<name>`, named in the offerer's
   * contract), each built per daemon over this plugin's own guarded client (`shell/app-hooks.ts`). Like `commands`,
   * built on a daemon, after its bootstrap read, and only while this plugin may run there.
   */
  readonly hooks?: AppHookProviders;
  /**
   * Any plugin: the views of the screens its manifest declares `daemonless: true`, built once before any daemon is
   * contacted, over the {@link DaemonlessPorts} and nothing else. A screen id the manifest does not declare as
   * daemon-less is ignored, so a per-daemon screen can never be mounted without its daemon this way.
   */
  readonly daemonless?: (ports: DaemonlessPorts) => DaemonlessViews;
  /**
   * Any plugin: the address fragments it owns (S3, `router/address.ts`). A keyed key is taken only by this plugin's
   * device view; a path declaration names one of its own daemon-less screens. `strip: false` claims a key and leaves it.
   */
  readonly fragments?: readonly FragmentDecl[];
  /**
   * Any plugin: its device views (S3, MA2), each mounted once at the frame root with no daemon and no client of its
   * own, under `WithoutShell`; it may list machines (`useEveryDaemon`) and take its keyed fragments (`useFragment`).
   */
  readonly device?: Readonly<Record<string, View<DeviceViewProps>>>;
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
function shellProvidesOf(entry: SurfaceEntry): ShellProvides | undefined {
  const half = entry.app as Partial<ShellAppImplementation> | undefined;
  if (half === undefined || half.skeleton === true) return undefined;
  const provides = half.shell;
  return typeof provides === 'object' && provides !== null ? provides : undefined;
}

/** What the registered providers gave, and which ones failed to build (said, never thrown). */
export interface RegisteredConnect {
  readonly claims: DeviceClaims | undefined;
  readonly carriers: readonly CarrierDialer[];
  readonly pairing: PairingCarriers | undefined;
  readonly member: MemberCarriers | undefined;
  readonly failures: readonly { readonly plugin: string; readonly reason: string }[];
}

/**
 * Builds whichever providers are registered: claims from Access, carriers from Connections, from the halves in the
 * generated surfaces registry. A provider that throws is left out (the shell then cannot reach, and says so); a
 * provider from any other plugin is ignored.
 */
export function registeredConnect(surfaces: readonly SurfaceEntry[], ports: ConnectPorts): RegisteredConnect {
  let claims: DeviceClaims | undefined;
  let pairing: PairingCarriers | undefined;
  let member: MemberCarriers | undefined;
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
    const makeMember = provides.member;
    if (makeMember !== undefined && member === undefined && CARRIER_TAKERS.includes(entry.id)) {
      member = attempt(entry.id, () => makeMember(ports));
    }
    const makePairing = provides.pairing;
    if (makePairing !== undefined && pairing === undefined && CARRIER_TAKERS.includes(entry.id)) {
      pairing = attempt(entry.id, () => makePairing(ports));
    }
  }
  carriers.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { claims, carriers, pairing, member, failures };
}

/** The passkey provision the registered halves gave, and the failure to build it (said, never thrown). */
export interface RegisteredPasskey {
  readonly passkey: PasskeyProvision | undefined;
  readonly failures: readonly { readonly plugin: string; readonly reason: string }[];
}

/**
 * What the composition root hands {@link registeredPasskey}: {@link PasskeyPorts} except that the client is asked for BY
 * plugin, so the host never names the provider (the registry does).
 */
export type PasskeyHostPorts = Omit<PasskeyPorts, 'client'> & {
  readonly clientOf: (daemon: string, plugin: string) => ShellPluginClient | undefined;
};

/**
 * Builds the ONE passkey provision (G105: one prompt, no second implementation): Access's, from the generated surfaces
 * registry. A provision from any other plugin is ignored; one that throws is left out, and then a passkey refusal is
 * simply returned as it came (nothing asks).
 */
export function registeredPasskey(surfaces: readonly SurfaceEntry[], host: PasskeyHostPorts): RegisteredPasskey {
  const { clientOf, ...rest } = host;
  for (const entry of surfaces) {
    const make = shellProvidesOf(entry)?.passkey;
    if (make === undefined || !PASSKEY_TAKERS.includes(entry.id)) continue;
    try {
      return { passkey: make({ ...rest, client: daemon => clientOf(daemon, entry.id) }), failures: [] };
    } catch (error) {
      return {
        passkey: undefined,
        failures: [{ plugin: entry.id, reason: error instanceof Error ? error.message : String(error) }],
      };
    }
  }
  return { passkey: undefined, failures: [] };
}

/** The daemon-less views the registered halves gave, by `<plugin>.<screen>`, and the ones that failed (said, never thrown). */
export interface RegisteredDaemonless {
  readonly views: ReadonlyMap<string, View<DaemonlessScreenProps>>;
  readonly failures: readonly { readonly plugin: string; readonly reason: string }[];
}

/**
 * Builds every plugin's daemon-less screens from the generated surfaces registry. Only a screen the plugin's manifest
 * declares `daemonless: true` is taken: a view for any other id is dropped. A factory that throws costs only its own
 * plugin's screens.
 */
export function registeredDaemonless(surfaces: readonly SurfaceEntry[], ports: DaemonlessPorts): RegisteredDaemonless {
  const views = new Map<string, View<DaemonlessScreenProps>>();
  const failures: { plugin: string; reason: string }[] = [];
  for (const entry of surfaces) {
    const make = shellProvidesOf(entry)?.daemonless;
    if (make === undefined) continue;
    const declared = new Set(
      (entry.manifest.ui?.screens ?? []).filter(screen => screen.daemonless === true).map(screen => screen.id),
    );
    try {
      for (const [id, view] of Object.entries(make(ports))) {
        if (declared.has(id)) views.set(`${entry.id}.${id}`, view);
      }
    } catch (error) {
      failures.push({ plugin: entry.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { views, failures };
}

/** Every plugin's declared fragments, with the screen each path declaration names (a screen it lacks names none). */
export function registeredFragments(
  surfaces: readonly SurfaceEntry[],
  screenOf: (plugin: string, screen: string) => ScreenRef | undefined,
): readonly DeclaredFragment[] {
  return surfaces.flatMap(entry =>
    (shellProvidesOf(entry)?.fragments ?? []).map(decl => {
      const screen = decl.form === 'path' ? screenOf(entry.id, decl.screen) : undefined;
      return screen === undefined ? { plugin: entry.id, decl } : { plugin: entry.id, decl, screen };
    }),
  );
}

/** One plugin's device view, as the host mounts it. */
export interface RegisteredDeviceView {
  readonly plugin: string;
  readonly id: string;
  readonly view: View<DeviceViewProps>;
}

/** Every plugin's device views, in registry order (a skeleton half provides none). */
export function registeredDeviceViews(surfaces: readonly SurfaceEntry[]): readonly RegisteredDeviceView[] {
  return surfaces.flatMap(entry =>
    Object.entries(shellProvidesOf(entry)?.device ?? {}).map(([id, view]) => ({ plugin: entry.id, id, view })),
  );
}

/** One plugin's background view, as the host mounts it (once per paired daemon where the plugin may run). */
export interface RegisteredBackgroundView {
  readonly plugin: string;
  readonly id: string;
  readonly view: View<BackgroundViewProps>;
}

/** Every plugin's background views, in registry order (a skeleton half provides none). */
export function registeredBackgroundViews(surfaces: readonly SurfaceEntry[]): readonly RegisteredBackgroundView[] {
  return surfaces.flatMap(entry =>
    Object.entries(shellProvidesOf(entry)?.background ?? {}).map(([id, view]) => ({ plugin: entry.id, id, view })),
  );
}

/** One plugin's device-level panel (a `device.settings` or `nav` panel), as the frame draws it. */
export interface RegisteredDevicePanel {
  readonly plugin: string;
  readonly id: string;
  readonly view: View<Record<string, never>>;
}

/** The slots whose panels are device-level, and the `shell` section that holds their views. */
export type DevicePanelSlot = 'device.settings' | 'nav';

const DEVICE_PANEL_SECTION = { 'device.settings': 'deviceSettings', nav: 'navPanels' } as const;

/**
 * The device-level panels the registered halves gave for one slot, by `<plugin>.<panel>`. Only a panel the plugin's
 * manifest declares in that slot is taken: a view for any other id is dropped, so a per-daemon panel can never be drawn
 * without its daemon this way.
 */
export function registeredDevicePanels(
  surfaces: readonly SurfaceEntry[],
  slot: DevicePanelSlot,
): ReadonlyMap<string, RegisteredDevicePanel> {
  const panels = new Map<string, RegisteredDevicePanel>();
  for (const entry of surfaces) {
    const declared = new Set(
      (entry.manifest.ui?.panels ?? []).filter(panel => panel.slot === slot).map(panel => panel.id),
    );
    for (const [id, view] of Object.entries(shellProvidesOf(entry)?.[DEVICE_PANEL_SECTION[slot]] ?? {})) {
      if (declared.has(id)) panels.set(`${entry.id}.${id}`, { plugin: entry.id, id, view });
    }
  }
  return panels;
}

/** One plugin's nav badge provider for one of its own nav screens. */
export interface RegisteredNavBadge {
  readonly plugin: string;
  readonly screen: string;
  readonly provide: (ctx: AppHookContext) => NavBadge;
}

/** Every nav badge the registered halves gave, for a screen the plugin's manifest declares with a `nav` entry. */
export function registeredNavBadges(surfaces: readonly SurfaceEntry[]): readonly RegisteredNavBadge[] {
  return surfaces.flatMap(entry => {
    const withNav = new Set(
      (entry.manifest.ui?.screens ?? []).filter(screen => screen.nav !== undefined).map(screen => screen.id),
    );
    return Object.entries(shellProvidesOf(entry)?.navBadges ?? {}).flatMap(([screen, provide]) =>
      withNav.has(screen) ? [{ plugin: entry.id, screen, provide }] : [],
    );
  });
}

/** The one link provider the registered halves gave (Browsers'; any other plugin's is ignored), or `undefined`. */
export function registeredLinkProvider(
  surfaces: readonly SurfaceEntry[],
): { readonly plugin: string; readonly provide: (ctx: AppHookContext) => LinkProvision } | undefined {
  for (const entry of surfaces) {
    const provide = shellProvidesOf(entry)?.links;
    if (provide !== undefined && LINK_TAKERS.includes(entry.id)) return { plugin: entry.id, provide };
  }
  return undefined;
}
