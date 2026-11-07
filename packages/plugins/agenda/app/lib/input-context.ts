/**
 * AN INPUT CARD'S CONTEXT without the agent's prompt (copied from today's protocol `inputContextLines`, which Vault
 * now owns for the daemon): the daemon's own lines come first and the agent's sentence last, after the marker; the card
 * shows the prompt under the daemon's facts, so the context it draws leaves the prompt out. Pure.
 */

/** Where the agent's own sentence starts in an input card's agenda context (Vault's `INPUT_PROMPT_MARKER`). */
export const INPUT_PROMPT_MARKER = 'The agent says: ';

/** The daemon's own lines only, or `null` when there are none. */
export const inputContextLines = (context: string | null | undefined): string | null => {
  if (context == null) return null;
  const at = context.indexOf(INPUT_PROMPT_MARKER);
  const lines = (at < 0 ? context : context.slice(0, at)).trim();
  return lines === '' ? null : lines;
};
