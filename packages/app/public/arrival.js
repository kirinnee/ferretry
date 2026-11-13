/* Early arrival: a pairing or share link's fragment leaves the address bar and the history entry BEFORE anything else
   on the page runs, and for as long as the page lives. It is the FIRST script of every HTML document the build emits
   (`scripts/get-started-page.ts` fails the build otherwise) and runs before first paint, before the theme script and
   before the module graph is even fetched (shell contract S3, early half).

   WHY THIS EXISTS. `AddressTaker` (src/router/address.ts) takes every declared fragment, but it is built when
   `src/main.tsx` evaluates, which is after the whole module graph (a ~2 MB chunk) has been downloaded and parsed:
   measured on a local build, the fragment of `/pair#v1;…` sat in the address bar for ~0.5-0.7 s, through the first
   paint, where anything that reads the tab's address (an agent's browser tool, an extension, a screen share) saw a live
   one-time code. This classic, same-origin, parser-blocking script closes that window: it strips the fragment
   synchronously.

   WHAT IT CANNOT DO. A classic external script must be downloaded before it can run, so the address carries the link
   from the moment the navigation commits until this file has arrived: no script of the app can shorten that, and a tool
   that reads the address at commit (or echoes the URL a caller typed) has to redact it on its own side.

   WHAT IT TAKES, on ANY path and at ANY time (the first arrival, and every later hashchange or history traversal): a
   pairing-shaped fragment (`#v1;…`, the one grammar a pairing or share link is written in, `PAIRING_FRAGMENT_PATTERN`
   in the access contract), because a code that landed on the wrong path (`/`, `/app/`) is just as live; and, on a
   declared `path` screen below, whatever fragment arrived there. A keyed fragment such as `#agenda/A3` is not a
   credential and is left for the module.

   WHAT IT KEEPS. Only a value that arrived on EXACTLY a declared screen, for the taker of that screen: the value is held
   in this closure and nowhere else (never in the URL, history state, storage or a log, and on no property of `window`).
   Everything else (a path beneath a screen, an undeclared path, a page with no taker, marked `data-drop` on its tag) is
   stripped and DROPPED on the spot.

   THE HAND-OFF. `window.__fyArrival` is one non-enumerable function, which `AddressTaker` calls once when it is built:
   it returns what is held, with what is left of its two minutes (the hold runs from the ARRIVAL, not from the module's
   boot), and removes itself and the value. A second call, or a call after the deadline, finds nothing. The value is
   removed at its deadline even if no one ever asks. The trusted consumer boundary is the document's own first-party
   code: `script-src 'self'` and Trusted Types allow no other script to run, so the one caller is the shell. The
   function is take-once, not secret from a script that already runs on this origin: an XSS could call it first. That
   is the same code that could read the address earlier, and is the boundary the whole app already has.
   Once the taker has taken the hand-off it owns the page: a later arrival on a declared screen is left for its own
   hashchange listener, and only the credential-shaped strays are still dropped here.

   THIS FILE IS THE SECOND IMPLEMENTATION OF ONE CONTRACT. The definition is `AddressTaker` over each plugin's declared
   `path` fragments (`shell.fragments`, `addressPlace` in src/router/routes.ts). The script knows only the literal
   paths below and the `/app/` prefix. `tests/unit/arrival-script.test.ts` runs this very file and fails if PATHS or the
   credential shape drift from what the plugins and the access contract declare.

   Classic and ES5-shaped (like pre-paint.js) because it satisfies `script-src 'self'` and nothing transpiles it. */

(function () {
  var KEY = '__fyArrival';
  // Every declared `path` fragment's screen path (daemon-less, literal, no `:param`). Keep one per line.
  var PATHS = ['/join', '/pair'];
  var PAIRING_SHAPED = /^#?v1(?:;|$)/;
  var HELD_FOR_MS = 120000; // `HELD_FOR_MS` in src/router/address.ts

  var script = window.document && window.document.currentScript;
  var dropOnly = !!(script && script.hasAttribute('data-drop')); // a page with no taker: nothing is ever held
  var held; // { pathname, hash, at }: the one value that waits, closure only
  var owned = false; // the taker has taken the hand-off

  function segmentsOf(path) {
    return path.split('/').filter(function (part) {
      return part.length > 0;
    });
  }

  /** 'at' a declared screen, 'beneath' one, or 'elsewhere' (the same three places `addressPlace` tells apart). */
  function placeOf(pathname) {
    var parts = segmentsOf(pathname);
    if (parts[0] === 'app') parts.shift(); // the installed app's document is served at /app/
    for (var i = 0; i < PATHS.length; i += 1) {
      var want = segmentsOf(PATHS[i]);
      if (parts.length < want.length) continue;
      var same = true;
      for (var j = 0; j < want.length && same; j += 1) {
        try {
          same = decodeURIComponent(parts[j]) === want[j];
        } catch (decoding) {
          same = false; // an undecodable segment never names a declared path
        }
      }
      if (same) return parts.length === want.length ? 'at' : 'beneath';
    }
    return 'elsewhere';
  }

  function keep(pathname, hash) {
    var mine = { pathname: pathname, hash: hash, at: Date.now() };
    held = mine;
    setTimeout(function () {
      if (held === mine) held = undefined; // unclaimed by its deadline: gone
    }, HELD_FOR_MS);
  }

  function take() {
    owned = true;
    try {
      delete window[KEY];
    } catch (error) {
      /* a frozen window leaves the function, which now returns nothing */
    }
    var mine = held;
    held = undefined;
    if (mine === undefined) return undefined;
    // The clock, not the timer: a background tab can hold a timer back past the deadline.
    var remainingMs = HELD_FOR_MS - (Date.now() - mine.at);
    return remainingMs > 0 ? { pathname: mine.pathname, hash: mine.hash, remainingMs: remainingMs } : undefined;
  }

  /** The address as it is now: a credential leaves it, and is kept only if its own screen is there to take it. */
  function arrive() {
    try {
      var hash = window.location.hash;
      if (hash === '' || hash === '#') return;
      var pathname = window.location.pathname;
      var place = placeOf(pathname);
      if (place === 'elsewhere' && !PAIRING_SHAPED.test(hash)) return;
      if (owned && !dropOnly && place === 'at') return; // the taker's own hashchange listener has it
      // `replaceState`, not `pushState`: Back must not restore the code. The entry's own state is kept.
      window.history.replaceState(window.history.state, '', pathname + window.location.search);
      if (place === 'at' && !dropOnly && !owned) keep(pathname, hash);
    } catch (error) {
      /* A browser that refuses replaceState leaves the module to do it later: the app still boots. */
    }
  }

  try {
    if (!dropOnly)
      Object.defineProperty(window, KEY, { configurable: true, enumerable: false, writable: false, value: take });
  } catch (error) {
    /* no hand-off: the taker strips what it finds when the module boots */
  }
  arrive();
  // A later arrival in this document (a fragment navigation, a history traversal) is the same case as the first.
  window.addEventListener('hashchange', arrive);
  window.addEventListener('popstate', arrive);
})();
