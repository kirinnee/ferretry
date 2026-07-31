import type { Pin } from '@ferretry/protocol';

/** How many leading characters of a pin uuid the listing prints, and therefore accepts back. */
export const PIN_SHORT_ID_LENGTH = 8;

/** Shortest prefix accepted — below this, "unambiguous today" is luck rather than identity. */
const MINIMUM_PREFIX_LENGTH = 4;

/** The short form the listing shows for a pin. */
export function shortPinId(id: string): string {
  return id.slice(0, PIN_SHORT_ID_LENGTH);
}

/**
 * Resolve what a human typed into a full pin uuid.
 *
 * kteam printed pins with `pin.id.slice(0, 8)` but sent whatever was typed straight to the daemon,
 * which requires a uuid — so copying the id off the listing and running `pin rm <id>` always failed
 * with a bare `invalid`. Accepting the printed prefix here closes that loop, and an ambiguous or
 * unknown prefix is reported as itself instead of becoming a daemon-side validation error.
 */
export function resolvePinId(pins: readonly Pin[], token: string): string {
  const needle = token.trim().toLowerCase();
  if (needle.length === 0) throw new Error('a pin id is required — run `pin ls` to see them');

  const exact = pins.find(pin => pin.id.toLowerCase() === needle);
  if (exact !== undefined) return exact.id;

  if (needle.length < MINIMUM_PREFIX_LENGTH) {
    throw new Error(`pin id "${token.trim()}" is too short — give at least ${MINIMUM_PREFIX_LENGTH} characters`);
  }

  const matches = pins.filter(pin => pin.id.toLowerCase().startsWith(needle));
  const [first] = matches;
  if (first === undefined) throw new Error(`no pin matches "${token.trim()}" — run \`pin ls\` to see them`);
  if (matches.length > 1) {
    const candidates = matches.map(pin => shortPinId(pin.id)).join(', ');
    throw new Error(`"${token.trim()}" matches ${matches.length} pins (${candidates}) — give more characters`);
  }
  return first.id;
}

/** Reject an edit aimed at a message pin: only note pins carry editable text. */
export function assertEditablePin(pins: readonly Pin[], id: string): void {
  const pin = pins.find(candidate => candidate.id === id);
  if (pin !== undefined && pin.kind !== 'note') {
    throw new Error(`${shortPinId(id)} is a ${pin.kind} pin — only note pins have editable text`);
  }
}
