import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import { composerInk, composerRows } from '../../../src/lib/index.ts';

/**
 * The ink of a composer, read from REAL `capture-pane -e` frames of Claude Code 2.1.281 and Codex 0.156.1
 * (`tests/fixtures/composer/*-ink-*.{txt,ansi,cursor}`), plus hand-built sequences for the shapes a
 * harness did not happen to draw. Each fixture is one frame captured twice — plain and with attributes.
 */

const FIXTURES = join(import.meta.dir, '../../fixtures/composer');
const ESC = '\u001b';

/** The attributed rows `captureFrame` would ask tmux for: just the composer's, from the plain frame's own rows. */
function ink(name: string): ReturnType<typeof composerInk> {
  const plain = readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
  const attributed = readFileSync(join(FIXTURES, `${name}.ansi`), 'utf8');
  const rows = composerRows(plain);
  if (rows === undefined) throw new Error(`${name} has no composer`);
  const take = (text: string): string[] => text.split('\n').slice(rows.first, rows.last + 1);
  return composerInk(`${take(attributed).join('\n')}\n`, take(plain));
}

const sgr = (...parameters: number[]): string => `${ESC}[${parameters.join(';')}m`;

describe('composerInk on real Claude Code 2.1.281 frames', () => {
  it('should read the ghost prompt suggestion as dim — the cursor parked at col 2 proves nothing', () => {
    should(ink('claude-2.1.281-ink-ghost')).equal('dim');
  });

  it('should read `Try "…"` as dim though its first glyph is the inverse-video fake cursor', () => {
    should(ink('claude-2.1.281-ink-try')).equal('dim');
  });

  it('should read `Press up to edit queued messages` as dim', () => {
    should(ink('claude-2.1.281-ink-queued')).equal('dim');
  });

  for (const state of ['typed-cursor-home', 'typed-cursor-end', 'typed-wrapped', 'pasted', 'busy-typed']) {
    it(`should read ${state} as plain, wherever the cursor is`, () => {
      should(ink(`claude-2.1.281-ink-${state}`)).equal('plain');
    });
  }
});

describe('composerInk on real Codex 0.156.1 frames', () => {
  it('should read `Ask Codex to do anything` as dim', () => {
    should(ink('codex-0.156.1-ink-empty')).equal('dim');
  });

  it('should read typed text as plain, with the cursor at the end or back at col 2', () => {
    should([ink('codex-0.156.1-ink-typed'), ink('codex-0.156.1-ink-typed-cursor-home')]).deepEqual(['plain', 'plain']);
  });
});

describe('composerInk on hand-built sequences', () => {
  const prompt = `${sgr(1)}›${sgr(0)} `;

  it('should read a composer with one plain glyph among dim ones as plain — the mixed case', () => {
    // Arrange — the person typed `!` in front of a still-dim suggestion.
    const attributed = `${prompt}!${sgr(2)}go ahead${sgr(0)}\n`;

    // Act
    const actual = composerInk(attributed, ['› !go ahead']);

    // Assert
    should(actual).equal('plain');
  });

  it('should read a wrapped draft as plain when only its second row is plain', () => {
    const attributed = `${prompt}${sgr(2)}go ahead${sgr(0)}\n  ${sgr(22)}and more\n`;

    should(composerInk(attributed, ['› go ahead', '  and more'])).equal('plain');
  });

  it('should not read a colour channel `2` as the dim attribute', () => {
    // Arrange — truecolor `38;2;…` and 256-colour `38;5;2` text, neither dim.
    const truecolor = `${prompt}${ESC}[38;2;10;20;30mtyped${sgr(0)}\n`;
    const indexed = `${prompt}${ESC}[38;5;2mtyped${sgr(0)}\n`;

    // Assert
    should([composerInk(truecolor, ['› typed']), composerInk(indexed, ['› typed'])]).deepEqual(['plain', 'plain']);
  });

  it('should keep dim through a foreground reset (39) and drop it at 22 or a reset', () => {
    const kept = `${prompt}${sgr(2)}${sgr(39)}hello${sgr(0)}\n`;
    const dropped22 = `${prompt}${sgr(2)}${sgr(22)}hello${sgr(0)}\n`;
    const dropped0 = `${prompt}${sgr(2)}${sgr(0)}hello\n`;

    should([
      composerInk(kept, ['› hello']),
      composerInk(dropped22, ['› hello']),
      composerInk(dropped0, ['› hello']),
    ]).deepEqual(['dim', 'plain', 'plain']);
  });

  it('should read a combined parameter list (`0;2`) as dim and an empty one as a reset', () => {
    const combined = `${prompt}${sgr(0, 2)}hello${sgr(0)}\n`;
    const bare = `${prompt}${sgr(2)}${ESC}[mhello\n`;

    should([composerInk(combined, ['› hello']), composerInk(bare, ['› hello'])]).deepEqual(['dim', 'plain']);
  });

  it('should ignore colon-form sub-parameters rather than read them as attributes', () => {
    const attributed = `${prompt}${ESC}[4:2m${sgr(2)}hello${sgr(0)}\n`;

    should(composerInk(attributed, ['› hello'])).equal('dim');
  });

  it('should skip inverse cells, the fake cursor, and leave the rest to decide', () => {
    const attributed = `${prompt}${sgr(7)}h${sgr(27)}${sgr(2)}ello${sgr(0)}\n`;

    should(composerInk(attributed, ['› hello'])).equal('dim');
  });

  it('should skip a box border, the prompt glyph and trailing blanks', () => {
    const attributed = `│ ${prompt}${sgr(2)}hello${sgr(0)}   │\n`;

    should(composerInk(attributed, ['│ › hello   │'])).equal('dim');
  });

  it('should step over other control sequences and a lone escape', () => {
    const attributed = `${prompt}${ESC}]8;;http://x${ESC}\\${sgr(2)}he${ESC}Mllo${sgr(0)}${ESC}\r\n`;

    should(composerInk(attributed, ['› hello'])).equal('dim');
  });

  it('should treat NBSP after the prompt as a blank, as the plain capture does', () => {
    const attributed = `${sgr(90)}❯ ${sgr(2)}go on${sgr(0)}\n`;

    should(composerInk(attributed, ['❯ go on'])).equal('dim');
  });
});

describe('composerInk when the ink cannot say', () => {
  const plain = ['› hello'];

  it('should say nothing about a capture with no attributes at all — colourless is not "typed"', () => {
    should(composerInk('› hello\n', plain)).be.undefined();
  });

  it('should say nothing when the two captures disagree on how many rows there are', () => {
    should(composerInk(`${sgr(2)}› hello${sgr(0)}\n${sgr(2)}more${sgr(0)}\n`, plain)).be.undefined();
  });

  it('should say nothing when a repaint between the captures changed the text', () => {
    should(composerInk(`${sgr(2)}› goodbye${sgr(0)}\n`, plain)).be.undefined();
  });

  it('should say nothing about a composer with no glyph but the prompt', () => {
    should(composerInk(`${sgr(1)}›${sgr(0)} \n`, ['›'])).be.undefined();
  });
});
