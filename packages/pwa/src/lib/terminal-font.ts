/**
 * WHICH FONT A TERMINAL DRAWS WITH — the theme's own monospace stack, with a face that is always there.
 *
 * THE DEFECT THIS EXISTS FOR. xterm sizes every cell from one measurement of `W` and then pads each
 * glyph out to that cell. That is exact for a monospace face and badly wrong for anything else: when
 * no face in a theme's `--font-mono` stack is installed, the generic `monospace` resolves to whatever
 * the host maps it to — on a box with only DejaVu Sans that is a PROPORTIONAL face, whose `W` is
 * nearly twice as wide as its `i`, so `bun dev` was drawn as `b u n  d e v`. Every theme family was
 * affected the same way, because every family's stack ends in the same generic.
 *
 * THE REMEDY IS A FACE THAT CANNOT BE MISSING, placed just before the generic: the theme's named
 * faces still win wherever they are installed, so a theme keeps its look, and when none is, the
 * bundled monospace face answers instead of whatever the host calls `monospace`.
 */

/** The family name the bundled monospace face is registered under. Not a font anybody has installed. */
export const TERMINAL_FONT_FACE = 'Ferretry Terminal Mono';

/** Splits a CSS `font-family` list on its top-level commas, keeping quoted names whole. */
function familyNames(stack: string): readonly string[] {
  const names: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const character of stack) {
    if (quote === null && (character === '"' || character === "'")) quote = character;
    else if (character === quote) quote = null;
    if (quote === null && character === ',') {
      names.push(current.trim());
      current = '';
    } else current += character;
  }
  names.push(current.trim());
  return names.filter(name => name !== '');
}

/**
 * The terminal's `font-family`: the theme's faces, then the bundled one, then the generic.
 *
 * Any `monospace` the theme listed is moved to the very end rather than kept in place, because a
 * generic family always matches — anything after it is unreachable — so the bundled face would never
 * be consulted if the generic stayed in front of it.
 */
export function terminalFontFamily(themeMonoStack: string): string {
  const named = familyNames(themeMonoStack).filter(name => name.toLowerCase() !== 'monospace');
  return [...named, `"${TERMINAL_FONT_FACE}"`, 'monospace'].join(', ');
}
