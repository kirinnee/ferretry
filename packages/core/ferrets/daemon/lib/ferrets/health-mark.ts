/** Statuses a ferret has once it is over: a health mark on one of these would describe a ferret that is not running. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stalled', 'stopped']);

/** Marks that say more than `stalled` does, so the Warden's mark never replaces them. */
const TELLING_HEALTH: ReadonlySet<string> = new Set(['crashed', 'rate_limited']);

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * A ferret's state document with the Warden's stalled mark set (`stalled` true) or taken off (false), or `undefined` when
 * nothing would change (an ended ferret, a more telling mark, a health that already says it, or a document that is not
 * an object). Only `health` changes: every other field keeps its value.
 */
export function markedHealth(current: unknown, stalled: boolean): Readonly<Record<string, unknown>> | undefined {
  const document = asRecord(current);
  if (document === undefined) return undefined;
  const health = typeof document.health === 'string' ? document.health : undefined;
  if (stalled) {
    if (typeof document.status === 'string' && ENDED_STATUSES.has(document.status)) return undefined;
    if (health === 'stalled' || (health !== undefined && TELLING_HEALTH.has(health))) return undefined;
    return { ...document, health: 'stalled' };
  }
  return health === 'stalled' ? { ...document, health: 'healthy' } : undefined;
}
