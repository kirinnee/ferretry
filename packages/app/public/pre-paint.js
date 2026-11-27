/* Pre-paint theme + text-scale bootstrap. Runs BEFORE first paint, so a hard load flashes neither the wrong theme
   nor the wrong type size. Copied from today's PWA onto the 5.0 storage record.

   THIS FILE IS THE SECOND IMPLEMENTATION OF ONE CONTRACT. The definition lives in `src/theme/preferences.ts`: the
   storage key (`fy:app:theme`), the record shape (`{ format: 1, value: { style, palette, mode, textScale } }`), the
   accepted modes, the root attributes (`data-style`, `data-palette`, `data-mode` and the legacy
   `data-theme="<palette>-<mode>"`) and the text-scale factors are THEIR decisions, restated here because nothing in
   `src/` can run this early. `tests/unit/pre-paint.test.ts` executes this script against those modules' own values and
   fails if the two drift.

   IT KEEPS NO LIST OF STYLE OR PALETTE IDS: the packs are folders (`src/theme/packs/`), and a list here would be a second
   place to edit for every new one. It paints any stored id shaped like a pack id (`PackIdSchema`: `^[a-z][a-z0-9-]{1,31}$`)
   and the default otherwise. An id with no pack matches no pack selector, so the base tokens paint (Studio, with the
   default palette's dark block as the dark baseline); React then publishes the default in its place. Nothing is rewritten.

   It is a classic, same-origin, parser-blocking script (no `type="module"`, no `defer`) so it satisfies
   `script-src 'self'` and still runs before paint; ES5-shaped and dependency-free because nothing transpiles it. */

(function () {
  var KEY = 'fy:app:theme';
  var PACK_ID = /^[a-z][a-z0-9-]{1,31}$/;
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
    if (value && typeof value.style === 'string' && PACK_ID.test(value.style)) style = value.style;
    if (value && typeof value.palette === 'string' && PACK_ID.test(value.palette)) palette = value.palette;
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
