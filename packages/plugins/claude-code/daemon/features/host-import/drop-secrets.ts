/**
 * No raw secret reaches a written settings file (r9 A6, from the A2 security review): a value found ANYWHERE in an
 * imported settings document that is a credential by its value (a token format) or by the key that holds it (`*_token`,
 * `*bearer*`, `apiKey`, `password`, `credentials`) is left out and said so. The Vault path moves only the values the
 * planner named (an `env` block); a secret anywhere else is refused here rather than copied.
 *
 * A pointer (`${secret:NAME}`, `$NAME`) holds no secret and stays. The sentence names the path, never the value.
 * The same rule, word for word, guards Codex's import (the codex plugin's own copy: a plugin owns its folder).
 */
import { looksSecretShown, shownWords } from '@ferretry/std/credential-words';

/** The words of one launch flag, hidden or not: a flag that carries a credential is dropped whole. */
export const flagHoldsSecret = (flags: readonly string[]): boolean => shownWords(flags).some(word => word.hidden);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sentence = (path: string): string => `Not imported: ${path} looks like a secret`;

/**
 * `value` without every string that looks like a credential under the key holding it. A list entry is judged under the
 * key of the list. Each removal adds a sentence naming its path to `dropped`.
 */
export function withoutSecrets(value: unknown, path: string, key: string, dropped: string[]): unknown {
  if (typeof value === 'string') {
    if (!looksSecretShown(key, value)) return value;
    dropped.push(sentence(path));
    return undefined;
  }
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const [index, entry] of value.entries()) {
      const clean = withoutSecrets(entry, `${path}[${index}]`, key, dropped);
      if (clean !== undefined) kept.push(clean);
    }
    return kept;
  }
  if (isRecord(value)) {
    const kept: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value)) {
      const clean = withoutSecrets(entry, `${path}.${name}`, name, dropped);
      if (clean !== undefined) kept[name] = clean;
    }
    return kept;
  }
  return value;
}
