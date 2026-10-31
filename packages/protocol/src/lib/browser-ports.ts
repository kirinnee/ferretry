import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * Which loopback ports the machine's agent browser uses (`machine.yaml` `browserPorts`,
 * docs/config-files.md). The agent Chrome's DevTools port, the proxy sign-in relay and the login window's
 * x11vnc are loopback listeners; on a host shared with other users a random port is reachable by every one of
 * them, so a host admin can fence FIXED ports per user (the loopback firewall) and each user pins theirs here.
 *
 * - `random` — a free port each time, as every browser always did. The default.
 * - `per-user` — the ports {@link perUserBrowserPorts} derives from this user's uid.
 * - `{ cdp, relay, vnc }` — three explicit, different ports.
 */
export const BROWSER_PORT_MIN = 1024;
export const BROWSER_PORT_MAX = 65535;
/** Below the Linux ephemeral range, so a derived port is never one an outgoing connection is handed. */
export const BROWSER_PER_USER_PORT_MAX = 32767;
export const BROWSER_PER_USER_DEFAULT_BASE = 20000;
export const BROWSER_PER_USER_FIRST_UID = 1000;
const PORTS_PER_UID = 4;

export const LOOPBACK_FIREWALL_MARKER_PATH = '/run/ferretry/loopback-firewall.json';
export const LOOPBACK_FIREWALL_CONF_PATH = '/etc/ferretry/loopback-firewall.conf';

const PortSchema = z.number().int().min(BROWSER_PORT_MIN).max(BROWSER_PORT_MAX);

export const BrowserPortsSchema = z.strictObject({ cdp: PortSchema, relay: PortSchema, vnc: PortSchema });
export type BrowserPorts = z.infer<typeof BrowserPortsSchema>;

export const BrowserPortsSettingSchema = z.union([
  z.literal('random'),
  z.literal('per-user'),
  BrowserPortsSchema.refine(ports => new Set([ports.cdp, ports.relay, ports.vnc]).size === 3, {
    message: 'browserPorts needs three different ports for cdp, relay and vnc',
  }),
]);
export type BrowserPortsSetting = z.infer<typeof BrowserPortsSettingSchema>;

export type BrowserPortsResult =
  | { readonly ok: true; readonly ports: BrowserPorts }
  | { readonly ok: false; readonly reason: string };

/**
 * The ports uid `uid` gets from `base`: `b = base + (uid − 1000) × 4`, then `cdp` b, `relay` b+1, `vnc` b+2.
 * Refused, as a plain sentence, for a uid below 1000 (a system account) or a port past 32767 or below 1024.
 */
export function perUserBrowserPorts(uid: number, base: number = BROWSER_PER_USER_DEFAULT_BASE): BrowserPortsResult {
  const first = base + (uid - BROWSER_PER_USER_FIRST_UID) * PORTS_PER_UID;
  const usable =
    Number.isInteger(uid) &&
    Number.isInteger(base) &&
    uid >= BROWSER_PER_USER_FIRST_UID &&
    base >= BROWSER_PORT_MIN &&
    first + 2 <= BROWSER_PER_USER_PORT_MAX;
  if (!usable) {
    return {
      ok: false,
      reason: `uid ${uid} gets ports outside ${BROWSER_PORT_MIN}–${BROWSER_PER_USER_PORT_MAX} from base ${base}; set explicit browserPorts or another base`,
    };
  }
  return { ok: true, ports: { cdp: first, relay: first + 1, vnc: first + 2 } };
}

/**
 * What the root script wrote after a successful apply (`/run/ferretry/loopback-firewall.json`): the base it
 * derived from and every user's ports. No secrets. A reader that cannot parse it treats the firewall as absent.
 */
export const LoopbackFirewallMarkerSchema = z.strictObject({
  version: z.literal(1),
  appliedAt: InstantSchema,
  base: z.number().int().min(BROWSER_PORT_MIN).max(BROWSER_PORT_MAX),
  entries: z.array(
    z.strictObject({ uid: z.number().int().min(0), ports: z.tuple([PortSchema, PortSchema, PortSchema]) }),
  ),
});
export type LoopbackFirewallMarker = z.infer<typeof LoopbackFirewallMarkerSchema>;

/** The marker in `text`, or `undefined` when it is not one. */
export function parseLoopbackFirewallMarker(text: string): LoopbackFirewallMarker | undefined {
  try {
    const parsed = LoopbackFirewallMarkerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the marker through `readText` (the file's text, or `undefined` when there is none). */
export async function readLoopbackFirewallMarker(
  readText: (path: string) => Promise<string | undefined>,
  path: string = LOOPBACK_FIREWALL_MARKER_PATH,
): Promise<LoopbackFirewallMarker | undefined> {
  const text = await readText(path).catch(() => undefined);
  return text === undefined ? undefined : parseLoopbackFirewallMarker(text);
}

/** The derivation base: the one the root script applied when a marker exists, else the default. */
export function browserPortsBase(marker: LoopbackFirewallMarker | undefined): number {
  return marker?.base ?? BROWSER_PER_USER_DEFAULT_BASE;
}

/** What this user's setting asks for: no fixed ports, ports to bind, or a refusal in a sentence. */
export type ResolvedBrowserPorts =
  | { readonly kind: 'random' }
  | { readonly kind: 'fixed'; readonly ports: BrowserPorts }
  | { readonly kind: 'refused'; readonly reason: string };

export function resolveBrowserPorts(
  setting: BrowserPortsSetting,
  uid: number,
  marker: LoopbackFirewallMarker | undefined,
): ResolvedBrowserPorts {
  if (setting === 'random') return { kind: 'random' };
  if (setting !== 'per-user') return { kind: 'fixed', ports: setting };
  const derived = perUserBrowserPorts(uid, browserPortsBase(marker));
  return derived.ok ? { kind: 'fixed', ports: derived.ports } : { kind: 'refused', reason: derived.reason };
}

export type LoopbackFirewallEntryResult =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The exact line this user adds to `/etc/ferretry/loopback-firewall.conf`: `user <uid>` for per-user ports,
 * `user <uid> <cdp> <relay> <vnc>` for explicit ones. A random setting has nothing to allow.
 */
export function loopbackFirewallEntry(
  setting: BrowserPortsSetting,
  uid: number,
  marker: LoopbackFirewallMarker | undefined,
): LoopbackFirewallEntryResult {
  if (setting === 'random') {
    return { ok: false, reason: 'browserPorts is random, so there is no firewall entry: set browserPorts first' };
  }
  if (uid < BROWSER_PER_USER_FIRST_UID) {
    return {
      ok: false,
      reason: `uid ${uid} is below ${BROWSER_PER_USER_FIRST_UID}, which the loopback firewall does not accept; run as an ordinary user`,
    };
  }
  const resolved = resolveBrowserPorts(setting, uid, marker);
  if (resolved.kind === 'refused') return { ok: false, reason: resolved.reason };
  if (setting === 'per-user') return { ok: true, line: `user ${uid}` };
  const { cdp, relay, vnc } = setting;
  return { ok: true, line: `user ${uid} ${cdp} ${relay} ${vnc}` };
}
