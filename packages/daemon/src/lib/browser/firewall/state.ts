import {
  type BrowserPortsSetting,
  LOOPBACK_FIREWALL_CONF_PATH,
  type LoopbackFirewallMarker,
  type LoopbackFirewallState,
  loopbackFirewallEntry,
  resolveBrowserPorts,
} from '@ferretry/protocol';

export const LOOPBACK_FIREWALL_SERVICE = 'ferretry-loopback-firewall';

/** The marker as the host holds it: parsed, or `undefined` when there is none or it is not one. */
export interface LoopbackMarkerReader {
  read(): Promise<LoopbackFirewallMarker | undefined>;
}

/** The one sentence that tells somebody what to do, for a firewall that is not applied. */
export const loopbackFirewallRemedy = (state: 'missing' | 'stale', entryLine: string): string =>
  `the loopback firewall is ${state}: ask the host admin to add \`${entryLine}\` to ${LOOPBACK_FIREWALL_CONF_PATH} and run \`sudo systemctl restart ${LOOPBACK_FIREWALL_SERVICE}\``;

/**
 * Judges the marker against the ports this user's setting will bind. `undefined` when there is nothing to
 * fence (random ports) or the ports cannot be derived (the browser launch says why). Never throws.
 */
export function judgeLoopbackFirewall(
  setting: BrowserPortsSetting,
  uid: number,
  marker: LoopbackFirewallMarker | undefined,
): LoopbackFirewallState | undefined {
  const resolved = resolveBrowserPorts(setting, uid, marker);
  const entry = loopbackFirewallEntry(setting, uid, marker);
  if (resolved.kind !== 'fixed' || !entry.ok) return undefined;
  if (marker === undefined) return { state: 'missing', detail: loopbackFirewallRemedy('missing', entry.line) };
  const wanted = [resolved.ports.cdp, resolved.ports.relay, resolved.ports.vnc];
  const listed = marker.entries.find(candidate => candidate.uid === uid);
  if (listed === undefined || !listed.ports.every((port, index) => port === wanted[index])) {
    return { state: 'stale', detail: loopbackFirewallRemedy('stale', entry.line) };
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
): Promise<LoopbackFirewallState | undefined> {
  const wanted = await setting().catch(() => 'random' as const);
  if (wanted === 'random') return undefined;
  return judgeLoopbackFirewall(wanted, uid, await marker.read().catch(() => undefined));
}
