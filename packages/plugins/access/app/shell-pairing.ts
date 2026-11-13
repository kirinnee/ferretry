/**
 * THE PAIRING HALF'S SHELL SEAM. What Access's app half (pairing, devices, QR, push enrolment, device keys) needs from
 * outside itself, in one file.
 *
 * THREE KINDS, AND THE LINE BETWEEN THEM IS DELIBERATE:
 *
 * - THE APP SHELL'S OWN EXPORT, where it has one: `@ferretry/app` (the session wire, the session client's refusal
 *   error) and `@ferretry/app/ui` (the bottom sheet, the mark, the layout and viewport hooks, the Trusted Types
 *   worker URL). Re-exported here, so the screens keep one import line and the shell stays the one owner.
 * - A SHORT COPY of today's code, for pure facts that carry no runtime identity: types, sentences, constants, and
 *   total functions over plain values (the daemon-connection value rules, the published-carrier mapping the §14
 *   pairing check reads, the request URL rule, the visibility gate). A copy here behaves exactly as today's does.
 * - A TYPED STAND-IN that throws, for what the shell has NO export for in 5.0: its network, its timers and routes,
 *   the page model and the sessions bar (the shell holds no feature, §5). Each throws the same sentence naming
 *   itself, so a screen that reaches one fails loudly rather than quietly doing the wrong thing.
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
import type { AdvertisementRefusal } from '../contract/index.ts';
import type { IFyApiClient } from './shell-grants.ts';

/** The one sentence every throwing stand-in answers with. */
const fromShell = (name: string): never => {
  throw new Error(`${name} has no app shell export in this build of Access`);
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
function connectionPreferenceOrder(methods: readonly ConnectionMethod[]): readonly ConnectionMethod[] {
  return [...methods].sort((left, right) => kindRank(left) - kindRank(right));
}

/**
 * Whose relay a published relay is, for the SENTENCE a person reads and nothing else. Only positive evidence picks an
 * ownership-specific answer: the address this browser discovered itself is Ferretry's hosted relay, and an entry the
 * daemon says its operator wrote (`source: 'configured'`) is theirs. Anything else is NO `operator` at all — unknown — and is
 * disclosed neutrally, because a directory that failed to answer is an ordinary state and proves nothing.
 */
function relayOperator(
  carrier: { readonly url: string; readonly source?: 'configured' },
  hostedRelayUrl: string | undefined,
): { readonly operator?: 'hosted' | 'self' } {
  if (carrier.url === hostedRelayUrl) return { operator: 'hosted' };
  return carrier.source === 'configured' ? { operator: 'self' } : {};
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
              ...relayOperator(carrier, hostedRelayUrl),
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
type TunnelCarrier = Extract<ConnectionMethod, { kind: 'tunnel' }>;

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

/** An opaque private key the session signs with: the shell's own type. */
export type { PrivateKeyHandle } from '@ferretry/app';

// ─── 4. the session client's sentences and errors (today: `pwa/src/lib/relay-carrier.ts`, `relay-session.ts`) ──

/**
 * Said when this machine no longer accepts this browser's device. COPY of today's sentence (parity).
 */
export const DEVICE_NOT_ACCEPTED_SENTENCE =
  'This machine no longer accepts this browser — it was removed, or went unused for too long. Pair it again to keep using it.';

/** A sealed `pair-refused`: the daemon judged this code. The session client's own class, so `instanceof` holds. */
export { RelayPairingRefusedError } from '@ferretry/app';

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

/**
 * The page's network, wrapped so it is never called with the wrong receiver. STAND-IN: the shell owns the network, and
 * a bare `fetch` here would put a plain request on the wire where today's router put a sealed session.
 */
export const browserFetch: DaemonFetch = async () => fromShell('browserFetch');

export interface DaemonRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** Resolves a path against the paired daemon, never against the page origin. COPY of today's `daemonUrl`. */
const daemonUrl = (daemon: DaemonConnection, path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('daemon path must be an origin-relative path');
  const url = new URL(path, `${daemon.baseUrl}/`);
  if (url.origin !== new URL(daemon.baseUrl).origin) throw new Error('daemon path must remain on the paired daemon');
  return url.toString();
};

/**
 * A request for one paired daemon: its own address for the path, and the browser's credentials. It carries no
 * credential of its own: the device key that opened the sealed session the request rides on is the credential. COPY of
 * today's `daemonRequest`, minus the router's per-daemon symbol binding, which belongs to the router the shell now
 * owns (the shell routes by the session a client was built for, never by a mark on a request).
 */
export function daemonRequest(daemon: DaemonConnection, path: string, init: RequestInit = {}): DaemonRequest {
  return { url: daemonUrl(daemon, path), init: { ...init, credentials: 'include' } };
}

/** The deadline every per-machine read gives up after. COPY of today's constant. */
export const MACHINE_READ_DEADLINE_MS = 20_000;

/** The script URL a service worker is registered from, through the page's Trusted Types policy: the shell owns it. */
export { trustedWorkerUrl } from '@ferretry/app/ui';

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

/** A machine's home page. COPY. */
export const daemonHomePath = (id: DaemonId): string => `/d/${encodeURIComponent(id)}`;

/** The shell's route table and its tap check: `@ferretry/app`. A tap is decided by the router that draws the page. */
export { type PushMachine, pushMachineOf } from '@ferretry/app';
/** The page's half of a clear (the worker's is the shell's, S6): close this device's own lines for an item opened here. */
export { type ClearRegistration, closeShownTags, type ShownNotification, shownTag } from '@ferretry/app';

// ─── 7. advertisement notices (today: `protocol/src/lib/advertisement.ts`; `cli/shell.ts` holds the same copy) ──

/**
 * WHO CAN REDEEM THIS, and the one line that changes it. COPY, verbatim in its sentences. P84: ONE owner for every
 * remedy sentence — REPLACE WITH the same functions in Access's `contract/` (the CLI half imports them too).
 */
export interface AdvertisementNotice {
  readonly audience: string;
  readonly remedy: string;
}

/** Where 5.0 keeps the direct carrier's host and port (`direct`), spelled the way every other sentence spells it. */
const CONNECTIONS_DOCUMENT = '<FY_HOME>/config/connections.yaml';

const LOOPBACK_AND_RELAY =
  'keep the daemon on a loopback listener and let it use a discovered relay, which is how a phone pairs';

const NO_DIRECT_ROUTE =
  '5.0 has no separate public-address setting yet, and the daemon refuses direct connections from other machines, so widening the listener does not give another device a direct route';

export function localOnlyNotice(daemonUrl: string, discoveredRelayUrl?: string): AdvertisementNotice {
  if (discoveredRelayUrl === undefined) {
    return {
      audience: `Only a browser on this machine can redeem this link at ${daemonUrl}; no QR is drawn because another device cannot dial it.`,
      remedy: `${LOOPBACK_AND_RELAY}; until a relay is discovered, pair from a browser on this machine. ${NO_DIRECT_ROUTE}`,
    };
  }
  return {
    audience:
      `A browser on this machine redeems this link at ${daemonUrl}; another device can redeem it through ` +
      `the rendezvous at ${discoveredRelayUrl}, which observes connection metadata such as timing and sizes ` +
      `but can never read the code or the exchange.`,
    remedy: `nothing to change: the daemon is on a loopback listener with a discovered relay, which is how a phone pairs. ${NO_DIRECT_ROUTE}`,
  };
}

const REFUSAL_AUDIENCES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': 'This daemon only advertises loopback, so another device has no address to dial.',
  'wildcard-bind': 'This daemon binds every interface, so there is no single address to hand out.',
  'no-port': 'This daemon has no port recorded yet, so there is no address to hand out.',
};

const REFUSAL_REMEDIES: Readonly<Record<AdvertisementRefusal, string>> = {
  'loopback-bind': `${LOOPBACK_AND_RELAY}; until a relay is discovered, pair from a browser on this machine. ${NO_DIRECT_ROUTE}`,
  'wildcard-bind': `start the daemon on a loopback listener ("fyd --host 127.0.0.1") and let it use a discovered relay, which is how a phone pairs; a wildcard listener stays refused because ${NO_DIRECT_ROUTE}`,
  'no-port': `start the daemon so it binds a port ("--port" or FY_PORT chooses it), or write "port" under "direct" in ${CONNECTIONS_DOCUMENT} yourself (a new "direct" block also needs "host"); "direct" answers only while nothing is bound, and the listener you start wins`,
};

/** What to say when there is no address to hand out at all, per reason. */
export function refusalNotice(refusal: AdvertisementRefusal): AdvertisementNotice {
  return { audience: REFUSAL_AUDIENCES[refusal], remedy: REFUSAL_REMEDIES[refusal] };
}

// ─── 8. class names (today: `pwa/src/lib/class-names.ts`), held by `shell-grants.ts` ───────────────────────────

export { cn } from './shell-grants.ts';

// ─── 9. shell components and hooks (today: `pwa/src/shell/*`, `pwa/src/hooks/*`; spine-app-shell: `src/shell/`) ─

/** The shell's bottom sheet, the Ferretry mark, and the layout and viewport hooks: `@ferretry/app/ui`. */
export { BottomSheet, BrandMark, useAppViewport, useKeyboardOpen, useLayoutMode } from '@ferretry/app/ui';

/** The sessions bar the pairing harness opens its sheet from. STAND-IN: the shell holds no feature, and this bar is one. */
export function SessionsBar(_props: Readonly<Record<string, unknown>>): ReactNode {
  return fromShell('SessionsBar');
}

/** Moves focus into an open dialog, traps Tab, and gives it back on close: the shell's, held by `shell-grants.ts`. */
export { useDialogFocus } from './shell-grants.ts';

/** `read`, made to do nothing while the tab is hidden. COPY of today's `whileVisible` (`lib/feed-aware-poll.ts`). */
export const whileVisible =
  (
    read: () => void,
    environment: { readonly hidden: () => boolean } = {
      hidden: () => globalThis.document?.visibilityState === 'hidden',
    },
  ) =>
  (): void => {
    if (!environment.hidden()) read();
  };

/**
 * How many standing sign-in rules a device's passkey approved, under its row. STAND-IN: today's
 * `features/secure-copy/device-rule-note.tsx`, owned by the sign-in rules surface, not Access. It draws NOTHING,
 * which is exactly what today's note draws when the rules cannot be read — and here they cannot be, because the
 * rules surface is not in this build. It does not throw, because it renders under every device row.
 */
export function DeviceRuleNote(_props: { readonly client: IFyApiClient; readonly deviceId: string }): ReactNode {
  return null;
}
