import { describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES, CONFIG_TOO_LARGE } from '@ferretry/std/yaml';
import { parseProgressFile } from '../../../cli/lib/board-progress.ts';
import { parseCardPatch } from '../../../cli/lib/card-patch.ts';
import { readPatchText } from '../../../cli/lib/patch-document.ts';

// `fy card patch` and `fy card progress --file` read a file or stdin the person (or the ferret running the command)
// names, with no size cap of the CLI's own. They read through the shared bounded reader (`@ferretry/std/yaml`), so a
// hostile document is refused in one fixed sentence and the command finishes at once. A real patch is a few fields,
// each at most 64 KiB, so the 256 KiB cap does not touch one. One hostile text of each shape, through THIS plugin's own
// entry points (`readPatchText`, `parseCardPatch`, `parseProgressFile`).

const FAST_MS = 2000;

/** A nest of anchors, each aliasing the previous ten times: a million nodes from six short lines. */
const laughs = (): string => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  return names
    .map((name, index) => {
      const previous = names[index - 1];
      const items = previous === undefined ? 'x' : `*${previous}`;
      return `${name}: &${name} [${Array.from({ length: 10 }, () => items).join(', ')}]`;
    })
    .join('\n');
};

const HOSTILE: Readonly<Record<string, { readonly text: () => string; readonly sentence: string }>> = {
  'a patch over the size cap': { text: () => '#'.repeat(CONFIG_FILE_MAX_BYTES + 1), sentence: CONFIG_TOO_LARGE },
  'an alias bomb (nested anchors)': {
    text: laughs,
    sentence: 'the aliases (*name) in this file expand too far to read',
  },
  'a 128 KiB string aliased 18 000 times': {
    text: () => `s: &s ${'x'.repeat(128 * 1024)}\nl: [${'*s, '.repeat(18_000)}*s]\n`,
    sentence: 'the aliases (*name) in this file expand too far to read',
  },
  'a flood of % directive lines': {
    text: () => '%\n'.repeat(131_072),
    sentence: 'a % directive line is not one YAML knows',
  },
};

const refusal = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
};

describe('board cli: a hostile patch document is refused in a fixed sentence, promptly', () => {
  for (const [shape, { text, sentence }] of Object.entries(HOSTILE)) {
    test(`board readPatchText, ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      const read = readPatchText(hostile, 'p.yaml');
      expect(performance.now() - started).toBeLessThan(FAST_MS);
      expect(read.ok).toBe(false);
      expect(!read.ok && read.problem).toContain(`p.yaml cannot be read:\n  `);
      expect(!read.ok && read.problem).toContain(sentence);
    });

    test(`board parseCardPatch (fy card patch), ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      const result = parseCardPatch(hostile, 'p.yaml');
      expect(performance.now() - started).toBeLessThan(FAST_MS);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.problems.join('\n')).toContain(sentence);
    });

    test(`board parseProgressFile (fy card progress --file), ${shape}`, () => {
      const hostile = text();
      const started = performance.now();
      const said = refusal(() => parseProgressFile(hostile, 'p.yaml'));
      expect(performance.now() - started).toBeLessThan(FAST_MS);
      expect(said).toContain(sentence);
    });
  }
});

describe('board cli: a refused patch still says where the bad line is', () => {
  test('a syntax error is named by line and column', () => {
    const read = readPatchText('title: fine\nsummary: [unclosed\nnext: 1\n', 'p.yaml');
    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toMatch(/p\.yaml cannot be read:\n {2}line \d+, column \d+: \S/u);
  });

  test('a directive flood names the line it overflows at', () => {
    const read = readPatchText(`title: x\n${'%\n'.repeat(100)}`, 'p.yaml');
    expect(!read.ok && read.problem).toContain('line 66, column 1: a % directive line is not one YAML knows');
  });

  test('an alias that expands too far names the line and column of the alias', () => {
    const read = readPatchText(`a: &a [x, x, x, x, x, x, x, x, x, x]\nb: [${'*a, '.repeat(2_000)}*a]\n`, 'p.yaml');
    expect(!read.ok && read.problem).toMatch(/line 2, column \d+: the aliases \(\*name\) in this file expand too far/u);
  });
});
