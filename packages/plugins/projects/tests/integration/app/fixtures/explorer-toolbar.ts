/**
 * SHARED BY THE FOLDER EXPLORER'S BROWSER TESTS (O9-4): the scene's theme attributes and the toolbar probe.
 *
 * `applyTheme` paints a scene the way the shell does: `?theme=<palette>-<mode>` and `?style=<id>` become the
 * `data-palette`, `data-mode` and `data-style` the style sheets read. `STYLES` is what the tests walk, so the toolbar is
 * proved in the default style AND in Neumorphism (the style whose bigger controls and gaps overflowed a phone).
 * `probeToolbar` runs inside the page (it is serialised by `evaluate`, so it closes over nothing).
 */

/** The styles the explorer's toolbar is proved in: the default and the widest-controlled one. */
export const STYLES = ['studio', 'neumorphism'] as const;

/** Browser side: set the palette, mode and style the sheets read from the scene's query string. */
export const applyTheme = (params: URLSearchParams): void => {
  const theme = params.get('theme') ?? 'studio-light';
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.palette = theme.split('-')[0] ?? 'studio';
  root.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';
  root.dataset.style = params.get('style') ?? 'studio';
};

/** What the explorer's toolbar measures on the open page. */
export interface ToolbarProbe {
  viewport: number;
  /** The right edge of the furthest control. */
  lastRight: number;
  /** Controls narrower or shorter than a 44 px touch target (only measured on a phone), as `name WxH`. */
  small: string[];
  /** Whether any control sits left of the page edge. */
  clippedLeft: boolean;
  scrollOverflow: number;
}

/** Runs in the page. Every control the toolbar draws, measured against the viewport and the 44 px floor. */
export const probeToolbar = (): ToolbarProbe => {
  const bar = document.querySelector('[data-explorer-toolbar]');
  const controls = [...(bar?.querySelectorAll('button, [data-explorer-view-choice], input[role="switch"]') ?? [])];
  const rects = controls.map(element => ({
    name:
      element.getAttribute('data-explorer-view-choice') ??
      (element.textContent?.trim() || element.getAttribute('role') || ''),
    box: (element.getAttribute('role') === 'switch'
      ? (element.closest('label') ?? element)
      : element
    ).getBoundingClientRect(),
  }));
  const phone = window.matchMedia('(pointer: coarse)').matches;
  return {
    viewport: window.innerWidth,
    lastRight: Math.max(...rects.map(r => r.box.right)),
    small: phone
      ? rects
          .filter(r => r.box.width < 43.5 || r.box.height < 43.5)
          .map(r => `${r.name} ${Math.round(r.box.width)}x${Math.round(r.box.height)}`)
      : [],
    clippedLeft: rects.some(r => r.box.left < 0),
    scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};
