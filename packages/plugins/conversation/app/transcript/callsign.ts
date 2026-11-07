/**
 * The two display-only identities the whole app renders sessions by. Ported
 * from kteam `ui/src/lib/callsign.ts` and the id shortener in
 * `ui/src/lib/lineage.ts`.
 *
 * THE CASING CONTRACT lives here. A teammate callsign is stored, searched,
 * routed and commanded in its RAW lowercase form; it is only Title-cased on the
 * way to a reader's eyes. Anything that writes one of these back into config, a
 * filter, a URL or a command has broken the contract — the palette in
 * particular ranks over raw values and renders through `displayCallsign`, and a
 * ranker fed the display form would stop answering to what people type.
 *
 * It sits in `lib` rather than beside its first caller because the shell (the
 * command palette) and the Warden feature both need it, and a shared helper
 * living inside one feature is a dependency the other should never have to take.
 */

/**
 * The callsigns of ferrets Ferretry starts ITSELF (`warden-00002a`): stored lowercase, shown with uppercase hex. A
 * short copy of Ferrets' `system-callsigns.ts` reader, which no contract exports (the Agenda and Warden halves carry
 * the same copy).
 */
const SYSTEM_CALLSIGN_PATTERN = /^(warden|learning|pack)-([0-9a-f]{6})$/iu;

const systemSequence = (callsign: string): number | undefined => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  if (match?.[2] === undefined) return undefined;
  const sequence = Number.parseInt(match[2], 16);
  return sequence === 0 ? undefined : sequence;
};

const isSystemCallsign = (callsign: string): boolean => systemSequence(callsign) !== undefined;

/** `warden-00002a` → `warden-00002A`: the prefix as stored, the hex digits uppercase. Any other name unchanged. */
const displaySystemCallsign = (callsign: string): string => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  const sequence = systemSequence(callsign);
  if (match?.[1] === undefined || sequence === undefined) return callsign;
  return `${match[1].toLowerCase()}-${sequence.toString(16).toUpperCase().padStart(6, '0')}`;
};

/**
 * Title-cases a callsign slug for display: `ms-98` → `Ms-98`. A callsign Ferretry gave a session itself
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
 * Session ids are long and readers only ever use their head to tell two apart,
 * so a truncated form with an ellipsis is what gets rendered. An id short enough
 * to show whole is shown whole rather than being padded with a lie.
 */
export const shortSessionId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);
