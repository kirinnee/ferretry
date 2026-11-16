/**
 * The hostile files `readConfigText` must read in ONE pass, whatever their aliases do. This helper reads NO clock: the
 * unit tier reads them small and checks the answer; the perf tier (`tests/perf/yaml-text-bound.test.ts`) reads them at
 * the size limit and holds the time.
 */
import { CONFIG_FILE_MAX_BYTES } from '../../src/yaml-text.ts';

/** What the read must say: `undefined` is a clean read, a string a part of the refusal, a pattern one of two. */
type Refused = string | RegExp | undefined;

export interface HostileRead {
  readonly label: string;
  readonly text: string;
  readonly refused: Refused;
}

/** `scale` 1 is a file at the size limit; a fraction makes every size and count in the file that fraction of it. */
export const hostileReads = (scale: number): readonly HostileRead[] => {
  const limit = Math.floor(CONFIG_FILE_MAX_BYTES * scale);
  const count = (n: number): number => Math.max(2, Math.floor(n * scale));
  const fill = (head: string, line: (index: number) => string, tail = ''): string => {
    const lines = [head];
    let size = head.length + tail.length;
    for (let index = 0; size + 32 < limit; index += 1) {
      const next = line(index);
      lines.push(next);
      size += next.length;
    }
    return lines.join('') + tail;
  };
  const laughs = (() => {
    const lines = ['l0: &l0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]\n'];
    for (let level = 1; level < 10; level += 1) {
      lines.push(`l${level}: &l${level} [${Array.from({ length: 9 }, () => `*l${level - 1}`).join(', ')}]\n`);
    }
    return lines.join('');
  })();
  const deep = `a: ${'['.repeat(count(5000))}*nope${']'.repeat(count(5000))}\n`;
  const anchors = count(1500);
  const longString = 'x'.repeat(count(128 * 1024));

  return [
    {
      label: 'many aliases, the last unresolved',
      text: fill('a: &a 1\nb:\n', () => '  - *a\n', '  - *nope\n'),
      refused: 'not set before it',
    },
    { label: 'many aliases of one anchor', text: fill('a: &a 1\nb:\n', () => '  - *a\n'), refused: undefined },
    {
      label: 'many anchors, each aliased many times',
      text: fill(
        `${Array.from({ length: anchors }, (_, index) => `k${index}: &a${index} x\n`).join('')}b:\n`,
        index => `  - *a${index % anchors}\n`,
      ),
      refused: undefined,
    },
    {
      label: 'an anchor of an empty anchor, aliased many times',
      text: fill('e: &e []\na: &a [*e]\nb:\n', () => '  - *a\n'),
      refused: undefined,
    },
    {
      label: 'an alias bomb (billion laughs), padded',
      text: fill(laughs, index => `k${index}: v\n`),
      refused: 'expand too far',
    },
    {
      label: 'an alias loop at the end of a long anchor',
      text: fill('a: &a\n  b:\n', () => '    - 1\n', '    - *a\n'),
      refused: 'sits inside the anchor',
    },
    // Either refusal is right: the parser reads 5 000 levels unless the stack this process has left runs out first (it
    // depends on what ran before), and then it refuses the file itself, as too deeply nested.
    { label: 'one unresolved alias 5000 deep', text: deep, refused: /not set before it|too deeply nested/u },
    { label: 'one flat mapping', text: fill('', index => `k${index}: v\n`), refused: undefined },
    {
      label: 'one flow mapping',
      text: `${fill('{', index => `k${index}: 1, `)}z: 1}\n`,
      refused: undefined,
    },
    {
      label: 'an alias to a list as every key',
      text: fill('a: &a [1, 2, 3]\n', index => `? *a\n: ${index}\n`),
      refused: 'not a plain string',
    },
    {
      label: 'an alias to a string as every key',
      text: fill('a: &a k\n', index => `? *a\n: ${index}\n`),
      refused: undefined,
    },
    {
      label: 'a long string aliased on every line',
      text: fill(`s: &s ${longString}\nl:\n`, () => '  - *s\n'),
      refused: 'expand too far',
    },
    {
      label: 'a long string aliased under every key',
      text: fill(`s: &s ${longString}\nm:\n`, index => `  k${index}: *s\n`),
      refused: 'expand too far',
    },
    {
      label: 'a list as every key, beside many anchors',
      text: fill(
        `a: [${Array.from({ length: count(5000) }, (_, index) => `&n${index} 1`).join(', ')}]\n`,
        () => '? [k]\n: 1\n',
      ),
      refused: 'not a plain string',
    },
  ];
};

/** The answer a read of a hostile file must give: a clean read, or a first error that says `refused`. */
export const refusalOf = (actual: {
  readonly ok: boolean;
  readonly errors?: readonly { message: string }[];
}): string => (actual.ok ? '' : (actual.errors?.[0]?.message ?? ''));
