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
  var STYLES = ['studio', 'mission', 'neo', 'geist', 'contrast', 'glass', 'neumorphism', 'retro', 'lucid', 'hud', 'raw', 'swiss', 'pixel', 'antiposh', 'briefing'];
  var PALETTES = [
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
    'vaporwave',
    'cyberpunk',
    'hacker',
    'vintage',
    'mesh',
    'retrofuture',
    'briefing',
  ];
  /* The pre-split "family" a stored value may still carry: a palette id, with the style it was drawn for
     (`PaletteEntry.suggestedStyle`). */
  var FAMILY_STYLE = {
    studio: 'studio',
    mission: 'mission',
    neo: 'neo',
    geist: 'geist',
    contrast: 'contrast',
    phosphor: 'mission',
    blueprint: 'mission',
    broadsheet: 'geist',
    wayfinding: 'neo',
    ledger: 'geist',
    ma: 'geist',
  };
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
    if (value && Object.prototype.hasOwnProperty.call(FAMILY_STYLE, value.family)) {
      style = FAMILY_STYLE[value.family];
      palette = value.family;
    }
    if (value && STYLES.indexOf(value.style) >= 0) style = value.style;
    if (value && PALETTES.indexOf(value.palette) >= 0) palette = value.palette;
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
