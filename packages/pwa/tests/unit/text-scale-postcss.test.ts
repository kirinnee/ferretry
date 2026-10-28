import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { textScalePostcss } from '../../src/lib/text-scale-postcss.ts';
import tailwindConfig from '../../tailwind.config.ts';

const run = async (css: string): Promise<string> =>
  (await postcss([textScalePostcss()]).process(css, { from: undefined })).css;

describe('textScalePostcss', () => {
  it('multiplies a plain pixel or rem font-size by the scale variable', async () => {
    const actual = await run('.a{font-size:11px}.b{font-size:.875rem}.c{font-size:12.5px}');

    expect(actual).toContain('.a{font-size:calc(11px * var(--fy-text-scale, 1))}');
    expect(actual).toContain('.b{font-size:calc(.875rem * var(--fy-text-scale, 1))}');
    expect(actual).toContain('.c{font-size:calc(12.5px * var(--fy-text-scale, 1))}');
  });

  it('multiplies the type tokens, wherever a theme declares them', async () => {
    const actual = await run(
      ':root[data-theme="x"]{--text-xs:11px;--font-size-base:17px;--text-display:1.15rem;--label-size:10px}',
    );

    expect(actual).toContain('--text-xs:calc(11px * var(--fy-text-scale, 1))');
    expect(actual).toContain('--font-size-base:calc(17px * var(--fy-text-scale, 1))');
    expect(actual).toContain('--text-display:calc(1.15rem * var(--fy-text-scale, 1))');
    expect(actual).toContain('--label-size:calc(10px * var(--fy-text-scale, 1))');
  });

  it('leaves inherited, compound, token-reading and non-type values alone', async () => {
    const css =
      '.a{font-size:1.2em}.b{font-size:max(16px,1em)}.c{font-size:var(--text-xs)}.d{--input-font-floor:16px;--panel-texture-size:4px;width:11px}.e{font-size:inherit}';

    expect(await run(css)).toBe(css);
  });

  it('does not multiply twice', async () => {
    const once = await run('.a{font-size:11px}');

    expect(await run(once)).toBe(once);
  });

  it('covers every token Tailwind resolves a font size to', () => {
    const tokens = Object.values(tailwindConfig.theme?.extend?.fontSize ?? {}).map(value =>
      String(value).replace(/^var\((--[a-z0-9-]+)\)$/u, '$1'),
    );

    expect(tokens.length).toBeGreaterThan(0);
    const themes = readFileSync(new URL('../../src/styles/themes.css', import.meta.url), 'utf8');
    for (const token of tokens) {
      const bare = [...themes.matchAll(new RegExp(`${token}\\s*:\\s*(-?[\\d.]+(?:px|rem))\\s*;`, 'gu'))];
      expect(bare.length).toBeGreaterThan(0);
      expect(run(`:root{${token}:1px}`)).resolves.toContain('var(--fy-text-scale, 1)');
    }
  });
});
