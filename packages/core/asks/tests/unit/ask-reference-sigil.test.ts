import { describe, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import should from 'should';
import {
  ASK_REFERENCE_SIGIL,
  ASK_REFERENCE_SIGIL_CLASS,
  askReference,
  ALIAS_ASK_REFERENCE_SIGIL,
  stripAskReferenceSigil,
} from '../../contract/snapshot/ask-reference.ts';

const PACKAGES = join(import.meta.dir, '../../../..');

describe('the attention sigil', () => {
  it('should be ^, because ! starts a shell command in the agent composers', () => {
    should(ASK_REFERENCE_SIGIL).equal('^');
    should(ALIAS_ASK_REFERENCE_SIGIL).equal('!');
    should(askReference('A3')).equal('^A3');
  });

  it('should read the sigils people still type, and write none of them but ^', () => {
    for (const typed of ['^A3', '!A3', '?A3', 'A3', ' ^A3 ']) should(stripAskReferenceSigil(typed)).equal('A3');
    should(new RegExp(`^${ASK_REFERENCE_SIGIL_CLASS}A3$`, 'u').test('^A3')).be.true();
    should(new RegExp(`^${ASK_REFERENCE_SIGIL_CLASS}A3$`, 'u').test('!A3')).be.true();
    should(new RegExp(`^${ASK_REFERENCE_SIGIL_CLASS}A3$`, 'u').test('&A3')).be.false();
  });
});

/** Source directories whose files can emit text: everything but tests, generated files and dependencies. */
const SKIPPED = new Set(['node_modules', 'tests', 'generated', 'dist', '.turbo']);
const SOURCE = /\.(?:ts|tsx)$/u;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/u;
// A literal legacy reference in code: `!A3`, `!A<n>`, `!AN`, or a template `!${id}`. `!Array` and `!A` alone are not.
const LEGACY_LITERAL = /!A(?:[0-9]|<|N\b|\$\{)|!\$\{/u;

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (SOURCE.test(entry.name) && !/\.test\./u.test(entry.name)) yield path;
  }
}

describe('every source file under packages/', () => {
  it('should never emit the legacy !A reference (a comment may cite an old decision)', () => {
    const offenders: string[] = [];
    for (const file of sources(PACKAGES)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (COMMENT_LINE.test(line)) return;
          const code = line.replace(/\s\/\/.*$/u, '');
          if (LEGACY_LITERAL.test(code))
            offenders.push(`${relative(PACKAGES, file).split(sep).join('/')}:${index + 1}`);
        });
    }
    should(offenders).eql([]);
  });
});
