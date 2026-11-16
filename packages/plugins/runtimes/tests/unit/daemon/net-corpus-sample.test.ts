/**
 * CFG-LEAK (ii) a committed SAMPLE of the acceptance corpus: F1-F7 × leads × marks, over 2,000 lines, each sent through the
 * real Runtimes views (Resolved view, component detail, the runtime list's overridden flags: `net-views.ts`) and the real
 * kernel door (`shownConfigText`, flow and block list). None may show a part of a high-entropy fake secret.
 *
 * The full run (85,848 lines, 69,474 refused by the write rule) is evidence, not a test: it takes minutes. This is its
 * shape in a few seconds. Fake only: every value is shaped like a credential and is none.
 *
 * Per-test limit (testing standard, measured limits): each test below is alone and reads ~2,000 lines through ~7 views;
 * measured alone with `--coverage` under bun 1.4.4 (3 runs each) the numbers are in the limits' comments.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { findFlagSecrets } from '@ferretry/std/credential-words';
import { defineConfig } from '../../../../../core/kernel/contract/index.ts';
import { shownConfigText } from '../../../../../core/kernel/host/config/shown-text.ts';
import { viewsOf } from './net-views.ts';

const V = 'Zk3pQ9vXw2LmN7rT';
const GSK = 'gsk_AbCdEfGhIjKlMnOpQrSt12';
const LONG40 = 'Zk3pQ9vXw2LmN7rTHy8cBt4Fg6SdJ1uEqW5eR0tY';
const P = '${secret:X}';
const RAND5000 = Array.from({ length: 5000 }, (_, i) => LONG40.charAt((i * 7 + (i >> 3)) % LONG40.length)).join('');
const RAWS = [V, GSK, LONG40, `${V}a`, 'Hy8cBt4Fg6SdJ1uE', 'Qw3rTy7uIo9pAs5d'];
const MARKS = [',', ';', '&'];

const windowsOf = (secret: string): readonly string[] =>
  Array.from({ length: Math.max(0, secret.length - 7) }, (_, at) => secret.slice(at, at + 8));
const WINDOWS = [...RAWS, RAND5000.slice(0, 64)].flatMap(windowsOf);
const showsSecret = (text: string): boolean => WINDOWS.some(window => text.includes(window));

/** A value in each of the seven families F1-F7, ending in the raw part `raw` after `mark`. */
const SHAPES: readonly ((mark: string, raw: string) => string)[] = [
  (mark, raw) => `a${mark}${raw}`, // F1, no pointer at all
  (mark, raw) => `\${X}${mark}${raw}`, // F1, a look-alike
  (mark, raw) => `$X${mark}${raw}`,
  (mark, raw) => `\${SECRET:X}${mark}${raw}`,
  (mark, raw) => `\${secret:A${'B'.repeat(70)}}${mark}${raw}`, // F1, a name past 64
  (mark, raw) => `${P}${mark}\t${raw}`, // F2, a blank then the raw part
  (mark, raw) => `${P}${mark}\n${raw}`,
  (mark, raw) => `${P}${mark} ${raw}`,
  (mark, raw) => `https://u:${P}@h/p${mark}${raw}`, // F3
  (mark, raw) => `.a=${P}${mark}b=${raw}`, // F4
  (mark, raw) => `\${secret:X${mark}${raw}}`, // F5, never closed
  (mark, raw) => `\${secret: X}${mark}${raw}`,
  (mark, raw) => `\${X${mark}${raw}}`,
  (mark, raw) => `${P}${mark}b=2${mark}${raw}`, // the closed corpus too: a pointer, a key of its own, raw text
  (mark, raw) => `prefix${P}${mark}${raw}`,
  (mark, raw) => `x${mark}${P}${mark}${raw}`,
];
const LEADS: readonly ((value: string) => readonly string[])[] = [
  value => ['--key', value],
  value => ['--token', value],
  value => [`--token=${value}`],
  value => [`--api-key=${value}`],
  value => ['-e', `API_KEY=${value}`],
  value => [`API_KEY=${value}`],
  value => ['-H', `Authorization: Bearer ${value}`],
  value => ['--password', value],
  value => ['--client-secret', value],
  value => [`--auth-token=${value}`],
  value => ['--header', `X-Api-Key: ${value}`],
  // F7: one list item that holds blanks (a command line in one word).
  value => [`srv --token ${value}`],
  value => [`--token=${value} x`],
  value => ['sh', '-c', `srv --token ${value}`],
];

/** F1-F7 × leads × marks × raw parts, the lines the write rule refuses, with the F6 long line added. */
const LINES: readonly (readonly string[])[] = [
  ...RAWS.flatMap(raw => MARKS.flatMap(mark => SHAPES.flatMap(shape => LEADS.map(lead => lead(shape(mark, raw)))))),
  [`--token="\${secret:X,${RAND5000}}"`],
  [`--token="\${X,${RAND5000}}"`],
].filter(line => findFlagSecrets({ args: line }).length > 0);

const fileDef = defineConfig({
  file: 'servers.yaml',
  schema: z.strictObject({ command: z.string().optional(), args: z.array(z.string()).default([]) }),
  axis: 'configure',
  loosens: () => [],
});
const FLOW = (line: readonly string[]): string =>
  `command: srv\nargs: [${line.map(word => JSON.stringify(word)).join(', ')}]\n`;
const BLOCK = (line: readonly string[]): string =>
  `command: srv\nargs:\n${line.map(word => `  - ${JSON.stringify(word)}\n`).join('')}`;

describe('CFG-LEAK (ii) a sample of the acceptance corpus: F1-F7 × leads × marks', () => {
  it('the sample is more than 2,000 lines the write rule refuses', () => {
    should(LINES.length).be.above(2000);
  });

  // Limit 10 s: the file runs in about 1.4 s alone (3 runs: 1.37, 1.39, 1.36 s), the slowest test about 0.5 s; ~2,000 lines × 5 views.
  it('no Runtimes view shows a part of a secret: Resolved view, component detail, runtime list', () => {
    const leaked = LINES.flatMap(line =>
      viewsOf(line).some(view => showsSecret(view.text)) ? [JSON.stringify(line).slice(0, 120)] : [],
    );
    should(leaked).eql([]);
  }, 10_000);

  it('the kernel door shows no part of a secret either: flow and block list', () => {
    const leaked = LINES.flatMap(line =>
      [FLOW(line), BLOCK(line)].flatMap(text => {
        const result = shownConfigText(fileDef, 'servers.yaml', text, 'fy');
        return result.kind === 'shown' && showsSecret(result.text) ? [JSON.stringify(line).slice(0, 120)] : [];
      }),
    );
    should(leaked).eql([]);
  }, 10_000);
});
