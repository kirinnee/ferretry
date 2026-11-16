/**
 * Where a client on this machine dials the daemon, and what counts as this machine (P89, P90, S57).
 * The loopback rule is copied from today's `protocol/address.ts`, whole-domain rule intact; the recorded bind is the
 * kernel's run record (`DAEMON_RUN_FILE`), read through the kernel's own schema and address function.
 */
import { type DaemonRun, DaemonRunSchema, recordedBindAddress } from '@ferretry/kernel/contract';

/** Loopback, never a routable interface: a daemon binds the machine it runs on and nothing else. */
const LOOPBACK = '127.0.0.1';
/** The port a daemon binds when its operator has named none: the same number as `DEFAULT_PORT` in the kernel's `host/fyd.ts`. */
const DEFAULT_DAEMON_PORT = 7457;

const LOOPBACK_IPV4_BLOCK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/u;
const IPV6_GROUP_COUNT = 8;

function bareHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  return lowered.startsWith('[') && lowered.endsWith(']') ? lowered.slice(1, -1) : lowered;
}

function ipv6GroupsOf(half: string): readonly number[] | undefined {
  if (half === '') return [];
  const groups = half.split(':').map(group => (IPV6_GROUP.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? undefined : groups;
}

/** The eight groups of an IPv6 spelling, or `undefined` when the host is not one. `::`, `::0` and the long form agree. */
function ipv6Groups(host: string): readonly number[] | undefined {
  if (!host.includes(':')) return undefined;
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const head = ipv6GroupsOf(halves[0] ?? '');
  const tail = ipv6GroupsOf(halves[1] ?? '');
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === IPV6_GROUP_COUNT ? head : undefined;
  const elided = IPV6_GROUP_COUNT - head.length - tail.length;
  return elided < 1 ? undefined : [...head, ...new Array<number>(elided).fill(0), ...tail];
}

/** A host spelling as an operator writes one: names included. All of `127.0.0.0/8`, `::1`, `*.localhost`. */
export function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (LOOPBACK_IPV4_BLOCK.test(bare)) return true;
  const groups = ipv6Groups(bare);
  if (groups === undefined) return false;
  return groups.every((group, index) => group === (index === IPV6_GROUP_COUNT - 1 ? 1 : 0));
}

export const DEFAULT_DAEMON_URL = recordedBindAddress({ host: LOOPBACK, port: DEFAULT_DAEMON_PORT });

/**
 * Whether a daemon URL names this machine and may therefore be sent a locally minted credential. Decided from the
 * URL, never from whether `FY_URL` was set. A URL that will not parse is not loopback: guessing wrong in that
 * direction sends a credential off this machine.
 */
export function isLocalDaemonUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The daemon's run record (`run/daemon.json`), or `undefined` when there is none this client can read. Tolerant by
 * design: an unreadable record leaves the client on the well-known default, which fails by reporting the daemon away.
 */
export function parseDaemonRun(documentText: string | undefined): DaemonRun | undefined {
  if (documentText === undefined) return undefined;
  try {
    const parsed = DaemonRunSchema.safeParse(JSON.parse(documentText));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An explicit `FY_URL` wins outright (P90); then the bind the daemon recorded, through the kernel's own
 * {@link recordedBindAddress} so client and daemon cannot disagree (P89); then the port the home's own configuration
 * names (`homePort`, from the kernel's `homePortOf`: where this home's daemon WILL bind, so a client looking before
 * any record exists never lands on another home's daemon at 7457); then the well-known default.
 */
export function resolveDaemonUrl(explicitUrl: string, run: DaemonRun | undefined, homePort?: number): string {
  if (explicitUrl.trim() !== '') return explicitUrl.trim();
  if (run !== undefined) return recordedBindAddress(run);
  // A configured 0 asks the OS for a port: there is nothing to dial until the daemon records the one it got.
  return homePort === undefined || homePort === 0
    ? DEFAULT_DAEMON_URL
    : recordedBindAddress({ host: LOOPBACK, port: homePort });
}
