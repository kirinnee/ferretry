import type { LegacyWireUse } from '@ferretry/protocol';
import type { IDaemonHealthPort } from './ports.ts';

/** How long an older wire name must go unused before the removal release may drop it (docs/agenda.md § Compatibility). */
const LEGACY_WIRE_QUIET_DAYS = 14;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const plural = (count: number, unit: string): string => `${String(count)} ${unit}${count === 1 ? '' : 's'}`;

/** How long ago an instant was, in the largest whole unit; an instant ahead of the clock reads as just now. */
function ago(ageMs: number): string {
  if (ageMs < MINUTE_MS) return 'under a minute';
  if (ageMs < HOUR_MS) return plural(Math.floor(ageMs / MINUTE_MS), 'minute');
  if (ageMs < DAY_MS) return plural(Math.floor(ageMs / HOUR_MS), 'hour');
  return plural(Math.floor(ageMs / DAY_MS), 'day');
}

/**
 * What `fy doctor` says about the older wire names a daemon still answers.
 *
 * One line per route a client used inside the quiet window, saying who; a route whose last use is older
 * than that is named only when another is still in use, so the removal decision sees every route. When
 * nothing was used inside the window — or the daemon reported no uses — it is one ok line. A daemon that
 * sends no `legacyWire` field predates the counter and gets no lines at all.
 */
export function legacyWireLines(legacyWire: readonly LegacyWireUse[] | undefined, nowMs: number): string[] {
  if (legacyWire === undefined) return [];
  const aged = legacyWire.map(use => ({ use, ageMs: Math.max(0, nowMs - Date.parse(use.lastAt)) }));
  const recent = aged.filter(({ ageMs }) => ageMs <= LEGACY_WIRE_QUIET_DAYS * DAY_MS);
  if (recent.length === 0) return [`no older clients seen for ${String(LEGACY_WIRE_QUIET_DAYS)} days`];
  return aged.map(({ use, ageMs }) => {
    const by = use.lastClientVersion === undefined ? '' : ` by fy ${use.lastClientVersion}`;
    return ageMs <= LEGACY_WIRE_QUIET_DAYS * DAY_MS
      ? `older clients still use ${use.route}: last used ${ago(ageMs)} ago${by}`
      : `no older client has used ${use.route} for ${ago(ageMs)}${by === '' ? '' : ` (last${by})`}`;
  });
}

/** Ask the local daemon and render; a daemon that does not answer says nothing here (the host check already said so). */
export async function legacyWireReport(health: IDaemonHealthPort, nowMs: number): Promise<string[]> {
  return legacyWireLines((await health.probe())?.legacyWire, nowMs);
}
