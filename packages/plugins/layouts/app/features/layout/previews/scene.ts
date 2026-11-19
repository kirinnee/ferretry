/**
 * WHAT A LAYOUT PREVIEW DRAWS, as data: for one layout key and one of its words, the little app the mini-frame shows.
 * Pure — no React, no DOM — so the mapping from a word to a picture is one function a test can read. A scene changes ONE
 * thing and holds the rest at a neutral default, and `lit` names that one thing: it is the only part drawn in the accent
 * colour, so the eye lands on what the setting does.
 *
 * A preview shows ONLY what the live shell draws today (`packages/app/src/shell/frame.tsx`, `drawer.tsx`,
 * `drawer-nav.tsx`) and never geometry it does not have: the menu is always the left drawer, so a word that the shell
 * draws the same as another draws the same picture here.
 *   - side `left`: the left drawer, nothing else. `bottom`: the drawer AND a bar of places under the page. (`right` and
 *     `top` are not offered: they draw what `left` draws.)
 *   - style `rail`: the drawer starts as a slim icon rail. `list`: it starts open, icon and name. (`bar` is not offered:
 *     it draws what `list` draws.)
 *   - on a phone the drawer is shut behind a menu button, so a phone's side `left` draws the menu button alone;
 *     only side `bottom` adds the bar of places. A phone has no style row.
 */
import type { ChoiceSetting } from '../../../lib/layout-model.ts';

/** The drawer's form: a slim icon `rail`, `open` (icon and name), or `none` (a phone: shut behind its menu button). */
type Drawer = 'rail' | 'open' | 'none';
type Density = 'comfortable' | 'compact';
/** The part of the frame the setting changes. */
type Lit = 'nav' | 'column' | 'rows';

export interface MiniShellState {
  /** `phone` is a narrow frame (the phone variants of each key); `wide` is a desktop window. */
  readonly device: 'wide' | 'phone';
  readonly drawer: Drawer;
  /** Is the bar of places drawn under the page? (Navigation side `bottom`.) */
  readonly bottom: boolean;
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
  drawer: 'rail',
  bottom: false,
  column: false,
  density: 'comfortable',
  lit: 'nav',
  pair: false,
  narrowColumn: false,
};

const density = (word: string): Density => (word === 'compact' ? 'compact' : 'comfortable');

/** The frame `word` draws for `path`. A word it does not know draws the key's neutral frame. */
export function stateFor(path: ChoiceSetting['path'], word: string): MiniShellState {
  const phone = path.startsWith('phone.');
  const key = phone ? path.slice('phone.'.length) : path;
  // A phone's drawer is shut behind its menu button.
  const base: MiniShellState = {
    ...NEUTRAL,
    device: phone ? 'phone' : 'wide',
    drawer: phone ? 'none' : NEUTRAL.drawer,
  };
  switch (key) {
    case 'nav.side':
      return { ...base, bottom: word === 'bottom' };
    case 'nav.style':
      return { ...base, drawer: word === 'rail' ? 'rail' : 'open' };
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
