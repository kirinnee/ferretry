import {
  type BrowserFirewallFailure,
  type BrowserPortsSetting,
  LOOPBACK_FIREWALL_CONF_PATH,
  type LoopbackFirewallMarker,
  type LoopbackFirewallState,
  loopbackFirewallEntry,
  resolveBrowserPorts,
} from '@ferretry/protocol';

export const LOOPBACK_FIREWALL_SERVICE = 'ferretry-loopback-firewall';
export const LOOPBACK_FIREWALL_VERIFY_TIMER = 'ferretry-loopback-firewall-verify.timer';

/** How often the daemon re-reads the marker, and how old a verification may be before it counts as not running. */
export const LOOPBACK_FIREWALL_CHECK_MS = 5 * 60_000;
export const LOOPBACK_FIREWALL_VERIFIED_MAX_AGE_MS = 15 * 60_000;

/** The marker as the host holds it: parsed, or `undefined` when there is none or it is not one. */
export interface LoopbackMarkerReader {
  read(): Promise<LoopbackFirewallMarker | undefined>;
}

/** The one sentence that tells somebody what to do, for a firewall that is not applied. */
export const loopbackFirewallRemedy = (state: 'missing' | 'stale', entryLine: string): string =>
  `the loopback firewall is ${state}: ask the host admin to add \`${entryLine}\` to ${LOOPBACK_FIREWALL_CONF_PATH} and run \`sudo systemctl restart ${LOOPBACK_FIREWALL_SERVICE}\``;

const FAILED_REMEDY = `the loopback firewall failed its check: another user on this host could connect to this account’s browser ports; ask the host admin to look at \`sudo journalctl -u ${LOOPBACK_FIREWALL_SERVICE}-verify\` and fix the rules`;
const UNVERIFIED_REMEDY = `the 5-minute firewall check is not running: ask the host admin to run \`sudo systemctl enable --now ${LOOPBACK_FIREWALL_VERIFY_TIMER}\``;

/**
 * Judges the marker against the ports this user's setting will bind. `undefined` when there is nothing to
 * fence (random ports) or the ports cannot be derived (the browser launch says why). Never throws.
 * Precedence: failed > missing > stale > unverified > applied.
 */
export function judgeLoopbackFirewall(
  setting: BrowserPortsSetting,
  uid: number,
  marker: LoopbackFirewallMarker | undefined,
  nowMs: number,
): LoopbackFirewallState | undefined {
  const resolved = resolveBrowserPorts(setting, uid, marker);
  const entry = loopbackFirewallEntry(setting, uid, marker);
  if (resolved.kind !== 'fixed' || !entry.ok) return undefined;
  if (marker === undefined) return { state: 'missing', detail: loopbackFirewallRemedy('missing', entry.line) };
  const own = marker.perUser?.[String(uid)];
  if (own === 'failed') return { state: 'failed', detail: FAILED_REMEDY };
  if (own === 'missing') return { state: 'missing', detail: loopbackFirewallRemedy('missing', entry.line) };
  const wanted = [resolved.ports.cdp, resolved.ports.relay, resolved.ports.vnc];
  const listed = marker.entries.find(candidate => candidate.uid === uid);
  if (listed === undefined || !listed.ports.every((port, index) => port === wanted[index])) {
    return { state: 'stale', detail: loopbackFirewallRemedy('stale', entry.line) };
  }
  const verifiedAt = marker.verifiedAt === undefined ? Number.NaN : Date.parse(marker.verifiedAt);
  if (Number.isNaN(verifiedAt) || nowMs - verifiedAt > LOOPBACK_FIREWALL_VERIFIED_MAX_AGE_MS) {
    return { state: 'unverified', appliedAt: marker.appliedAt, detail: UNVERIFIED_REMEDY };
  }
  return {
    state: 'applied',
    appliedAt: marker.appliedAt,
    detail: 'the loopback firewall is applied: other users on this host cannot reach this account’s browser ports',
  };
}

/** A reading, never a gate: a setting or marker that cannot be read is no reading at all. */
export async function readLoopbackFirewall(
  setting: () => Promise<BrowserPortsSetting>,
  uid: number,
  marker: LoopbackMarkerReader,
  nowMs: () => number,
): Promise<LoopbackFirewallState | undefined> {
  const wanted = await setting().catch(() => 'random' as const);
  if (wanted === 'random') return undefined;
  return judgeLoopbackFirewall(wanted, uid, await marker.read().catch(() => undefined), nowMs());
}

/**
 * The sentence that declines a browser START, or `undefined` when it may go ahead: only the `refuse` policy
 * while this account's own check shows `failed`. A browser that is already running is never touched.
 */
export function firewallRefusal(
  firewall: LoopbackFirewallState | undefined,
  policy: BrowserFirewallFailure,
): string | undefined {
  if (policy !== 'refuse' || firewall?.state !== 'failed') return undefined;
  return `the browser was not started because ${firewall.detail}; or set browserFirewallFailure to warn in machine.yaml`;
}

/**
 * Reads the firewall and says so ONCE per change: at the browser start and on every tick of the five-minute
 * check, but a state that stays the same is silent. The first reading speaks only when it is not `applied`.
 */
export class LoopbackFirewallWatch {
  private last: LoopbackFirewallState['state'] | undefined;

  constructor(
    private readonly read: (cached: boolean) => Promise<LoopbackFirewallState | undefined>,
    private readonly announce: (message: string) => void,
  ) {}

  /** `cached` lets the reader skip anything costly (the timer's tick); a browser start reads fresh. */
  async check(cached = false): Promise<LoopbackFirewallState | undefined> {
    const firewall = await this.read(cached).catch(() => undefined);
    const state = firewall?.state;
    if (firewall !== undefined && state !== this.last && (state !== 'applied' || this.last !== undefined)) {
      this.announce(firewall.detail);
    }
    this.last = state;
    return firewall;
  }
}
