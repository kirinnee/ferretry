import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * G162: `transcriptBytes` hands out UNMASKED bytes, so it has ONE consumer, Conversation's reader. Ferrets passes it on
 * and the two harness plugins provide it; nobody else may call it. A production file that does is a masking hole.
 */
const ROOT = join(import.meta.dir, '../../../../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'tests', 'generated', '.worktrees']);
const ALLOWED = [
  // Ferrets passes it on, bound to one ferret, and the fake provides it.
  `packages${sep}core${sep}ferrets${sep}`,
  // The two harnesses that prove a transcript provide it.
  `packages${sep}plugins${sep}claude-code${sep}daemon${sep}`,
  `packages${sep}plugins${sep}codex${sep}daemon${sep}`,
  // The one consumer.
  `packages${sep}plugins${sep}conversation${sep}daemon${sep}`,
];

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

test('G162: only Conversation’s reader (and the providers that pass it on) mention transcriptBytes in production code', () => {
  const offenders: string[] = [];
  for (const top of ['packages']) {
    for (const file of sources(join(ROOT, top))) {
      const rel = relative(ROOT, file);
      if (ALLOWED.some(prefix => rel.startsWith(prefix))) continue;
      if (readFileSync(file, 'utf8').includes('transcriptBytes')) offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});
