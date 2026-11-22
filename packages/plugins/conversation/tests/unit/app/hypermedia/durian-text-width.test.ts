/**
 * r12 H13 — OUR `textW` IS DURIAN'S. The build resolves the alignment grid's one import of the scene compiler to a stand-in
 * (`durian-shims/text-width.ts`) so the compiler stays out of every first load; the stand-in is a copy of one line, and this holds the
 * copy to the original on every character class, at several sizes, so a release that changes the estimate fails here.
 */
import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { textW as ours } from '../../../../app/hypermedia/durian-shims/text-width.ts';

const root = dirname(
  createRequire(join(import.meta.dir, '../../../../package.json')).resolve('durian-hypermedia/package.json'),
);
/** Durian's own, by a computed path: its source does not compile under this workspace's flags, so the type checker is not shown it. */
const { textW: theirs } = (await import(join(root, 'src/core/scene.ts'))) as {
  textW: (text: string, size?: number) => number;
};

const SAMPLES = [
  '',
  'seq 2001',
  "Hello, World! mwMW @#%& ilj.,:;'|!",
  'a'.repeat(200),
  'ÀÉÎõü ñ ß',
  'हिन्दी தமிழ் ಕನ್ನಡ മലയാളം',
  '日本語のテキスト 한국어 中文',
  '😀 emoji 🚀 and \u{20000}',
  `${String.fromCodePoint(0x08ff)}${String.fromCodePoint(0x0900)}${String.fromCodePoint(0x0dff)}${String.fromCodePoint(0x0e00)}${String.fromCodePoint(0x2e7f)}${String.fromCodePoint(0x2e80)}`,
  Array.from({ length: 95 }, (_, at) => String.fromCharCode(32 + at)).join(''),
];

describe('the text-width stand-in equals Durian’s textW', () => {
  for (const sample of SAMPLES)
    for (const size of [undefined, 11, 13, 16, 24])
      it(`${JSON.stringify(sample.slice(0, 20))} at ${size ?? 'the default size'}`, () => {
        expect(ours(sample, size)).toBe(theirs(sample, size));
      });
});
