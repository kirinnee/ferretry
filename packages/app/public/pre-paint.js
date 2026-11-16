/* Pre-paint theme + text-scale bootstrap. Runs BEFORE first paint, so a hard load flashes neither the wrong theme
   nor the wrong type size. Copied from today's PWA onto the 5.0 storage record.

   THIS FILE IS THE SECOND IMPLEMENTATION OF ONE CONTRACT. The definition lives in `src/theme/preferences.ts`: the
   storage key (`fy:app:theme`), the record shape (`{ format: 1, value: { family, mode, textScale } }`), the accepted
   families and modes, the `<html data-theme="<family>-<mode>">` shape and the text-scale factors are all ITS
   decisions, restated here because nothing in `src/` can run this early. `tests/unit/pre-paint.test.ts` executes this
   script against that module's own values and fails if the two drift.

   It is a classic, same-origin, parser-blocking script (no `type="module"`, no `defer`) so it satisfies
   `script-src 'self'` and still runs before paint; ES5-shaped and dependency-free because nothing transpiles it. */

(function () {
  var KEY = 'fy:app:theme';
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
  var MODES = ['system', 'light', 'dark'];
  var TEXT_SCALES = { default: 1, large: 1.125, larger: 1.25 };

  var family = 'studio';
  var mode = 'system';
  var textScale = 'default';

  try {
    var raw = localStorage.getItem(KEY);
    var record = raw ? JSON.parse(raw) : null;
    var value = record && record.format === 1 ? record.value : null;
    // Each field falls back on its own, so one bad value never resets the others (as `ThemePreferenceSchema`).
    if (value && FAMILIES.indexOf(value.family) >= 0) family = value.family;
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
  root.setAttribute('data-theme', family + '-' + resolved);
  root.setAttribute('data-text-scale', textScale);
  root.style.setProperty('--fy-text-scale', String(TEXT_SCALES[textScale]));
})();
