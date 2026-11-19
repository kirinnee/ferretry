/**
 * THE PRE-SPLIT THEME ATTRIBUTE, FOR SCENES. The theme is now three root attributes (`data-style`, `data-palette`,
 * `data-mode`), but about a hundred scene fixtures and a few visual tests still pick a look the old way: set
 * `<html data-theme="<family>-<mode>">` (`?theme=mission-dark`, `dataset.theme = …`, `setAttribute('data-theme', …)`).
 * Rewriting each of them is churn with no value, so every scene bundle starts with this banner: whenever `data-theme`
 * is written on the root it ALSO writes the three axes the family stands for (`lookOfPalette`, the same table the app and
 * the pre-paint script use). It is synchronous (an attribute set followed by a `getComputedStyle` read sees the new
 * tokens) and a no-op when the axes already say the same thing, so the real shell's own publishing is never overridden.
 *
 * Scenes only. The shipped app never loads this.
 */
import { PALETTE_IDS, lookOfPalette } from '../../../src/theme/catalog.ts';

const table = JSON.stringify(Object.fromEntries(PALETTE_IDS.map(id => [id, lookOfPalette(id)])));

export const legacyThemeBanner = `;(function () {
  if (typeof document === 'undefined') return;
  var looks = ${table};
  var root = document.documentElement;
  var set = Element.prototype.setAttribute;
  function sync(value) {
    var cut = String(value).lastIndexOf('-');
    var look = looks[String(value).slice(0, cut)];
    var mode = String(value).slice(cut + 1);
    if (look === undefined || (mode !== 'light' && mode !== 'dark')) return;
    if (root.getAttribute('data-palette') === look.palette && root.getAttribute('data-mode') === mode) return;
    set.call(root, 'data-style', look.style);
    set.call(root, 'data-palette', look.palette);
    set.call(root, 'data-mode', mode);
  }
  root.setAttribute = function (name, value) {
    set.call(this, name, value);
    if (name === 'data-theme') sync(value);
  };
  var dataset = root.dataset;
  var proxy = new Proxy(dataset, {
    set: function (target, key, value) {
      target[key] = value;
      if (key === 'theme') sync(value);
      return true;
    },
  });
  Object.defineProperty(root, 'dataset', { configurable: true, get: function () { return proxy; } });
  var initial = root.getAttribute('data-theme');
  if (initial !== null) sync(initial);
})();
`;
