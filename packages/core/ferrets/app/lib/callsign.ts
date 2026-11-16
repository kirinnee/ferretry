/**
 * The display-only identities the app renders a ferret by. The callsign casing is the contract's
 * (`@ferretry/core-ferrets/contract`), re-exported here for this half's own callers.
 */

export { displayCallsign } from '../../contract/callsign.ts';

/**
 * Ferret ids are long and readers only ever use their head to tell two apart, so a truncated form with an ellipsis is
 * what gets rendered. An id short enough to show whole is shown whole rather than being padded with a lie.
 */
export const shortFerretId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);
