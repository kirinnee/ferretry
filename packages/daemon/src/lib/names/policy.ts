import { CALLSIGN_WINDOW_MS, MAX_CALLSIGN_LENGTH, MAX_SESSION_TITLE_LENGTH, type NameClaim } from './types.ts';

const CALLSIGN_PATTERN = /^[a-z][a-z0-9-]*$/;
const POOL_CALLSIGN_PATTERN = /^[a-z]{2,32}$/;

export function normalizeCallsign(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_CALLSIGN_LENGTH) return null;
  return CALLSIGN_PATTERN.test(normalized) ? normalized : null;
}

export function formatSessionTitle(raw: string): string {
  const printable = [...raw]
    .map(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('');
  return printable.replace(/\s+/g, ' ').trim().slice(0, MAX_SESSION_TITLE_LENGTH);
}

export function activeCallsigns(claims: readonly NameClaim[], nowMs: number): ReadonlySet<string> {
  return new Set(claims.filter(claim => claim.expiresAtMs > nowMs).map(claim => claim.callsign.toLowerCase()));
}

export function availableCallsigns(
  pool: readonly string[],
  claims: readonly NameClaim[],
  nowMs: number,
  startIndex: number,
): readonly string[] {
  if (pool.length === 0) return [];
  const active = activeCallsigns(claims, nowMs);
  const first = ((Math.trunc(startIndex) % pool.length) + pool.length) % pool.length;
  const seen = new Set<string>();
  const available: string[] = [];

  for (let offset = 0; offset < pool.length; offset += 1) {
    const candidate = pool[(first + offset) % pool.length];
    if (candidate === undefined) continue;
    const normalized = candidate.toLowerCase();
    if (seen.has(normalized) || active.has(normalized)) continue;
    seen.add(normalized);
    available.push(candidate);
  }

  return available;
}

export function suggestCallsigns(
  pool: readonly string[],
  claims: readonly NameClaim[],
  nowMs: number,
  requestedCount: number,
  startIndex: number,
): readonly string[] {
  const count = Math.max(1, Math.min(50, Math.floor(requestedCount) || 1));
  return availableCallsigns(pool, claims, nowMs, startIndex).slice(0, count);
}

export interface CallsignReference {
  readonly id: string;
  readonly callsign?: string;
  readonly claimedAtMs: number;
}

export function resolveSessionReference(
  reference: string,
  sessions: readonly CallsignReference[],
  nowMs: number,
  windowMs = CALLSIGN_WINDOW_MS,
): string {
  if (sessions.some(session => session.id === reference)) return reference;
  const callsign = reference.trim().toLowerCase();
  const cutoff = nowMs - windowMs;
  const match = sessions
    .filter(session => session.callsign?.toLowerCase() === callsign && session.claimedAtMs >= cutoff)
    .toSorted((left, right) => right.claimedAtMs - left.claimedAtMs)[0];
  return match?.id ?? reference;
}

export function isValidCallsignPool(pool: readonly string[]): boolean {
  if (pool.length === 0) return false;
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const callsign of pool) {
    if (!POOL_CALLSIGN_PATTERN.test(callsign)) return false;
    if (seen.has(callsign)) return false;
    if (previous !== undefined && callsign.localeCompare(previous) < 0) return false;
    seen.add(callsign);
    previous = callsign;
  }
  return true;
}
