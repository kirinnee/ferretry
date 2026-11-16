/**
 * How a ferret's name is shown to a reader: the display casing of a callsign, from Ferrets' app half.
 *
 * GAP(ferrets): Ferrets' `displayCallsign` lives in its app half (`app/lib/callsign.ts`) and neither its contract nor
 * `@ferretry/app` exports it, so this is the one copy Conversation needs; delete it once Ferrets' contract exports it.
 *
 * A callsign is stored, searched and routed in its RAW lowercase form and is only Title-cased on the way to a reader's
 * eyes: anything that writes one back into a filter, a URL or a command has broken the contract.
 */

/** The prefixes a system ferret may carry (the Warden, Learning, Pack mode). */
const SYSTEM_CALLSIGN_PREFIXES = ['warden', 'learning', 'pack'] as const;

/** Any system callsign, in either case. */
const SYSTEM_CALLSIGN_PATTERN = new RegExp(`^(${SYSTEM_CALLSIGN_PREFIXES.join('|')})-([0-9a-f]{6})$`, 'iu');

const sequenceOf = (callsign: string | undefined): number | undefined => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec((callsign ?? '').trim());
  if (match?.[2] === undefined) return undefined;
  const sequence = Number.parseInt(match[2], 16);
  return sequence === 0 ? undefined : sequence;
};

/** `warden-00002a` → `warden-00002A`: the prefix as stored, the hex digits uppercase. Any other name unchanged. */
const displaySystemCallsign = (callsign: string): string => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  const sequence = sequenceOf(callsign);
  if (match?.[1] === undefined || sequence === undefined) return callsign;
  return `${match[1].toLowerCase()}-${sequence.toString(16).toUpperCase().padStart(6, '0')}`;
};

/**
 * Title-cases a callsign slug for display: `ms-98` → `Ms-98`. A callsign Ferretry gave a ferret itself
 * (`warden-00002a`) is an identifier, not a first name: it is shown as `warden-00002A`.
 */
export const displayCallsign = (raw: string | null | undefined): string => {
  const slug = (raw ?? '').trim();
  if (slug === '') return '';
  if (sequenceOf(slug) !== undefined) return displaySystemCallsign(slug);
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};
