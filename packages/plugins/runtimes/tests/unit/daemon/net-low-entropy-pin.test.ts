/**
 * CFG-LEAK (ii) the one KNOWN LIMIT of the net, pinned as a named set so it cannot grow (owner: britnee decides the
 * security design; the default stands until then).
 *
 * The net is "run the write rule (W) on what the cutter SHOWS, withhold what W still refuses". Over the 85,848-line
 * acceptance corpus it leaves exactly 57 refused lines shown in the Runtimes views (15 of them also at the kernel door, where
 * (B) showed them too), and every one carries only the 16-character LOW-entropy part `abababab12121212` (entropy 2.0, under W's
 * 3.5). W refused the RAW line only because the glued pointer text made the whole word look random; the cutter then cuts the
 * pointer and leaves `,abababab12121212`, which W accepts bare (`--key abababab12121212` is a write W allows). So the masked
 * item is no finding and the net, by its definition, does not fire. Widening that means changing W (its entropy gate) or
 * withholding every refused raw item the cutter did not remove entirely: neither is done here.
 *
 * This file lists the 57 (19 lines × 3 marks) and pins, for each: W refuses it raw, W accepts its masked text, W accepts
 * the low-entropy part bare, the views show it as the cutter leaves it, and the kernel door shows exactly the 15. A new
 * line of this kind (the full-corpus run lists them) is added here on purpose or the net is fixed. Fake only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { findFlagSecrets, shownWords } from '@ferretry/std/credential-words';
import { defineConfig } from '../../../../../core/kernel/contract/index.ts';
import { shownConfigText } from '../../../../../core/kernel/host/config/shown-text.ts';
import { viewsOf } from './net-views.ts';

const LOW = 'abababab12121212';
const MARKS = [',', ';', '&'];
const ZWSP = '\u200b';

/** The 19 lines per mark; `kernel` is true where the kernel door shows it too (the 5 header lines, as at (B)). */
const PER_MARK: readonly ((mark: string) => { readonly line: readonly string[]; readonly kernel: boolean })[] = [
  m => ({ line: [`--key \${secret:X}\\${m}${LOW} --model m`], kernel: false }),
  m => ({ line: [`--token=\${secret:X}\\${m}${LOW} x`], kernel: false }),
  m => ({ line: [`--key \${secret:X}\\\\${m}${LOW} --model m`], kernel: false }),
  m => ({ line: [`--token=\${secret:X}\\\\${m}${LOW} x`], kernel: false }),
  m => ({ line: [`--key ${ZWSP}\${secret:X}${m}${LOW} --model m`], kernel: false }),
  m => ({ line: [`--token=${ZWSP}\${secret:X}${m}${LOW} x`], kernel: false }),
  m => ({ line: [`--key u:\${secret:X}@h${m}${LOW} --model m`], kernel: false }),
  m => ({ line: [`--token=u:\${secret:X}@h${m}${LOW} x`], kernel: false }),
  m => ({ line: [`--key Bearer\${secret:X}${m}${LOW} --model m`], kernel: false }),
  m => ({ line: [`--token=Bearer\${secret:X}${m}${LOW} x`], kernel: false }),
  m => ({ line: [`--header=Authorization: Bearer \${SECRET:X}${m}${LOW}`], kernel: true }),
  m => ({ line: ['-H', `Authorization: Bearer \${SECRET:X}${m}${LOW}`], kernel: true }),
  m => ({ line: ['-H', `Authorization:Bearer \${SECRET:X}${m}${LOW}`], kernel: true }),
  m => ({ line: ['-H', `Authorization: Basic \${SECRET:X}${m}${LOW}`], kernel: true }),
  m => ({ line: ['-H', `Authorization: Token \${SECRET:X}${m}${LOW}`], kernel: true }),
  m => ({ line: [`--key $\${secret:X}${m}${LOW} --model m`], kernel: false }),
  m => ({ line: [`--token=$\${secret:X}${m}${LOW} x`], kernel: false }),
  m => ({ line: [`--key \${secret:X}}${m}${LOW} --model m`], kernel: false }),
  m => ({ line: [`--token=\${secret:X}}${m}${LOW} x`], kernel: false }),
];
const PINNED = MARKS.flatMap(mark => PER_MARK.map(make => make(mark)));

const fileDef = defineConfig({
  file: 'servers.yaml',
  schema: z.strictObject({ command: z.string().optional(), args: z.array(z.string()).default([]) }),
  axis: 'configure',
  loosens: () => [],
});
const FLOW = (line: readonly string[]): string =>
  `command: srv\nargs: [${line.map(word => JSON.stringify(word)).join(', ')}]\n`;

describe('CFG-LEAK (ii) 0 shown that W refuses on the masked text; 57 listed low-entropy values that W accepts bare', () => {
  it('is exactly 57 lines, 15 of them shown at the kernel door as well', () => {
    should(PINNED.length).equal(57);
    should(PINNED.filter(row => row.kernel).length).equal(15);
    should(new Set(PINNED.map(row => JSON.stringify(row.line))).size).equal(57);
  });

  it('each: W refuses it raw, W accepts what the cutter shows, W accepts the low-entropy part bare', () => {
    // Act
    const rows = PINNED.map(({ line }) => ({
      raw: findFlagSecrets({ args: line }).length,
      masked: findFlagSecrets({ args: shownWords(line).map(word => word.text) }).length,
      bare: findFlagSecrets({ args: ['--key', LOW] }).length,
    }));

    // Assert
    should(rows.filter(row => row.raw === 0)).eql([]);
    should(rows.filter(row => row.masked !== 0)).eql([]);
    should(rows.filter(row => row.bare !== 0)).eql([]);
  });

  it('each one’s value ALONE (the raw part left after the cut) passes W bare: the list hides no real leak', () => {
    for (const { line } of PINNED) {
      const text = shownWords(line)
        .map(word => word.text)
        .join(' ');
      // What the cut leaves: the text after the last `‹hidden›`, past its separator, up to the next blank.
      const left = text.slice(text.lastIndexOf('‹hidden›') + '‹hidden›'.length).replace(/^[\\,;&}]+/u, '');
      const value = left.split(/\s/u)[0] ?? '';
      should([line, value]).eql([line, LOW]);
      for (const form of [['--key', value], ['--token', value], [`--token=${value}`], ['-e', `API_KEY=${value}`]])
        should([form, findFlagSecrets({ args: form }).length]).eql([form, 0]);
    }
  });

  it('no line of the low-entropy family is shown that is not on the list (a shown line off the list fails)', () => {
    const pinned = new Set(PINNED.map(row => JSON.stringify(row.line)));
    const shapes: readonly ((m: string) => string)[] = [
      m => `\${secret:X}${m}${LOW}`,
      m => `\${secret:X}\\${m}${LOW}`,
      m => `\${SECRET:X}${m}${LOW}`,
      m => `\${X}${m}${LOW}`,
      m => `$\${secret:X}${m}${LOW}`,
      m => `u:\${secret:X}@h${m}${LOW}`,
      m => `Bearer\${secret:X}${m}${LOW}`,
      m => `\${secret:X}}${m}${LOW}`,
      m => `a${m}${LOW}`,
      m => `\${secret:X}${m}b=2${m}${LOW}`,
    ];
    const leads: readonly ((value: string) => readonly string[])[] = [
      value => ['--key', value],
      value => ['--token', value],
      value => [`--token=${value}`],
      value => ['-e', `API_KEY=${value}`],
      value => [`API_KEY=${value}`],
      value => ['-H', `Authorization: Bearer ${value}`],
      value => [`--key ${value} --model m`],
      value => [`--token=${value} x`],
      value => [`--header=Authorization: Bearer ${value}`],
    ];
    const offList = MARKS.flatMap(mark => shapes.flatMap(shape => leads.map(lead => lead(shape(mark)))))
      .filter(line => findFlagSecrets({ args: line }).length > 0)
      .filter(line =>
        viewsOf(line)
          .slice(0, 4)
          .some(view => view.text.includes('abababab')),
      )
      .filter(line => !pinned.has(JSON.stringify(line)));
    should(offList).eql([]);
  });

  it('each is shown by the Runtimes views as the cutter leaves it (the pointer cut, the low-entropy part left)', () => {
    for (const { line } of PINNED) {
      const [resolvedMcp] = viewsOf(line);
      should([line, resolvedMcp?.withheld]).eql([line, false]);
      should([line, resolvedMcp?.text.includes('abababab')]).eql([line, true]);
    }
  });

  it('the kernel door shows exactly the 15 header lines the same way, and withholds the rest', () => {
    const shown = PINNED.filter(({ line }) => {
      const result = shownConfigText(fileDef, 'servers.yaml', FLOW(line), 'fy');
      return result.kind === 'shown' && result.text.includes('abababab');
    });
    should(shown.map(row => row.line)).eql(PINNED.filter(row => row.kernel).map(row => row.line));
  });
});
