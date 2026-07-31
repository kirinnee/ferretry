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

/** Title-cases a callsign slug for display: `ms-98` → `Ms-98`. */
export const displayCallsign = (raw: string | null | undefined): string => {
  const slug = (raw ?? '').trim();
  if (slug === '') return '';
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
