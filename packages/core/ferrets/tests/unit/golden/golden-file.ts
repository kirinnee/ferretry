import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';

/**
 * E-276 goldens: the behaviour of the base, captured as text and compared BYTE FOR BYTE.
 *
 * A golden is a value built from synthetic inputs only (no clock, no temp path, no random id, no host environment)
 * and written as stable JSON: keys sorted, two-space indent, one trailing newline. A move PR must pass these files
 * UNCHANGED; it may not edit anything under `tests/unit/golden/`. Refreshing a file is a deliberate act:
 * `FY_UPDATE_GOLDEN=1 bun test <file>` rewrites it, and the diff is what the reviewer reads.
 */

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, sorted((value as Record<string, unknown>)[key])]),
        )
      : value;

/** The stable text of a value: what a golden file holds. */
const goldenText = (value: unknown): string => `${JSON.stringify(sorted(value), null, 2)}\n`;

/** Compares `value` with `fixtures/<name>.golden.json` next to this file, or rewrites that file when asked to. */
export function expectGolden(name: string, value: unknown): void {
  const file = join(import.meta.dir, 'fixtures', `${name}.golden.json`);
  const text = goldenText(value);
  if (process.env['FY_UPDATE_GOLDEN'] === '1') {
    writeFileSync(file, text);
    return;
  }
  should(text).equal(readFileSync(file, 'utf8'));
}
