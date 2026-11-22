/**
 * THE 3D STAGE'S COLOURS, AS THREE.JS CAN READ THEM (r2 review, end-list L145). Durian's 3D stage turns each CSS token it
 * reads from its host into a three.js colour like this: `probe.fillStyle = <the token>; new THREE.Color(probe.fillStyle)`. The
 * canvas hands back what the browser serialises, and for a `color-mix()` that is `color(srgb 0.59 0.59 0.6)`, which three.js
 * does not parse: the colour silently stays WHITE. So every mixed token (the edge greys, the soft tints) drew as white: a dark
 * accent edge on a white fill at 2.77:1, a light plain edge white on white at 1.00:1.
 *
 * The recipes stay CSS (`dh-theme.css` declares each mix as `--stage-src-<name>` on the part's box, from the theme's own
 * tokens); this resolves each one to the plain `rgb(r, g, b)` the canvas draws for it and sets it as `--stage-<name>` on the
 * same box, where the stage's host (`.scn3`) reads it. It runs when the box mounts and again, BEFORE Durian's own observer
 * (created later, with the 3D stage), whenever the look changes, so Durian's re-read sees the new values.
 *
 * No imports: it runs as-is in a page, which is how the real-Chromium test loads it.
 */

/** The tokens the stage reads that are mixes. Each has a `--stage-src-<name>` recipe in `dh-theme.css`. */
const STAGE_MIXED_TOKENS = [
  'line',
  'line-2',
  'acc-soft',
  'acc-softer',
  'hot-soft',
  'good-soft',
  'warn-soft',
  'c1-soft',
  'c2-soft',
  'c3-soft',
  'c4-soft',
  'c5-soft',
  'c6-soft',
  'c7-soft',
  'c8-soft',
  'c1',
  'c2',
  'c3',
  'c4',
  'c5',
  'c6',
  'c7',
  'c8',
] as const;

/** The attributes the look lives in (the app's three axes, and the ones Durian's own stage watches). */
const LOOK_ATTRIBUTES = ['data-theme', 'data-palette', 'data-mode', 'data-style', 'class', 'style'];

let probeContext: CanvasRenderingContext2D | null | undefined;

const probe = (): CanvasRenderingContext2D | null => {
  if (probeContext === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    probeContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  return probeContext;
};

/** What the canvas draws for a CSS colour, as `rgb(r, g, b)`; null when it is not a colour (the canvas then keeps what it held) or is not opaque. */
function resolveToRgb(css: string): string | null {
  const context = probe();
  if (context === null || css.trim() === '') return null;
  context.clearRect(0, 0, 1, 1);
  // Transparent first: a value the canvas cannot parse leaves it in place and the pixel stays empty (alpha 0), like a translucent one.
  context.fillStyle = 'transparent';
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined || a !== 255) return null;
  return `rgb(${r}, ${g}, ${b})`;
}

/** Sets `--stage-<name>` on the box for every mixed token, from its `--stage-src-<name>` recipe. A recipe that does not resolve clears the value (the stylesheet's own fallback then applies). */
function resolveStageColours(box: HTMLElement): void {
  const style = getComputedStyle(box);
  const resolved = STAGE_MIXED_TOKENS.map(
    name => [name, resolveToRgb(style.getPropertyValue(`--stage-src-${name}`))] as const,
  );
  for (const [name, rgb] of resolved) {
    if (rgb === null) box.style.removeProperty(`--stage-${name}`);
    else box.style.setProperty(`--stage-${name}`, rgb);
  }
}

const boxes = new Set<HTMLElement>();
let observer: MutationObserver | undefined;

const resolveAll = (): void => {
  for (const box of boxes) {
    if (box.isConnected) resolveStageColours(box);
    else boxes.delete(box);
  }
};

/**
 * Keeps a part's box resolved for as long as it is mounted; returns the stop. One observer serves every box, and it is created
 * with the first one, so it is older than any 3D stage's own observer and runs before it.
 */
export function watchStageColours(box: HTMLElement): () => void {
  boxes.add(box);
  resolveStageColours(box);
  if (observer === undefined) {
    observer = new MutationObserver(resolveAll);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: LOOK_ATTRIBUTES });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', resolveAll);
  }
  return () => {
    boxes.delete(box);
  };
}
