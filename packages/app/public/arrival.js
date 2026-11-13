/* Early arrival: a pairing or share link's fragment leaves the address bar and the history entry BEFORE anything else
   loads. Runs before first paint and before the module graph is even fetched (shell contract S3, early half).

   WHY THIS EXISTS. `AddressTaker` (src/router/address.ts) takes every declared fragment, but it is built when
   `src/main.tsx` evaluates, which is after the whole module graph (a ~2 MB chunk) has been downloaded and parsed:
   measured on a local build, the fragment of `/pair#v1;…` sat in the address bar for ~0.5-0.7 s, through the first
   paint, where anything that reads the tab's address (an agent's browser tool, an extension, a screen share) saw a live
   one-time code. This classic, same-origin, parser-blocking script closes that window: it strips the fragment
   synchronously and leaves the value IN MEMORY ONLY, on one non-enumerable property of `window`, for `AddressTaker`
   to take once (and delete) when it is built. It is never written to the URL, history state, storage or a log, and it
   is not a global anyone can find twice: the taker removes it.

   WHAT IT TAKES, on ANY path: a pairing-shaped fragment (`#v1;…`, the one grammar a pairing or share link is written
   in, `PAIRING_FRAGMENT_PATTERN` in the access contract), because a code that landed on the wrong path (`/`, `/app/`)
   is just as live; and, on a declared `path` screen below, whatever fragment arrived there. A keyed fragment such as
   `#agenda/A3` is not a credential and waits for the module. The module decides what is HELD: only a value that arrived
   on a declared screen is held for it, anything else is dropped on arrival, never kept. A page with no taker (the
   landing page: `data-drop` on its tag) strips and drops at once.

   THIS FILE IS THE SECOND IMPLEMENTATION OF ONE CONTRACT. The definition is `AddressTaker` over each plugin's declared
   `path` fragments (`shell.fragments`, `addressPlace` in src/router/routes.ts). The script knows only the literal
   paths below and the `/app/` prefix. `tests/unit/arrival-script.test.ts` runs this very file and fails if PATHS
   drifts from what the plugins declare.

   Classic and ES5-shaped (like pre-paint.js) because it satisfies `script-src 'self'` and nothing transpiles it. */

(function () {
  var KEY = '__fyArrival';
  // Every declared `path` fragment's screen path (daemon-less, literal, no `:param`). Keep one per line.
  var PATHS = ['/join', '/pair'];
  var PAIRING_SHAPED = /^#?v1(?:;|$)/;

  try {
    var hash = window.location.hash;
    if (hash === '' || hash === '#') return;
    var parts = window.location.pathname.split('/').filter(function (part) {
      return part.length > 0;
    });
    if (parts[0] === 'app') parts.shift(); // the installed app's document is served at /app/
    var declared = false;
    for (var i = 0; i < PATHS.length && !declared; i += 1) {
      var want = PATHS[i].split('/').filter(function (part) {
        return part.length > 0;
      });
      if (parts.length < want.length) continue;
      declared = true;
      for (var j = 0; j < want.length; j += 1) {
        var got = parts[j];
        try {
          got = decodeURIComponent(got);
        } catch (decoding) {
          /* an undecodable segment never names a declared path */
          declared = false;
          break;
        }
        if (got !== want[j]) {
          declared = false;
          break;
        }
      }
    }
    if (!declared && !PAIRING_SHAPED.test(hash)) return;
    var pathname = window.location.pathname;
    // `replaceState`, not `pushState`: Back must not restore the code. The entry's own state is kept.
    window.history.replaceState(window.history.state, '', pathname + window.location.search);
    var script = window.document && window.document.currentScript;
    if (script && script.hasAttribute('data-drop')) return; // no taker on this page: stripped, and gone
    Object.defineProperty(window, KEY, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: { pathname: pathname, hash: hash },
    });
  } catch (error) {
    /* A browser that refuses replaceState leaves the module to do it later: the app still boots. */
  }
})();
