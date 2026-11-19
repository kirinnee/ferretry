import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { SafeProse } from '../../../app/features/pr-page/safe-prose.tsx';

/** One comment is capped at 65,536 characters; each of these made the parser quadratic at that size. */
const CAP = 65_536;
const fill = (unit: string, lines = false): string =>
  lines ? unit : unit.repeat(Math.ceil(CAP / unit.length)).slice(0, CAP);

const HOSTILE: readonly (readonly [string, string])[] = [
  ['link openers', fill('[a](')],
  ['image openers', fill('![a](')],
  ['angle URL openers', fill('<https://')],
  ['unclosed comment openers', fill('<!--')],
  ['list with indented continuations', `- a\n${'  b\n'.repeat(13_000)}`.slice(0, CAP)],
  ['bare brackets', fill('[')],
  ['bare image brackets', fill('![')],
  ['bare backticks', fill('`a')],
  ['heading with trailing hashes', `# ${'a # '.repeat(16_000)}`.slice(0, CAP)],
  ['stars', fill('*')],
];

describe('a hostile comment at the size cap parses and renders in well under a second', () => {
  for (const [name, text] of HOSTILE) {
    test(name, () => {
      const started = performance.now();
      renderToString(createElement(SafeProse, { sourceUrl: 'https://github.com/o/r/pull/1', text }));
      expect(performance.now() - started).toBeLessThan(250);
    });
  }
});
