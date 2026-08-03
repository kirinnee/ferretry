/* Pre-paint theme + text-scale bootstrap. Runs BEFORE first paint, so a hard
   load flashes neither the wrong theme nor the wrong type size.

   THIS FILE IS THE SECOND IMPLEMENTATION OF ONE CONTRACT. The definition lives
   in `src/lib/theme-preferences.ts` — the storage key, the accepted families and
   modes, the resolution order, the `<html data-theme="<family>-<mode>">` shape
   and the text-scale factors are all ITS decisions, restated here because
   nothing in `src/` can run this early. `tests/unit/pre-paint.test.ts` executes
   this script against that module's own values and fails if the two drift, so a
   change to either side without the other cannot ship.

   WHY IT IS A FILE AND NOT AN INLINE `<script>` IN index.html — the one real
   departure from kteam, which inlined it. The pending Cloudflare Pages
   deployment (not yet in this repo; a separate unit owns it) is meant to send
   `script-src 'self'` via a `public/_headers` that does not exist here yet, so
   an inline script would be blocked outright under that policy and the app
   would boot with no theme resolved at all. A classic,
   same-origin, parser-blocking script satisfies the CSP and still runs before
   paint. It must therefore stay CLASSIC (no `type="module"`, no `defer`): a
   module script is deferred by definition and would run after first paint,
   which is the flash this file exists to prevent.

   It also stays ES5-shaped and dependency-free for the same reason kteam's did:
   it is served unbundled, straight from `public/`, so nothing transpiles it. */

(function () {
  var KEY = 'fy-theme-v1';
  var FAMILIES = ['studio', 'mission', 'neo', 'ember', 'contrast', 'notebook', 'geist'];
  var MODES = ['system', 'light', 'dark'];
  var TEXT_SCALES = { default: 1, large: 1.125, larger: 1.25 };

  var family = 'studio';
  var mode = 'system';
  var textScale = 'default';

  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var text = raw.trim();
      if (text.charAt(0) === '{') {
        // The current shape. Each field falls back on its own, so one corrupt
        // value never resets the others — `parseThemePreference` does the same.
        var parsed = JSON.parse(text);
        if (parsed && FAMILIES.indexOf(parsed.family) >= 0) family = parsed.family;
        if (parsed && MODES.indexOf(parsed.mode) >= 0) mode = parsed.mode;
        if (parsed && Object.prototype.hasOwnProperty.call(TEXT_SCALES, parsed.textScale)) {
          textScale = parsed.textScale;
        }
      } else if (MODES.indexOf(text) >= 0) {
        // A bare mode keeps the reader's mode and adopts the house family.
        mode = text;
      } else {
        // A bare resolved attribute, e.g. what `<html data-theme>` itself carries.
        var cut = text.lastIndexOf('-');
        var bareFamily = cut > 0 ? text.slice(0, cut) : '';
        var bareMode = cut > 0 ? text.slice(cut + 1) : '';
        if (FAMILIES.indexOf(bareFamily) >= 0 && (bareMode === 'light' || bareMode === 'dark')) {
          family = bareFamily;
          mode = bareMode;
        }
      }
    }
  } catch (error) {
    /* Private mode or blocked storage is an ordinary browser condition, and the
       defaults are a complete readable theme. Never let it stop boot. */
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
  // `text-size-adjust`, never root `zoom`: it scales both the tokenised and the
  // legacy pixel type without moving the CSS-pixel coordinate system the shell
  // sizes itself in. `applyTextScale` explains the full reasoning.
  var percent = TEXT_SCALES[textScale] * 100 + '%';
  root.style.setProperty('text-size-adjust', percent);
  root.style.setProperty('-webkit-text-size-adjust', percent);

  /* NO MANIFEST SWAP YET. kteam repointed its one `<link id>` manifest here so an
     install prompt fired before React mounted could not expose the wrong
     colours. Ferretry generates no manifests yet — the worker/manifest/icon
     slice is not ported (HANDOFF.md §14) — so index.html ships no manifest link
     and there is nothing to repoint. When that slice lands, mirror
     `manifestHrefFor()` here as well as in `useTheme`. */
})();
