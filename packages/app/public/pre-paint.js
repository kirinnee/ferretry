/* Pre-paint theme + text-scale bootstrap. Runs BEFORE first paint, so a hard load flashes neither the wrong theme
   nor the wrong type size. Copied from today's PWA onto the 5.0 storage record.

   THIS FILE IS THE SECOND IMPLEMENTATION OF ONE CONTRACT. The definition lives in `src/theme/preferences.ts` and
   `src/theme/catalog.ts`: the storage key (`fy:app:theme`), the record shape
   (`{ format: 1, value: { style, palette, mode, textScale } }`, or the pre-split `{ family, mode, textScale }`), the
   accepted styles, palettes and modes, the root attributes (`data-style`, `data-palette`, `data-mode` and the legacy
   `data-theme="<palette>-<mode>"`) and the text-scale factors are all THEIR decisions, restated here because nothing in
   `src/` can run this early. `tests/unit/pre-paint.test.ts` executes this script against those modules' own values and
   fails if the two drift.

   It is a classic, same-origin, parser-blocking script (no `type="module"`, no `defer`) so it satisfies
   `script-src 'self'` and still runs before paint; ES5-shaped and dependency-free because nothing transpiles it. */

(function () {
  var KEY = 'fy:app:theme';
  // biome-ignore format: pre-paint.test.ts pins this exact one-line text, so the formatter must not wrap it
  var STYLES = ['studio', 'mission', 'neo', 'geist', 'glass', 'neumorphism', 'retro', 'lucid', 'hud', 'raw', 'swiss', 'pixel', 'antiposh', 'briefing', 'genz', 'exaggerated'];
  var PALETTES = ['studio', 'geist', 'mission', 'neo', 'hacker', 'vintage', 'vaporwave', 'contrast'];
  /* A palette id that no longer exists and the kept palette it reads as (`REMOVED_PALETTE_IDS` in the Layouts contract). */
  var REMOVED_PALETTES = {
    blueprint: 'mission',
    broadsheet: 'vintage',
    wayfinding: 'geist',
    phosphor: 'hacker',
    ledger: 'hacker',
    ma: 'vaporwave',
    retrofuture: 'vintage',
    cyberpunk: 'vaporwave',
    mesh: 'studio',
    briefing: 'geist',
  };
  /* The first style whose default palette this is (`lookOfPalette` in `catalog.ts`): the style a pre-split "family" read as. */
  var PALETTE_STYLE = {
    studio: 'studio',
    geist: 'geist',
    mission: 'mission',
    neo: 'neo',
    hacker: 'pixel',
    vintage: 'antiposh',
    vaporwave: 'genz',
    contrast: 'studio',
  };
  /* The pre-split "family" ids a stored value may still carry (`THEME_FAMILY_IDS`, frozen): each is a palette id. */
  var FAMILIES = [
    'studio',
    'mission',
    'neo',
    'geist',
    'contrast',
    'phosphor',
    'blueprint',
    'broadsheet',
    'wayfinding',
    'ledger',
    'ma',
  ];
  /* The kept palette an id reads as: itself, the mapped one when removed, otherwise nothing. */
  function current(id) {
    if (PALETTES.indexOf(id) >= 0) return id;
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(REMOVED_PALETTES, id)
      ? REMOVED_PALETTES[id]
      : null;
  }
  var MODES = ['system', 'light', 'dark'];
  var TEXT_SCALES = { default: 1, large: 1.125, larger: 1.25 };

  var style = 'studio';
  var palette = 'studio';
  var mode = 'system';
  var textScale = 'default';

  try {
    var raw = localStorage.getItem(KEY);
    var record = raw ? JSON.parse(raw) : null;
    var value = record && record.format === 1 ? record.value : null;
    // Each field falls back on its own, so one bad value never resets the others (as `ThemePreferenceSchema`).
    var fromFamily = value && FAMILIES.indexOf(value.family) >= 0 ? current(value.family) : null;
    if (fromFamily) {
      palette = fromFamily;
      style = PALETTE_STYLE[fromFamily];
    }
    // The removed `contrast` style is Studio in the High contrast palette; it wins over a stored palette.
    if (value && value.style === 'contrast') {
      style = 'studio';
      palette = 'contrast';
    } else {
      if (value && STYLES.indexOf(value.style) >= 0) style = value.style;
      if (value && current(value.palette)) palette = current(value.palette);
    }
    if (value && MODES.indexOf(value.mode) >= 0) mode = value.mode;
    if (value && Object.prototype.hasOwnProperty.call(TEXT_SCALES, value.textScale)) textScale = value.textScale;
  } catch (error) {
    /* Private mode, blocked storage or a damaged record: the defaults are a complete readable theme. */
  }

  var resolved =
    mode === 'system'
      ? window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode;

  var root = document.documentElement;
  root.setAttribute('data-style', style);
  root.setAttribute('data-palette', palette);
  root.setAttribute('data-mode', resolved);
  root.setAttribute('data-theme', palette + '-' + resolved);
  root.setAttribute('data-text-scale', textScale);
  root.style.setProperty('--fy-text-scale', String(TEXT_SCALES[textScale]));
})();
