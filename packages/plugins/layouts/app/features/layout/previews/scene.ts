/**
 * WHAT A LAYOUT PREVIEW DRAWS, as data: for one layout key and one of its words, the little app the mini-frame shows.
 * Pure — no React, no DOM — so the mapping from "Navigation side: right" to "the menu is on the right" is one function a
 * test can read. A scene changes ONE thing and holds the rest at a neutral default, and `lit` names that one thing: it is
 * the only part drawn in the accent colour, so the eye lands on what the setting does.
 */
import type { ChoiceSetting } from '../../../lib/layout-model.ts';

type NavSide = 'left' | 'right' | 'top' | 'bottom';
type NavStyle = 'rail' | 'bar' | 'list';
type Density = 'comfortable' | 'compact';
/** The part of the frame the setting changes. */
type Lit = 'nav' | 'column' | 'rows';

export interface MiniShellState {
  /** `phone` is a narrow frame (the phone variants of each key); `wide` is a desktop window. */
  readonly device: 'wide' | 'phone';
  readonly side: NavSide;
  readonly style: NavStyle;
  /** Is the second column beside the page drawn? */
  readonly column: boolean;
  readonly density: Density;
  readonly lit: Lit;
  /** Draw a narrow frame beside the wide one, for a key whose word depends on the screen (`wide-only`). */
  readonly pair: boolean;
  /** Does the narrow frame of a pair show the second column? */
  readonly narrowColumn: boolean;
}

const NEUTRAL: MiniShellState = {
  device: 'wide',
  side: 'left',
  style: 'rail',
  column: false,
  density: 'comfortable',
  lit: 'nav',
  pair: false,
  narrowColumn: false,
};

const SIDES: readonly NavSide[] = ['left', 'right', 'top', 'bottom'];
const STYLES: readonly NavStyle[] = ['rail', 'bar', 'list'];

const side = (word: string): NavSide => SIDES.find(item => item === word) ?? NEUTRAL.side;
const style = (word: string): NavStyle => STYLES.find(item => item === word) ?? NEUTRAL.style;
const density = (word: string): Density => (word === 'compact' ? 'compact' : 'comfortable');

/** The frame `word` draws for `path`. A word it does not know draws the key's neutral frame. */
export function stateFor(path: ChoiceSetting['path'], word: string): MiniShellState {
  const phone = path.startsWith('phone.');
  const key = phone ? path.slice('phone.'.length) : path;
  const base: MiniShellState = { ...NEUTRAL, device: phone ? 'phone' : 'wide' };
  switch (key) {
    case 'nav.side':
      return { ...base, side: side(word) };
    case 'nav.style':
      return { ...base, style: style(word) };
    case 'side.show':
      // `wide-only` shows the column on a wide screen and not on a narrow one; `always` shows it on both.
      return phone
        ? { ...base, column: word === 'always', lit: 'column' }
        : { ...base, column: word !== 'never', lit: 'column', pair: true, narrowColumn: word === 'always' };
    case 'density':
      return { ...base, density: density(word), lit: 'rows' };
    default:
      return base;
  }
}

/** The word the loop starts from: the one before `word` in the list, wrapping round. */
export function wordBefore(options: readonly { readonly id: string }[], word: string): string {
  const index = options.findIndex(option => option.id === word);
  const before = options[(Math.max(index, 0) + options.length - 1) % options.length];
  return before?.id ?? word;
}
