/**
 * THE GOLDEN GATE of E-276 (each harness's runtime behaviour in its own plugin).
 *
 * A golden is the text a pure Runtimes function produced on the base, committed under `../fixtures/`. A later PR that
 * moves behaviour between folders must leave every golden byte-identical: it may not edit this folder (reviewers read
 * `git diff --name-only`), so a changed byte is a changed behaviour, never a changed expectation.
 *
 * WHAT MAKES A GOLDEN STABLE, by construction rather than by luck:
 *   - the producers are pure and are handed every input: a fixed layout of synthetic absolute paths (`/fy`,
 *     `/home/person`), minted ids from a fixed queue, a `generatedAt` string. No clock, no random id, no temp
 *     directory, no environment variable and no network is read; a host home is an in-memory tree.
 *   - the rendering is one function ({@link render}): keys sorted, one value per line, multi-line text (a wrapper
 *     script) written out whole between `<<<` and `>>>` so a diff reads as the script's own lines.
 *
 * `FY_GOLDEN_UPDATE=1` writes the files; it is refused under `CI`, and a missing golden FAILS (it is never created by a
 * plain run), so a deleted file cannot pass as a fresh one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'bun:test';

const FIXTURES = join(import.meta.dir, '..', 'fixtures');

const sortedKeys = (value: object): string[] => Object.keys(value).toSorted();

/** One value as stable text: objects with sorted keys, arrays in order, text with newlines written whole. */
function lines(value: unknown, depth: number): string[] {
  const pad = '  '.repeat(depth);
  if (value === undefined) return [`${pad}undefined`];
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return [`${pad}${JSON.stringify(value)}`];
  if (typeof value === 'string') {
    if (!value.includes('\n')) return [`${pad}${JSON.stringify(value)}`];
    return [`${pad}<<<`, ...value.split('\n').map(line => (line === '' ? '' : `${pad}  ${line}`)), `${pad}>>>`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    // An object item is fenced, so two items of one list can never run together.
    const item = (entry: unknown): string[] =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry) && Object.keys(entry).length > 0
        ? [`${pad}  {`, ...lines(entry, depth + 2), `${pad}  }`]
        : lines(entry, depth + 1);
    return [`${pad}[`, ...value.flatMap(item), `${pad}]`];
  }
  if (typeof value === 'object') {
    const keys = sortedKeys(value as object);
    if (keys.length === 0) return [`${pad}{}`];
    return keys.flatMap(key => {
      const inner = (value as Record<string, unknown>)[key];
      const body = lines(inner, depth + 1);
      const scalar = body.length === 1 && !body[0]?.trimStart().startsWith('<<<');
      return scalar
        ? [`${pad}${JSON.stringify(key)}: ${(body[0] as string).trimStart()}`]
        : [`${pad}${JSON.stringify(key)}:`, ...body];
    });
  }
  throw new Error(`a golden cannot render a ${typeof value}`);
}

/** The text a golden file holds for `value`. */
export const render = (value: unknown): string => `${lines(value, 0).join('\n')}\n`;

/** Fail unless `value` renders to exactly the committed golden `name` (`fixtures/<name>.golden.txt`). */
export function expectGolden(name: string, value: unknown): void {
  const path = join(FIXTURES, `${name}.golden.txt`);
  const text = render(value);
  if (process.env.FY_GOLDEN_UPDATE === '1') {
    if (process.env.CI !== undefined && process.env.CI !== '') throw new Error('FY_GOLDEN_UPDATE is refused under CI');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(
      `golden ${name} is missing: it is committed, never created by a plain run (FY_GOLDEN_UPDATE=1 on the BASE writes it)`,
    );
  }
  expect(text).toBe(readFileSync(path, 'utf8'));
}
