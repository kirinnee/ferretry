import { parseTaskRef } from '@ferretry/protocol';
import { legacyRefOf } from './legacy-card.ts';

/**
 * Reads `<session>:<old id>` as typed: the session, a colon, then the old id in any of its spellings (`&F12`,
 * `#F12`, `f12`), and answers the `legacyRef` the import recorded. `undefined` when it is not that shape.
 */
export const parseLegacyRef = (input: string): string | undefined => {
  const at = input.lastIndexOf(':');
  const sessionId = input.slice(0, at).trim();
  if (at < 1 || sessionId === '' || /\s/u.test(sessionId)) return undefined;
  const id = parseTaskRef(input.slice(at + 1).trim());
  return id.ok ? legacyRefOf(sessionId, id.value.id) : undefined;
};
