/** The default `howToResolve` when the raiser did not name a concrete action. */
export const DEFAULT_HOW_TO_RESOLVE = 'Answer this item on the agenda (it records who answered).';

/** Every spelling of the default an item raised before v4.109 may still carry in storage. */
const LEGACY_DEFAULTS: ReadonlySet<string> = new Set([
  'Answer this item on the attention board.',
  'Answer this item on the attention board (it records who answered).',
]);

/** The line to print for a stored `howToResolve`: a legacy default reads as the current one, anything else as written. */
export function displayHowToResolve(stored: string): string {
  return LEGACY_DEFAULTS.has(stored) ? DEFAULT_HOW_TO_RESOLVE : stored;
}
