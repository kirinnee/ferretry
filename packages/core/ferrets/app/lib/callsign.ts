/**
 * The display-only identities the app renders a ferret by.
 *
 * THE CASING CONTRACT lives here. A callsign is stored, searched, routed and commanded in its RAW lowercase form; it is
 * only Title-cased on the way to a reader's eyes. Anything that writes one back into a filter, a URL or a command has
 * broken the contract.
 */

/** The prefixes a system ferret may carry (the Warden, Learning, Pack mode). One per kind of system ferret. */
const SYSTEM_CALLSIGN_PREFIXES = ['warden', 'learning', 'pack'] as const;

/** Any system callsign, in either case. */
const SYSTEM_CALLSIGN_PATTERN = new RegExp(`^(${SYSTEM_CALLSIGN_PREFIXES.join('|')})-([0-9a-f]{6})$`, 'iu');

const sequenceOf = (callsign: string | undefined): number | undefined => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec((callsign ?? '').trim());
  if (match?.[2] === undefined) return undefined;
  const sequence = Number.parseInt(match[2], 16);
  return sequence === 0 ? undefined : sequence;
};

/** Whether Ferretry named this ferret itself (`warden-00002a`): an identifier, not a first name. */
export const isSystemCallsign = (callsign: string | undefined): boolean => sequenceOf(callsign) !== undefined;

/** `warden-00002a` → `warden-00002A`: the prefix as stored, the hex digits uppercase. Any other name unchanged. */
export const displaySystemCallsign = (callsign: string): string => {
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
  if (isSystemCallsign(slug)) return displaySystemCallsign(slug);
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};

/**
 * Ferret ids are long and readers only ever use their head to tell two apart, so a truncated form with an ellipsis is
 * what gets rendered. An id short enough to show whole is shown whole rather than being padded with a lie.
 */
export const shortFerretId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);
