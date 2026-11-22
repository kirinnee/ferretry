/**
 * THE LOOK OF THE APP A MESSAGE IS DRAWN IN: its mode (light or dark) and the two keyword slots of the style that a
 * stylesheet cannot branch on, `--hm-shape` (shaped | flat | ink | block) and `--hm-header` (band | label | none). The
 * continuous slots (`--hm-radius`, `--hm-stroke`…) and every colour are read by CSS alone (`dh-theme.css`).
 *
 * The root carries three axes, `data-style`, `data-palette` and `data-mode` (`theme/preferences.ts` in the app). A change of
 * ANY of them is a re-read; between changes nothing is read, so a streaming message that re-renders on every chunk costs a
 * string compare, not a style recalculation. It is a store for `useSyncExternalStore`, so the mode, the shape and the
 * header always agree with each other in one render.
 */

type HypermediaMode = 'light' | 'dark';
export type HypermediaShape = 'shaped' | 'flat' | 'ink' | 'block';
type HypermediaHeader = 'band' | 'label' | 'none';

export interface HypermediaLook {
  readonly mode: HypermediaMode;
  readonly shape: HypermediaShape;
  readonly header: HypermediaHeader;
}

const SHAPES: readonly HypermediaShape[] = ['shaped', 'flat', 'ink', 'block'];
const HEADERS: readonly HypermediaHeader[] = ['band', 'label', 'none'];
const AXES = ['data-style', 'data-palette', 'data-mode', 'data-theme'] as const;

/** What a page that says nothing draws: Studio's own set (the `--hm-*` defaults in `tokens/base-style.css`). */
const DEFAULT_LOOK: HypermediaLook = Object.freeze({ mode: 'light', shape: 'shaped', header: 'band' });

const oneOf = <T extends string>(allowed: readonly T[], value: string, fallback: T): T =>
  allowed.find(entry => entry === value) ?? fallback;

const lookOf = (root: HTMLElement): HypermediaLook => {
  const style = getComputedStyle(root);
  return {
    mode: root.dataset.mode === 'dark' ? 'dark' : 'light',
    shape: oneOf(SHAPES, style.getPropertyValue('--hm-shape').trim(), 'shaped'),
    header: oneOf(HEADERS, style.getPropertyValue('--hm-header').trim(), 'band'),
  };
};

let cachedKey = '';
let cached: HypermediaLook = DEFAULT_LOOK;

/** The current look; the same object until one of the root's theme attributes changes. */
export const readLook = (): HypermediaLook => {
  if (typeof document === 'undefined') return DEFAULT_LOOK;
  const root = document.documentElement;
  const key = AXES.map(axis => root.getAttribute(axis) ?? '').join('|');
  if (key !== cachedKey) {
    cachedKey = key;
    cached = lookOf(root);
  }
  return cached;
};

export const serverLook = (): HypermediaLook => DEFAULT_LOOK;

export const subscribeToLook = (notify: () => void): (() => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [...AXES] });
  return () => observer.disconnect();
};

/** Durian's `variant` for a shape: `shaped` is its default drawing, so it names none. */
export const variantOf = (shape: HypermediaShape): string | undefined => (shape === 'shaped' ? undefined : shape);
