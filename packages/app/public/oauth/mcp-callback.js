/* The MCP sign-in callback page's whole behaviour (docs/mcp-oauth.md).

   The provider sends the browser here with an authorization code in the address. This script hands that
   address to the Ferretry tab that started the sign-in, on a same-origin BroadcastChannel, and then wipes
   it from the address bar. When nothing answers — an installed iPhone app opens links in Safari, a private
   window — it asks the person to copy the address and paste it into the sign-in sheet instead.

   A CLASSIC SAME-ORIGIN SCRIPT, NOT INLINE AND NOT A MODULE: the site policy is `script-src 'self'` plus
   hashes with `require-trusted-types-for 'script'`, so nothing here writes HTML — every word goes in
   through `textContent`. It is served unbundled from `public/`, so nothing imports or typechecks it.

   THE CHANNEL NAME IS SPELLED TWICE. Its owner is `MCP_OAUTH_CHANNEL` in
   `src/features/fleet/components/mcp-sign-in-model.ts`; `tests/unit/mcp-callback-page.test.ts` runs this
   file against that value and fails if the two drift.

   The messages: this page posts { type: 'callback', id, href }; the tab answers { type: 'received', id }
   as soon as it takes the address, then { type: 'finished', id, ok } once the daemon answered. No answer
   repeats the address. */

(function () {
  var CHANNEL = 'ferretry-mcp-oauth';
  /** How long to wait for a Ferretry tab before asking for the address by hand. */
  var ANSWER_MS = 4000;

  var root = document.getElementById('callback');
  var title = document.getElementById('title');
  var message = document.getElementById('message');
  var copy = document.getElementById('copy');
  var note = document.getElementById('note');

  /** The address as the provider sent it, kept only in this closure once it is wiped from the bar. */
  var href = location.href;
  var query = new URLSearchParams(location.search);

  function show(state, heading, sentence) {
    root.setAttribute('data-state', state);
    title.textContent = heading;
    message.textContent = sentence;
  }

  /** Takes the code out of the address bar, history entry included. */
  function wipe() {
    try {
      history.replaceState(null, '', location.pathname);
    } catch (_) {
      // A browser that refuses still leaves a single-use code the daemon has redeemed or will refuse.
    }
  }

  if (query.has('error')) {
    wipe();
    show(
      'error',
      'Sign-in didn’t finish',
      'The provider did not finish the sign-in. Go back to Ferretry and start again.',
    );
    return;
  }
  if (!query.has('code')) {
    show('empty', 'Nothing to finish', 'This page finishes a sign-in Ferretry started. Open Ferretry to sign in.');
    return;
  }

  var answered = false;

  function askForPaste() {
    if (answered) return;
    show(
      'fallback',
      'Bring this address to Ferretry',
      'Ferretry isn’t open in this browser. Copy this page’s address and paste it into the sign-in sheet.',
    );
    copy.hidden = false;
  }

  copy.addEventListener('click', function () {
    var clipboard = navigator.clipboard;
    var copied = clipboard && typeof clipboard.writeText === 'function' ? clipboard.writeText(href) : null;
    if (copied === null) {
      note.textContent = 'Couldn’t copy. Select the address in the address bar and copy it.';
      return;
    }
    copied.then(
      function () {
        wipe();
        note.textContent = 'Copied. Paste it into the sign-in sheet in Ferretry.';
      },
      function () {
        note.textContent = 'Couldn’t copy. Select the address in the address bar and copy it.';
      },
    );
  });

  var channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  if (channel === null) {
    askForPaste();
    return;
  }
  var id = crypto.randomUUID();
  channel.onmessage = function (event) {
    var data = event.data;
    if (!data || data.id !== id) return;
    if (data.type === 'received') {
      answered = true;
      wipe();
      copy.hidden = true;
      show('received', 'Almost done', 'Ferretry has it and is finishing the sign-in.');
    } else if (data.type === 'finished') {
      answered = true;
      channel.close();
      if (data.ok === true) show('done', 'Signed in', 'You can close this tab and go back to Ferretry.');
      else
        show(
          'failed',
          'Sign-in didn’t finish',
          'Ferretry couldn’t finish the sign-in. Go back to Ferretry to see why.',
        );
    }
  };
  channel.postMessage({ type: 'callback', id: id, href: href });
  setTimeout(askForPaste, ANSWER_MS);
})();
