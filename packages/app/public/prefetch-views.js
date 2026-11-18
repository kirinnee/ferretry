/* Prefetch the plugin view chunks once the page has loaded and the browser is idle, UNLESS this device asked to save data.

   The build (`scripts/prefetch-view-chunks.ts`) writes the chunk file names into this script's own tag
   (`<script defer src="/prefetch-views.js" data-chunks="a.js,b.js">`); the links are made here, at runtime, because a
   static `<link rel="prefetch">` cannot honour the reader's data settings. Nothing is fetched when the browser says
   Save-Data (`navigator.connection.saveData`), a 2g-class connection, or `prefers-reduced-data: reduce`; the views then
   load on first use, as they always did. A classic, same-origin, dependency-free script (it satisfies the page's CSP and
   nothing transpiles it); `tests/unit/prefetch-views.test.ts` runs this real file. */

(function () {
  var tag = document.currentScript;
  var list = tag && tag.getAttribute('data-chunks');
  if (!list) return;

  var connection = navigator.connection;
  if (connection) {
    if (connection.saveData === true) return;
    if (/(^|-)2g$/.test(String(connection.effectiveType || ''))) return;
  }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-data: reduce)').matches) return;
  } catch (error) {
    /* a browser that cannot answer the query is treated as not asking */
  }

  var files = list.split(',');

  function prefetch() {
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      // Only same-origin build output: a name that is not a plain chunk path is not fetched.
      if (!/^[^\s,"'<>:\\]+\.js$/.test(file) || file.indexOf('..') !== -1) continue;
      var link = document.createElement('link');
      link.rel = 'prefetch';
      link.as = 'script';
      link.crossOrigin = '';
      link.href = '/' + file;
      document.head.appendChild(link);
    }
  }

  function whenIdle() {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(prefetch, { timeout: 5000 });
    else window.setTimeout(prefetch, 2000);
  }

  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle);
})();
