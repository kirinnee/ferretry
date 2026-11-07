/**
 * STAND-INS for what Access's app half (pairing, devices, QR, push enrolment, device keys) needs and nothing in 5.0
 * provides yet (port brief: "if it has no home yet, keep the import pointing at a single local file"). Every item says
 * where it came from today, whether `origin/rebuild/spine-app-shell` has it (and where), and what should replace it.
 *
 * TWO KINDS, AND THE LINE BETWEEN THEM IS DELIBERATE:
 *
 * - A SHORT COPY of today's code, for pure facts that carry no runtime identity: types, sentences, constants, and
 *   total functions over plain values (the daemon-connection value rules, the published-carrier mapping the §14
 *   pairing check reads, the base64url encoder). A copy here behaves exactly as today's does.
 * - A TYPED STAND-IN that throws, for everything that IS the shell: its components and hooks, its daemon client,
 *   its transport (whose request binding is a symbol only the router knows), its network, timers and routes, and the
 *   session client's errors whose class identity the session code itself must throw. Copying any of those would
 *   give the app two of them, and the pair would disagree at runtime. Each throws the same sentence naming itself, so
 *   a screen that reaches one before the shell lands fails loudly rather than quietly doing the wrong thing.
 *
 * REPLACE each with the app shell's own export (or a contract's, where noted) when it lands; nothing here is a design.
 *
 * ONE COPY PER NAME ACROSS ACCESS'S APP HALF: `cn`, `IFyApiClient`, `useDaemonClient`, `useDialogFocus` and
 * `toBase64Url` are held by the grants half's seam (`shell-grants.ts`) and re-exported below, not copied twice.
 */
import type { ReactNode } from 'react';
import { z } from 'zod';
import {
  DaemonOriginSchema,
  type PublishedCarrier,
  SocketEndpointSchema,
  TunnelOriginSchema,
} from '@ferretry/plugin-connections/contract';
import { type AdvertisementRefusal, WILDCARD_BIND_HOST } from '../contract/index.ts';
import type { IFyApiClient } from './shell-grants.ts';

/** The one sentence every throwing stand-in answers with. */
const fromShell = (name: string): never => {
  throw new Error(`${name} comes from the app shell, which this build of Access does not have yet`);
};

// ─── 1. carriers (today: `relay/src/lib/connection.ts`; spine-app-shell: walked inside `src/session/`) ──────────

/**
 * One way this browser may dial a daemon. COPY of today's `ConnectionMethodSchema`, built from the connections
 * contract's own address schemas so the dialable rule stays theirs. REPLACE WITH: the app shell's carrier type.
 */
export const ConnectionMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct'), daemonUrl: DaemonOriginSchema }),
  z.strictObject({ kind: z.literal('webrtc') }),
  z.strictObject({ kind: z.literal('tunnel'), tunnelUrl: TunnelOriginSchema }),
  z.strictObject({
    kind: z.literal('relay'),
    relayUrl: SocketEndpointSchema,
    operator: z.enum(['self', 'hosted']).optional(),
  }),
]);
export type ConnectionMethod = z.infer<typeof ConnectionMethodSchema>;

/** Every carrier kind, in the order the protocol walks them by default (§15, Auto). COPY. */
const CONNECTION_KINDS = ['direct', 'webrtc', 'tunnel', 'relay'] as const;

const kindRank = (method: ConnectionMethod): number => CONNECTION_KINDS.indexOf(method.kind);

/** Direct, then WebRTC, then a tunnel, then a relay; stable within a kind. COPY of `connectionPreferenceOrder`. */
export function connectionPreferenceOrder(methods: readonly ConnectionMethod[]): readonly ConnectionMethod[] {
  return [...methods].sort((left, right) => kindRank(left) - kindRank(right));
}

/**
 * A daemon's PUBLISHED carrier set as carriers this browser will dial, in the order it will try them. An entry the
 * protocol will not dial is dropped rather than refusing the set; `operator` is disclosure only, derived by comparing
 * against the hosted address this browser discovered for itself. COPY of today's `publishedConnectionMethods`.
 */
export function publishedConnectionMethods(
  carriers: readonly PublishedCarrier[],
  hostedRelayUrl?: string,
): readonly ConnectionMethod[] {
  const methods: ConnectionMethod[] = [];
  for (const carrier of carriers) {
    const parsed = ConnectionMethodSchema.safeParse(
      carrier.kind === 'direct'
        ? { kind: 'direct', daemonUrl: carrier.url }
        : carrier.kind === 'tunnel'
          ? { kind: 'tunnel', tunnelUrl: carrier.url }
          : {
              kind: 'relay',
              relayUrl: carrier.url,
              operator: carrier.url === hostedRelayUrl ? 'hosted' : 'self',
            },
    );
    if (parsed.success) methods.push(parsed.data);
  }
  return connectionPreferenceOrder(methods);
}

// ─── 2. the paired daemon (today: `pwa/src/lib/daemon-connection.ts`; spine-app-shell: `src/daemons/daemon-list.ts`
//        holds a `PairedDaemon` of a different shape) ─────────────────────────────────────────────────────────────

export type DaemonId = string & { readonly daemonId: unique symbol };

/** The relay half of a connection's carrier set. */
export type RelayCarrier = Extract<ConnectionMethod, { kind: 'relay' }>;

/** The tunnel half (§15): a Cloudflare hostname dialled like a direct address. */
export type TunnelCarrier = Extract<ConnectionMethod, { kind: 'tunnel' }>;

export interface DaemonConnectionInput {
  daemonId: string;
  baseUrl: string;
  deviceId: string;
  daemonName?: string | undefined;
  carriers?: readonly ConnectionMethod[] | undefined;
}

/** A paired daemon. COPY of today's interface; REPLACE WITH the shell's paired-daemon record. */
export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  /** Which grant this browser holds. An IDENTITY, not a credential: the device KEY proves it. */
  readonly deviceId: string;
  /** What the daemon calls its machine — its host name, from the pairing response. */
  readonly daemonName?: string;
  /** The daemon's published carrier set, cached in the order the protocol tries it. */
  readonly carriers: readonly ConnectionMethod[];
}

/** A pairing as the browser-local registry keeps it. COPY of today's `connections.ts` record. */
export interface DaemonConnectionRecord extends DaemonConnection {
  readonly label?: string;
  readonly pairedAt: number;
  readonly lastSelectedAt: number;
}

const requireNonEmpty = (value: string, name: string): string => {
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
  return value;
};

/** Validates the durable daemon identity supplied by a successful pairing. COPY. */
export const daemonId = (value: string): DaemonId => requireNonEmpty(value, 'daemonId') as DaemonId;

/**
 * Normalizes only a daemon origin supplied at runtime: credentials, paths, queries and fragments are refused so every
 * adapter resolves the same `/v1` surface. COPY.
 */
export const daemonBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('daemon URL must be absolute');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('daemon URL must use http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('daemon URL may not include credentials, a query, or a fragment');
  }
  if (url.pathname !== '/') throw new Error('daemon URL must be an origin without a path');
  return url.origin;
};

const daemonRelayCarrier = (value: RelayCarrier): RelayCarrier => {
  const parsed = ConnectionMethodSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== 'relay') throw new Error('relay carrier is not a dialable rendezvous');
  return parsed.data;
};

const daemonTunnelCarrier = (value: unknown): TunnelCarrier | undefined => {
  const parsed = ConnectionMethodSchema.safeParse(value);
  return parsed.success && parsed.data.kind === 'tunnel' ? parsed.data : undefined;
};

/** One cached carrier, validated, or dropped. WebRTC is never cached: no daemon publishes one. */
const daemonCarrier = (value: ConnectionMethod): ConnectionMethod | undefined => {
  if (value.kind === 'direct') return { kind: 'direct', daemonUrl: daemonBaseUrl(value.daemonUrl) };
  if (value.kind === 'webrtc') return undefined;
  if (value.kind === 'tunnel') {
    const tunnel = daemonTunnelCarrier(value);
    if (tunnel === undefined) throw new Error('tunnel carrier is not a bare https origin');
    return tunnel;
  }
  return daemonRelayCarrier(value);
};

/**
 * An immutable connection from runtime pairing output. A PAIRED DAEMON IS NEVER CARRIER-LESS: an absent or emptied set
 * falls back to `baseUrl`, the address the exchange succeeded over. COPY.
 */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => {
  const baseUrl = daemonBaseUrl(input.baseUrl);
  const name = input.daemonName?.trim() || undefined;
  const direct: ConnectionMethod = { kind: 'direct', daemonUrl: baseUrl };
  const carriers = connectionPreferenceOrder(
    (input.carriers ?? [direct]).flatMap(carrier => daemonCarrier(carrier) ?? []),
  );
  return {
    daemonId: daemonId(input.daemonId),
    baseUrl,
    deviceId: requireNonEmpty(input.deviceId, 'deviceId'),
    ...(name === undefined ? {} : { daemonName: name }),
    carriers: carriers.length === 0 ? [direct] : carriers,
  };
};

/** The name a machine is shown by: the owner's label, then the daemon's own name, then its address. COPY. */
export const daemonDisplayName = (connection: DaemonConnection & { readonly label?: string }): string =>
  connection.label?.trim() || connection.daemonName || connection.baseUrl;

// ─── 3. bytes and keys (today: `relay/src/lib/binary.ts`, `crypto.ts`; spine-app-shell: `src/session/wire/`) ───

/** Base64url without padding (spine-app-shell: `src/session/wire/binary.ts`). Held by `shell-grants.ts`. */
export { toBase64Url } from './shell-grants.ts';

/** An opaque private key the session signs with. COPY (spine-app-shell: `src/session/wire/crypto.ts`). */
export interface PrivateKeyHandle {
  readonly algorithm: 'X25519' | 'Ed25519';
}

// ─── 4. the session client's sentences and errors (today: `pwa/src/lib/relay-carrier.ts`, `relay-session.ts`) ──

/** Said when this machine no longer accepts this browser's device. COPY of today's sentence (parity). */
export const DEVICE_NOT_ACCEPTED_SENTENCE =
  'This machine no longer accepts this browser — it was removed, or went unused for too long. Pair it again to keep using it.';

/**
 * A sealed `pair-refused`: the daemon judged this code. COPY of today's class so the pairing screen can tell a refusal
 * from a transport failure. REPLACE WITH the session client's own export: `instanceof` only works when the session
 * code throws THIS class, so until the shell lands no refusal reaches the screen as one.
 */
export class RelayPairingRefusedError extends Error {
  constructor() {
    super('this pairing code is wrong, expired or already spent');
    this.name = 'RelayPairingRefusedError';
  }
}

// ─── 5. the daemon client and transport (today: `protocol/src/lib/client.ts`, `pwa/src/lib/runtime-models.ts`,
//        `daemon-transport.ts`; spine-app-shell: `src/client/daemon-client.ts`, whose plugin client is `call`) ──────

/** The header a mutation carries so a retried write is applied once. COPY of today's constant. */
export const FY_REQUEST_ID_HEADER = 'x-fy-request-id';

/**
 * The only client capability Access's app half uses (today's `IFyApiClient['request']`), and the routed client the
 * store hands every surface (today's `store.tsx` `useDaemonClient`, a stand-in). Both held by `shell-grants.ts`.
 */
export { type IFyApiClient, useDaemonClient } from './shell-grants.ts';

/** A failed daemon answer, with its status and code. COPY of today's class. */
export class DaemonResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DaemonResponseError';
  }
}

export type DaemonFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The page's network, wrapped so it is never called with the wrong receiver. STAND-IN: the shell owns the network. */
export const browserFetch: DaemonFetch = async () => fromShell('browserFetch');

export interface DaemonRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** A request bound to one paired daemon (the router routes by a symbol on `init`). STAND-IN. */
export function daemonRequest(_daemon: DaemonConnection, _path: string, _init?: RequestInit): DaemonRequest {
  return fromShell('daemonRequest');
}

/** The deadline every per-machine read gives up after. COPY of today's constant. */
export const MACHINE_READ_DEADLINE_MS = 20_000;

/** `read`, bounded by a deadline (a timer: the shell's clock). STAND-IN. */
export function withDeadline<T>(_read: Promise<T>, _deadlineMs?: number): Promise<T> {
  return fromShell('withDeadline');
}

/** The script URL a service worker is registered from, through the page's Trusted Types policy. STAND-IN. */
export function trustedWorkerUrl(_url: string): string {
  return fromShell('trustedWorkerUrl');
}

/** Per-daemon notification delivery preference (today: `notification-preferences.ts`). STAND-IN type. */
export interface DaemonNotificationPreferences {
  get(daemon: DaemonId): { readonly enabled: boolean };
  set(daemon: DaemonId, patch: { readonly enabled: boolean }): unknown;
}

// ─── 6. notifications and pages (today: `notify.ts`, `pages/routes.ts`, `agenda-inbox.ts`, `protocol` agenda;
//        spine-app-shell: `src/router/routes.ts` has `daemonHomeHref`, the same `/d/<id>` shape) ─────────────────────

/** The mark a notification carries; same-origin paths, so a push never names an image service. COPY. */
export const NOTIFICATION_ICON = '/icons/icon-any-192.png';
export const NOTIFICATION_BADGE = '/icons/badge-96.png';
export const notificationBrand = (): { readonly icon: string; readonly badge: string } => ({
  icon: NOTIFICATION_ICON,
  badge: NOTIFICATION_BADGE,
});

/** The id the machine agenda goes by. COPY of today's `isMachineAgendaId`; REPLACE WITH the Agenda contract's. */
export const isMachineAgendaId = (sessionId: string): boolean => sessionId === 'machine-agenda';

/** A machine's home page. COPY. */
export const daemonHomePath = (id: DaemonId): string => `/d/${encodeURIComponent(id)}`;

/** A machine's Inbox. COPY. */
export const daemonAgendaPath = (id: DaemonId): string => `${daemonHomePath(id)}/inbox`;

/** One conversation's page. COPY (today's session-scope check is the non-empty rule below). */
export const daemonSessionPath = (id: DaemonId, sessionId: string): string =>
  `${daemonHomePath(id)}/session/${encodeURIComponent(requireNonEmpty(sessionId, 'sessionId'))}`;

/** The page model of a pathname, narrowed to the one kind Access reads. STAND-IN: the router is the shell's. */
export function parseRoute(
  _pathname: string,
):
  | { readonly kind: 'session'; readonly daemonId: DaemonId; readonly sessionId: string }
  | { readonly kind: 'elsewhere' } {
  return fromShell('parseRoute');
}

/** The Agenda item an address names. STAND-IN: Agenda's link grammar. */
export function agendaTargetFromSearch(_search: string): string | null {
  return fromShell('agendaTargetFromSearch');
}

/** The Inbox address of one item. STAND-IN: Agenda's link grammar. */
export function inboxTargetPath(_daemonId: DaemonId, _sessionId: string, _id: string): string {
  return fromShell('inboxTargetPath');
}

// ─── 7. advertisement notices (today: `protocol/src/lib/advertisement.ts`; `cli/shell.ts` holds the same copy) ──

/**
 * WHO CAN REDEEM THIS, and the one line that changes it. COPY, verbatim in its sentences. P84: ONE owner for every
 * remedy sentence — REPLACE WITH the same functions in Access's `contract/` (the CLI half imports them too).
 */
export interface AdvertisementNotice {
  readonly audience: string;
  readonly remedy: string;
}

const CONFIG_DOCUMENT = '<FY_HOME>/config/daemon.json';
const EXAMPLE_LAN_HOST = '192.168.1.10';

function exampleReachableAddress(daemonUrl: string): string {
  try {
    const url = new URL(daemonUrl);
    url.hostname = EXAMPLE_LAN_HOST;
    return url.origin;
  } catch {
    return `http://${EXAMPLE_LAN_HOST}`;
  }
}

function advertiseRemedy(example: string): string {
  return `set "publicUrl" in ${CONFIG_DOCUMENT} to the address other devices reach this machine at, e.g. ${example}, then restart the daemon`;
}

function bindAndAdvertiseRemedy(example: string): string {
  return (
    `bind every interface by setting "host" to "${WILDCARD_BIND_HOST}" on the bind entry in "carriers" (or the top-level "host" if the document has no bind entry), which accepts connections from other ` +
    `devices on your network, and ${advertiseRemedy(example)}. ` +
    `Commands on this machine keep reaching it on loopback`
  );
}

/** What to say beside a link whose DIRECT address only this machine's own browser can redeem. */
export function localOnlyNotice(daemonUrl: string, discoveredRelayUrl?: string): AdvertisementNotice {
  if (discoveredRelayUrl === undefined) {
    return {
      audience: `Only a browser on this machine can redeem this link at ${daemonUrl}; no QR is drawn because another device cannot dial it.`,
      remedy: bindAndAdvertiseRemedy(exampleReachableAddress(daemonUrl)),
    };
  }
  return {
    audience:
      `A browser on this machine redeems this link at ${daemonUrl}; another device can redeem it through ` +
      `the rendezvous at ${discoveredRelayUrl}, which observes connection metadata such as timing and sizes ` +
      `but can never read the code or the exchange.`,
    remedy: `for a direct connection that no rendezvous carries, ${bindAndAdvertiseRemedy(exampleReachableAddress(daemonUrl))}`,
  };
}

const REFUSAL_AUDIENCES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': 'This daemon only advertises loopback, so another device has no address to dial.',
  'wildcard-bind': 'This daemon binds every interface, so there is no single address to hand out.',
  'no-port': 'This daemon has no port recorded yet, so there is no address to hand out.',
};

const REFUSAL_REMEDIES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': bindAndAdvertiseRemedy(`http://${EXAMPLE_LAN_HOST}`),
  'wildcard-bind': advertiseRemedy(`http://${EXAMPLE_LAN_HOST}:<the port this daemon bound>`),
  'no-port': `start the daemon once so it records the port it takes, or write "port" on the bind entry in "carriers" of ${CONFIG_DOCUMENT} yourself (or the top-level "port" if the document has no bind entry); "publicUrl" cannot supply an address nothing has bound`,
};

/** What to say when there is no address to hand out at all, per reason. */
export function refusalNotice(refusal: AdvertisementRefusal): AdvertisementNotice {
  return { audience: REFUSAL_AUDIENCES[refusal], remedy: REFUSAL_REMEDIES[refusal] };
}

// ─── 8. class names (today: `pwa/src/lib/class-names.ts`), held by `shell-grants.ts` ───────────────────────────

export { cn } from './shell-grants.ts';

// ─── 9. shell components and hooks (today: `pwa/src/shell/*`, `pwa/src/hooks/*`; spine-app-shell: `src/shell/`) ─

export interface BottomSheetProps {
  readonly id: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labelledBy?: string;
  readonly ariaLabel?: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
  readonly panelClassName?: string;
  readonly maxHeight?: string;
  readonly height?: string;
  readonly zIndexClass?: string;
}

/** The shell's bottom sheet. STAND-IN (today: `shell/bottom-sheet.tsx`). */
export function BottomSheet(_props: BottomSheetProps): ReactNode {
  return fromShell('BottomSheet');
}

/** The Ferretry mark. STAND-IN (today: `shell/brand-mark.tsx`). */
export function BrandMark(_props: { readonly size?: number; readonly className?: string }): ReactNode {
  return fromShell('BrandMark');
}

/** The shell's sessions bar, which the pairing harness opens its sheet from. STAND-IN (today: `shell/sessions-bar.tsx`). */
export function SessionsBar(_props: Readonly<Record<string, unknown>>): ReactNode {
  return fromShell('SessionsBar');
}

export type LayoutMode = 'drawer' | 'rail' | 'full';

/** Which layout the viewport is in. STAND-IN (today: `hooks/use-layout-mode.ts`). */
export function useLayoutMode(): LayoutMode {
  return fromShell('useLayoutMode');
}

/** Whether the on-screen keyboard is up. STAND-IN (today: `hooks/use-keyboard-open.ts`). */
export function useKeyboardOpen(): boolean {
  return fromShell('useKeyboardOpen');
}

/** Installs the app's viewport size variables. STAND-IN (today: `hooks/use-app-viewport.ts`). */
export function useAppViewport(): void {
  fromShell('useAppViewport');
}

/** Moves focus into an open dialog, traps Tab, and gives it back on close (today: `hooks/use-dialog-focus.ts`). */
export { useDialogFocus } from './shell-grants.ts';

/** `read`, made to do nothing while the tab is hidden. STAND-IN (today: `lib/feed-aware-poll.ts`). */
export function whileVisible(_read: () => void): () => void {
  return fromShell('whileVisible');
}

/**
 * How many standing sign-in rules a device's passkey approved, under its row. STAND-IN: today's
 * `features/secure-copy/device-rule-note.tsx`, owned by the sign-in rules surface, not Access. It draws NOTHING,
 * which is exactly what today's note draws when the rules cannot be read — and here they cannot be, because the
 * rules surface is not in this build. It does not throw, because it renders under every device row.
 */
export function DeviceRuleNote(_props: { readonly client: IFyApiClient; readonly deviceId: string }): ReactNode {
  return null;
}
