/**
 * Today's rule for the words of a command line in the Resolved view, FROZEN from 4.291.5
 * (`packages/daemon/src/lib/fleet/resolved-view.ts` at bb89d054d: `said('', flag)` for a launch flag and
 * `serverLine` for an MCP server), so the differential can hold 5.0 to it. Only the imports are changed: it
 * shares the live `looksSecret`, which is byte-identical to today's.
 *
 * Do not edit this to follow 5.0. It is the floor 5.0 must hide at least as much as.
 */
import { looksSecret } from '../../../daemon/lib/account/import.ts';

const RESOLVED_HIDDEN_TEXT = '‹hidden›';

/** Today's launch flag: hidden whole when it looks like a credential under no name, else as written. */
export function todayFlag(flag: string): { readonly value: string; readonly hidden?: true } {
  return looksSecret('', flag) ? { value: RESOLVED_HIDDEN_TEXT, hidden: true } : { value: flag };
}

/** Today's `serverLine` for a server started by a command (a url server is not a command line). */
export function todayServerLine(server: { readonly command?: string; readonly args?: readonly string[] }): string {
  const words = [server.command ?? '', ...(server.args ?? [])].filter(word => word !== '');
  return words.map(word => (looksSecret('', word) ? RESOLVED_HIDDEN_TEXT : word)).join(' ');
}
