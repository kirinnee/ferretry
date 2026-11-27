/**
 * What a producer answers, written down so a refusal is pinned as exactly as a value: `{ threw: 'sentence' }` or `{ value }`. The SENTENCE is the
 * contract; the error class that carries it is not (a later move may raise it from another file).
 */
export function outcome<T>(run: () => T): { readonly value: T } | { readonly threw: string } {
  try {
    return { value: run() };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

/** A word no harness plugin owns: the "third harness key" a Runtimes function must refuse by name, never answer with Claude's or Codex's. */
export const THIRD_KEY = 'opencode';
