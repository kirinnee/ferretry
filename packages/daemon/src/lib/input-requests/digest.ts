import { createHash } from 'node:crypto';
import type { InputTargetFacts } from '@ferretry/protocol';

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

/** sha-256 (lowercase hex) of the facts with every object's keys sorted: any changed fact changes the digest. */
export function digestFacts(facts: InputTargetFacts): string {
  return createHash('sha256')
    .update(JSON.stringify(sorted(facts)))
    .digest('hex');
}

/** sha-256 (lowercase hex) of one line of text. */
export function digestLine(line: string): string {
  return createHash('sha256').update(line).digest('hex');
}
