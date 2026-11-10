/**
 * S6 CFG-LEAK-W: F1-F7, the class the word cutter does not cut and the write rule (W, `findFlagSecrets`) refuses: the
 * kernel withholds AND the Runtimes views withhold / hide.
 *
 * The class: a value W refuses WHOLE that the cutter, one implementation in `@ferretry/std/credential-words`, still SHOWS.
 * Seven families (the review's B1, `cfg-leak-b-findings4.md`):
 *
 * - F1 a credential KEY whose first piece is no secret, or a look-alike of a reference (`${X}`, `$X`, a name past 64)
 * - F2 a blank inside the value, and a known token shape after it
 * - F3 a pointer in a URL's user part, a token after a `,`
 * - F4 a value starting `.` (W's place test)
 * - F5 a broken pointer (`${secret:X,…}`, `${secret: X}`)
 * - F6 past W's 4096-character reference window
 * - F7 one list item holding blanks (a command line in one word)
 *
 * They are held by a NET in each consumer, not by the cutter: each consumer runs W on what its cutter SHOWS and withholds
 * what W still refuses, in plain words and never as partial text. Each row alone, in each place a person can read it:
 * (i)  THE KERNEL DOORS. `shownConfigText` is the one function `GET /v1/config/file` and `config_read` ask: it
 *      withholds a text whose masked value W still refuses (`unmaskable`, or `raw_secret`), or shows it with no raw part
 *      left, in the flow list form and the block list form.
 * (ii) THE RUNTIMES VIEWS. The Resolved view (an MCP server's line, a settings component's flags), a component's detail
 *      (MCP args, settings flags: the WHOLE list is withheld) and the runtime list's overridden flags show no raw part.
 *
 * Rows, no skip and no todo. Every value is fake: it is shaped like a credential and is none.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { findFlagSecrets } from '@ferretry/std/credential-words';
import { defineConfig } from '../../../../../core/kernel/contract/index.ts';
import { shownConfigText } from '../../../../../core/kernel/host/config/shown-text.ts';
import { VIEW_NAMES, viewsOf } from './net-views.ts';

const V = 'Zk3pQ9vXw2LmN7rT';
const GSK = 'gsk_AbCdEfGhIjKlMnOpQrSt12';
const LONG40 = 'Zk3pQ9vXw2LmN7rTHy8cBt4Fg6SdJ1uEqW5eR0tY';
const RAND5000 = Array.from({ length: 5000 }, (_, i) => LONG40.charAt((i * 7 + (i >> 3)) % LONG40.length)).join('');

/** Every 8-character window of every fake secret: one of them in a text is a raw part of a secret shown. */
const WINDOWS = [V, GSK, RAND5000.slice(0, 64)].flatMap(secret =>
  Array.from({ length: secret.length - 7 }, (_, at) => secret.slice(at, at + 8)),
);
const showsSecret = (text: string): boolean => WINDOWS.some(window => text.includes(window));

const fileDef = defineConfig({
  file: 'servers.yaml',
  schema: z.strictObject({ command: z.string().optional(), args: z.array(z.string()).default([]) }),
  axis: 'configure',
  loosens: () => [],
});

interface Row {
  readonly family: 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7';
  readonly id: string;
  readonly line: readonly string[];
}

/** One or two lines of each family, and the no-pointer twins that are open too (the review's repro lines). */
const ROWS: readonly Row[] = [
  { family: 'F1', id: 'a key whose first piece is no secret, after a look-alike `${X}`', line: [`API_KEY=\${X},${V}`] },
  { family: 'F1', id: 'a look-alike `$X` after -e', line: ['-e', `API_KEY=$X,${V}`] },
  { family: 'F1', id: 'a look-alike `${SECRET:X}`', line: [`API_KEY=\${SECRET:X},${V}`] },
  { family: 'F1', id: 'a header, `Bearer ${X},v`', line: ['-H', `Authorization: Bearer \${X},${V}`] },
  { family: 'F1', id: 'a pointer name past 64 characters', line: [`API_KEY=\${secret:A${'B'.repeat(70)}},${GSK}`] },
  { family: 'F1', id: 'no pointer at all, `API_KEY=a,v`', line: [`API_KEY=a,${V}`] },
  { family: 'F2', id: 'a tab, then a token shape', line: ['--key', `\${secret:X},\t${GSK}`] },
  { family: 'F2', id: 'a newline, then a token shape', line: [`API_KEY=\${secret:X},\n${GSK}`] },
  { family: 'F3', id: 'a pointer in a URL user part', line: ['--key', `https://u:\${secret:X}@h/p,${GSK}`] },
  { family: 'F4', id: 'a value starting `.`', line: ['--key', `.a=\${secret:X},b=${GSK}`] },
  { family: 'F5', id: 'a pointer never closed', line: ['--key', `\${secret:X,${GSK}}`] },
  { family: 'F5', id: 'a pointer with a blank in its name', line: [`API_KEY=\${secret: X},${GSK}`] },
  { family: 'F5', id: 'a look-alike never closed, no pointer', line: ['--key', `\${X,${GSK}}`] },
  { family: 'F6', id: 'past the 4096-character reference window', line: [`--token="\${secret:X,${RAND5000}}"`] },
  { family: 'F7', id: 'one item, `srv --token ${secret:X},b=v`', line: [`srv --token \${secret:X},b=${V}`] },
  { family: 'F7', id: 'one item, `--token=${secret:X},b=v x`', line: [`--token=\${secret:X},b=${V} x`] },
  { family: 'F7', id: 'one item, a second flag after the value', line: [`--key \${secret:X},b=${V} --model m`] },
  { family: 'F7', id: 'a shell -c string', line: ['sh', '-c', `srv --token \${secret:X},${V}`] },
  { family: 'F7', id: 'one item, no pointer, `srv --token v`', line: [`srv --token ${V}`] },
];

const FLOW = (line: readonly string[]): string =>
  `command: srv\nargs: [${line.map(word => JSON.stringify(word)).join(', ')}]\n`;
const BLOCK = (line: readonly string[]): string =>
  `command: srv\nargs:\n${line.map(word => `  - ${JSON.stringify(word)}\n`).join('')}`;

describe('S6 CFG-LEAK-W F1-F7: the kernel withholds AND the Runtimes views withhold / hide', () => {
  it('every row is a line W refuses (so the class is the one the net holds)', () => {
    const notRefused = ROWS.filter(row => findFlagSecrets({ args: row.line }).length === 0).map(row => row.id);
    should(notRefused).eql([]);
  });

  for (const row of ROWS) {
    it(`${row.family} (${row.id}): the kernel door withholds it or shows no raw part, flow and block lists`, () => {
      for (const [form, text] of [
        ['flow', FLOW(row.line)],
        ['block', BLOCK(row.line)],
      ] as const) {
        const result = shownConfigText(fileDef, 'servers.yaml', text, 'fy');
        const safe =
          result.kind === 'withheld'
            ? result.reason === 'unmaskable' || result.reason === 'raw_secret'
            : !showsSecret(result.text);
        should([form, safe, result.kind]).eql([form, true, result.kind]);
      }
    });

    it(`${row.family} (${row.id}): no Runtimes view shows a raw part (Resolved view, component detail, runtime list)`, () => {
      const shown = viewsOf(row.line).map((view, at) => [VIEW_NAMES[at], showsSecret(view.text)] as const);
      should(shown.filter(([, leaked]) => leaked)).eql([]);
    });
  }

  it('the net fires in EVERY Runtimes view on this class: each view withholds at least one row, in words', () => {
    // A view whose net were removed would show these rows raw (the mutation each view is held to): so each view must
    // answer "withheld" for at least one of them, and say so in plain words rather than blank.
    const withheldPerView = VIEW_NAMES.map((name, at) => [
      name,
      ROWS.filter(row => viewsOf(row.line)[at]?.withheld === true).length,
    ]);
    should(withheldPerView.filter(([, count]) => (count as number) === 0)).eql([]);
  });
});
