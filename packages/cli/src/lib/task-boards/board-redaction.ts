/**
 * Strip anything capability-shaped out of a response before it reaches a terminal, a log, or a
 * transcript an agent will later quote back. The daemon should never send one, so this is the second
 * of two locks rather than the only one — but a board secret printed once is a board secret leaked.
 */
export function withoutCapabilities(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCapabilities);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.toLowerCase().includes('capability'))
      .map(([key, nested]) => [key, withoutCapabilities(nested)]),
  );
}

/** A board response, rendered for a human: JSON, redacted, stable key order. */
export function renderTaskBoardResponse(value: unknown): string {
  return JSON.stringify(withoutCapabilities(value), null, 2);
}
