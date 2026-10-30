import { CLEARS_WHEN } from '../notify/request.ts';

/** The default `howToResolve` when the raiser did not name a concrete action. */
export const DEFAULT_HOW_TO_RESOLVE = 'Answer this item on the agenda (it records who answered).';

/** Every spelling of a default an item raised before v4.109 may still carry in storage, and what it reads as now. */
const LEGACY_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ['Answer this item on the attention board.', DEFAULT_HOW_TO_RESOLVE],
  ['Answer this item on the attention board (it records who answered).', DEFAULT_HOW_TO_RESOLVE],
  ['Acknowledge it on the attention board (Got it).', CLEARS_WHEN],
]);

/** The line to print for a stored `howToResolve`: a legacy default reads as the current one, anything else as written. */
export function displayHowToResolve(stored: string): string {
  return LEGACY_DEFAULTS.get(stored) ?? stored;
}
