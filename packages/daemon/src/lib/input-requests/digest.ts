import { createHmac, randomBytes } from 'node:crypto';
import type { InputTargetFacts } from '@ferretry/protocol';

/**
 * KEYED, NOT PLAIN. A digest of a prompt line is shown to the owner's client and compared on Send; had it been
 * a bare sha-256, anyone who could read it could test guesses against a line that echoed a value. The key is
 * random per process and never leaves it, so a digest is only ever compared, never reproduced elsewhere.
 */
const KEY = randomBytes(32);

const keyed = (text: string): string => createHmac('sha256', KEY).update(text).digest('hex');

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sorted(entry)]),
    );
  }
  return value;
}

/** Keyed sha-256 (lowercase hex) of the facts with every object's keys sorted: any changed fact changes the digest. */
export function digestFacts(facts: InputTargetFacts): string {
  return keyed(JSON.stringify(sorted(facts)));
}

/** Keyed sha-256 (lowercase hex) of one line of text. */
export function digestLine(line: string): string {
  return keyed(line);
}
