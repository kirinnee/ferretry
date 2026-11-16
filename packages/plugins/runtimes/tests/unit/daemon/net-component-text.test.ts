/**
 * CFG-LEAK (ii) the text of an instructions or hooks file (`content`) is cut by `redactText` and then NETTED line by
 * line: a line the write rule's text test (`rawTextHoldsSecret`) still refuses after the cut is replaced by one plain
 * withheld line (`WITHHELD_LINE`), every other line stays as the cut left it. Fake values only.
 *
 * Per-test limits (testing standard): how it grows at 256 KiB is tests/perf/daemon/net-component-text.test.ts; the
 * repo prose test reads every `docs/**` markdown file once (about 6 s alone), so both carry an explicit limit.
 */
import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import should from 'should';
import { findFlagSecrets, rawTextHoldsSecret } from '@ferretry/std/credential-words';
import { WITHHELD_LINE } from '../../../daemon/lib/service/catalog.ts';
import { shownFor } from './redact-support.ts';

const LONG40 = 'Zk3pQ9vXw2LmN7rTHy8cBt4Fg6SdJ1uEqW5eR0tY';
const V = 'Zk3pQ9vXw2LmN7rT';
const windowsOf = (secret: string): readonly string[] =>
  Array.from({ length: Math.max(0, secret.length - 7) }, (_, at) => secret.slice(at, at + 8));
const WINDOWS = [LONG40, V].flatMap(windowsOf);
const leaks = (text: string): boolean => WINDOWS.some(window => text.includes(window));

/** The lines of a shown text the write rule's text test still refuses: the netted text must hold none. */
const refusedLines = (shown: string): readonly string[] =>
  shown.split('\n').filter(line => rawTextHoldsSecret(line.replace(/\r$/u, '')));

const SHAPES: Readonly<Record<string, string>> = {
  'bare long value under a plain key': `intro\nkey: ${LONG40}\noutro`,
  'a pointer then a raw value': `\${secret:X};password=${V}\nafter`,
  'a pointer then a long raw value': `\${secret:X};token=${LONG40}`,
  'a token in yaml front matter': `---\ntoken: ${LONG40}\ntitle: notes\n---\nbody`,
  'a fenced block': `before\n\`\`\`yaml\nkey: ${LONG40}\n\`\`\`\nafter`,
  'a block scalar': `credential: |\n  ${LONG40}\nnext: ok`,
  'a folded block scalar': `credential: >-\n  ${LONG40}\nnext: ok`,
  'windows line ends': `one\r\nkey: ${LONG40}\r\nthree\r\n`,
  'a CR-only file': `one\rkey: ${LONG40}\rthree`,
  'a 5,000-char line': `${'x '.repeat(2500)}key: ${LONG40}`,
};

describe('component text lines the write rule refuses are withheld', () => {
  for (const [name, text] of Object.entries(SHAPES)) {
    it(`should show no line the write rule refuses, and no value, for ${name}`, () => {
      // Act
      const shown = shownFor(text);

      // Assert
      should(refusedLines(shown.text)).deepEqual([]);
      should(leaks(shown.text)).be.false();
      should(shown.text.split(/\r\n|\r|\n/u).length).equal(text.split(/\r\n|\r|\n/u).length);
    });
  }

  it('should replace a bare long value under a plain key by the withheld line and keep its neighbours', () => {
    // Act
    const shown = shownFor(SHAPES['bare long value under a plain key'] ?? '');

    // Assert
    should(shown.text).equal(`intro\n${WITHHELD_LINE}\noutro`);
    should(shown.redacted).be.true();
  });

  it('should keep the break of a CR-only file and withhold only the line that holds the value', () => {
    // Act
    const shown = shownFor(SHAPES['a CR-only file'] ?? '');

    // Assert
    should(shown.text).equal(`one\r${WITHHELD_LINE}\rthree`);
  });

  for (const [name, text] of Object.entries({
    'the words password secret token and api key alone':
      'Set the password, the secret, the token and the api key in the store.',
    'a pointer alone': 'password: ${secret:DB_PASSWORD}',
    'a link with a page': 'See [next](https://example.com/docs?page=2) for more.',
    'a git sha in prose': 'Fixed in commit 4389fa6d1e0c5b8a7f3d2c1b0a9e8d7c6b5a4f3e of the repo.',
  })) {
    it(`should show ${name} as it is`, () => {
      // Act
      const shown = shownFor(text);

      // Assert: whatever W's own text test decides on the line decides here; a pass-through is the expectation.
      if (rawTextHoldsSecret(text)) should(shown.text).equal(WITHHELD_LINE);
      else should(shown.text).equal(text);
    });
  }

  it('should withhold nothing in the repo prose that the write rule accepts', () => {
    // Arrange
    const root = join(import.meta.dir, '../../../../../..');
    const files = [...new Glob('docs/**/*.md').scanSync({ cwd: root }), 'CLAUDE.md'];
    let lines = 0;
    const overWithheld: string[] = [];

    // Act
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8');
      const shown = shownFor(text).text.split('\n');
      text.split('\n').forEach((line, at) => {
        lines += 1;
        // The write rule reads an instructions text two ways: as lines of text, and as a value (the flag rule).
        const unit = line.replace(/\r$/u, '');
        if (shown[at] === WITHHELD_LINE && !rawTextHoldsSecret(unit) && findFlagSecrets({ text: unit }).length === 0)
          overWithheld.push(`${file}:${String(at + 1)}`);
      });
    }

    // Assert
    should(lines).be.above(1000);
    should(overWithheld).deepEqual([]);
  }, 60_000);
});
