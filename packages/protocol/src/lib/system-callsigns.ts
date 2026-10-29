/**
 * The callsigns of sessions Ferretry starts ITSELF — Warden investigators, the Learning miner, Pack
 * clean-up: `warden-000001`, `learning-00002A`, `pack-000003`, … Six hex digits from a counter that
 * wraps back to 1 after `FFFFFF` and skips any id still in use. The human first names in the pool are
 * for real ferrets: a system session never draws one, and a name of this shape can never be a pool
 * name (pool names are letters only).
 *
 * A callsign is STORED lowercase like every callsign (`warden-00002a`) and SHOWN with uppercase hex
 * (`warden-00002A`) — see {@link displaySystemCallsign}.
 */

/** The prefixes a system session may carry. One per kind of system session. */
export const SYSTEM_CALLSIGN_PREFIXES = ['warden', 'learning', 'pack'] as const;
export type SystemCallsignPrefix = (typeof SYSTEM_CALLSIGN_PREFIXES)[number];

/** Any system callsign, in either case. */
export const SYSTEM_CALLSIGN_PATTERN = new RegExp(`^(${SYSTEM_CALLSIGN_PREFIXES.join('|')})-([0-9a-f]{6})$`, 'iu');

/** The largest sequence: `FFFFFF`. The next one wraps to 1. */
export const SYSTEM_CALLSIGN_MAX_SEQUENCE = 0xff_ff_ff;

/** The stored (lowercase) callsign for `sequence`, 1 … {@link SYSTEM_CALLSIGN_MAX_SEQUENCE}. */
export const systemCallsignName = (prefix: SystemCallsignPrefix, sequence: number): string =>
  `${prefix}-${sequence.toString(16).padStart(6, '0')}`;

/** The sequence in a callsign of `prefix`, or `undefined` for any other name. */
export function systemCallsignSequence(prefix: SystemCallsignPrefix, name: string | undefined): number | undefined {
  const match = SYSTEM_CALLSIGN_PATTERN.exec((name ?? '').trim());
  if (match?.[1]?.toLowerCase() !== prefix || match[2] === undefined) return undefined;
  const sequence = Number.parseInt(match[2], 16);
  return sequence === 0 ? undefined : sequence;
}

/**
 * The sequence after `last` that nothing holds: `last + 1`, wrapping from
 * {@link SYSTEM_CALLSIGN_MAX_SEQUENCE} to 1, stepping past every sequence in `inUse`. `undefined`
 * only when every one of the 16,777,215 ids is in use.
 */
export function nextSystemCallsignSequence(last: number, inUse: ReadonlySet<number>): number | undefined {
  const start = Number.isInteger(last) && last >= 0 && last <= SYSTEM_CALLSIGN_MAX_SEQUENCE ? last : 0;
  for (let step = 1; step <= SYSTEM_CALLSIGN_MAX_SEQUENCE; step += 1) {
    const candidate = ((start + step - 1) % SYSTEM_CALLSIGN_MAX_SEQUENCE) + 1;
    if (!inUse.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A callsign Ferretry gave a session it started itself. It is shown as an identifier
 * ({@link displaySystemCallsign}), never title-cased like a first name.
 */
export const isSystemCallsign = (callsign: string | undefined): boolean => sequenceOf(callsign) !== undefined;

function sequenceOf(callsign: string | undefined): number | undefined {
  const match = SYSTEM_CALLSIGN_PATTERN.exec((callsign ?? '').trim());
  if (match?.[2] === undefined) return undefined;
  const sequence = Number.parseInt(match[2], 16);
  return sequence === 0 ? undefined : sequence;
}

/** `warden-00002a` → `warden-00002A`: the prefix as stored, the hex digits uppercase. Any other name unchanged. */
export function displaySystemCallsign(callsign: string): string {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  const sequence = sequenceOf(callsign);
  if (match?.[1] === undefined || sequence === undefined) return callsign;
  return `${match[1].toLowerCase()}-${sequence.toString(16).toUpperCase().padStart(6, '0')}`;
}
