# One broken-into machine, and the others

If one machine you paired is broken into, what can it do to your OTHER machines, and to the phone
that reaches all of them? This page answers that, path by path, and says which paths are closed, how,
and what is still open. Section numbers are stable: code comments cite them (`docs/cross-daemon.md §4b`).

**Short answer.** A broken-into machine **A** cannot sign in to machine **B** as your phone, cannot
use your passkey at B, and cannot overwrite B's key or B's record on the phone. The two real openings
were **Clone** (copying A's setup onto B copied commands nobody could see) and **push notifications**
(one shared subscription made the first machine the only voice for every machine's alerts). Both are
now closed as far as the browser allows; what remains is listed under each. The reader-facing
summary is [security.md](security.md).

## 1. Proofs and passkeys — closed by design

- **1a.** Each machine has its own non-extractable device key on the phone, filed under the daemon id
  the pairing QR proved. Every proof signs the handshake transcript, which names that daemon, so a
  proof made for A's session is worthless at B. See [relay-protocol.md](relay-protocol.md) §2.
- **1b/1c.** A step-up at B answers a challenge only B issued, inside B's sealed session; a passkey
  prompt never lists every passkey. A cannot get or replay one.

## 2. Script in the app

- **2a. Daemon data → script: no path found.** CSP `script-src 'self'` with two fixed hashes (plus
  `'wasm-unsafe-eval'`, which lets WebAssembly compile for on-device dictation and enables no `eval` —
  [voice.md](voice.md)), markdown without raw HTML, highlighter-only `innerHTML`, sandboxed `fy-render` frames. The
  in-page `fy-render` renderers (`map`, `chart`) take author DATA only, through a closed reader, and their
  bundled libraries hold no markup, eval or network sink — `chart` adds no CSP source, `_headers` line or
  Trusted Types policy ([fy-render.md § Charts](fy-render.md#charts)).
- **2b. Trusted Types — closed (Chromium).** `public/_headers` now says
  `require-trusted-types-for 'script'; trusted-types fy-highlight fy-worker fy-fragment`. Chromium refuses a
  plain string at every script sink, and only three policies may exist (`src/lib/trusted-types.ts`):
  `fy-highlight` accepts only highlight.js's own `<span class="…">` markup, `fy-worker` accepts only
  the app's own signed worker URL and its own hashed speech worker (`/assets/parakeet-worker-<hash>.js`),
  and `fy-fragment` is DOMPurify's parsing policy for an `fy-render` html fragment and nothing else — its
  output is sanitized DOM appended into a closed shadow root, never a string at a live sink
  ([fy-render.md](fy-render.md)). The harness gallery runs under the same directives and fails on any
  violation; `tests/integration/release-worker.test.ts` proves the installed page enforces them.
  Safari and Firefox ignore the directive, and the same checks run on plain strings there.
- **2c. If script DID run, it reaches every machine — open by design.** The app's origin is shared by
  every machine you paired. This is the declared "code running in the open app" limit.

## 3. Clone from another machine

- **3a. Copying runs commands on the target — closed.** MCP servers, hooks and settings start programs
  the next time an agent launches; instructions and skills are text an agent follows, and one running
  unattended (Agent permissions **skip**) will act on them, scripts included. The Clone preview lists
  every one of them in words — each MCP command line and variable, each launch flag, each runnable
  settings key, each hook command, and every carried hook script, settings file, instructions file and
  skill file in full — with a box to leave any component out. Nothing is hidden, because the source
  chose every name. The target's own description (`describeClone`, which the CLI prints before it asks)
  lists the same things from the same function (`cloneRunnables` in `@ferretry/protocol`).
  `fy machine clone` asks first whenever a copy brings any of these, and `--skip <component>` leaves
  one out. Applying still needs the target's own step-up.
- **3a′. Nothing written that the review did not list — refused.** The review and the write must agree
  on which carried file belongs to which component, so both read one rule (`cloneFileOwned`), and the
  target refuses a bundle a byte-for-byte match could misread (`cloneBundleProblem`): a path spelled
  two ways (`./x`, `a//b`, `a/./b`, a trailing `/`) that the provisioner would normalise into one, the
  same path twice, a component reference spelled two ways, or a file **no carried component owns** —
  which would otherwise overwrite one of the target's own hooks while the review listed nothing. The
  app shows the refusal instead of offering Copy. An honest export writes every path one plain way.
- **3b. Paths outside the setup folder — refused early.** A bundle carrying an absolute, `~`, `$`,
  `..` or backslashed file path is refused by name before anything is planned. The provisioner's own
  containment check stays the last line.
- **3c. Provenance — recorded.** Everything a clone copies carries `clonedFrom` (the name the source
  gave itself) and `clonedFromDaemon` (the daemon id the copying browser paired with, **as that browser
  reported it** — the target cannot check it, so it is as true as the browser that staged the copy).
  Components show "Copied from ‹your label for that machine›", or "‹name› (the name it gave itself)"
  when this browser does not know the id. A clone through the CLI has no browser, so it records the
  name only.
- **Bounded.** A settings or hooks document too deep or too large to walk key by key (64 levels, 2,000
  values) is said to be so and shown whole; the walk never recurses.
- **3d. Copying B into A shows B's setup to A — said out loud.** The Clone source step now says the
  target receives the source's instructions, skills, settings and hooks. Logins and secret values
  never travel.

## 4. Push notifications

- **4a. A notification can only open this site — tested.** `notificationUrl` in
  `src/lib/push-scope.ts`; `tests/unit/push-scope.test.ts`.
- **4b. One subscription per machine — closed.** A browser holds one push subscription per
  service-worker registration, bound to the VAPID key of the daemon that made it. Each paired machine
  now has its OWN registration of the same signed `sw.verified.js`, at `/push/<daemonId>/`, so each
  subscription carries that machine's key and no other machine can deliver into it. Turning one
  machine off removes only its registration. **At app start** every paired machine is moved off the old
  shared subscription — enrolled on its own registration when its notifications are on, its old device
  revoked when they are off — and the shared subscription is then dropped **whatever happened**, so a
  failed move-over cannot keep the old voice alive. Unpairing a machine removes its push worker;
  renaming it re-labels it. Each push worker's script is audited against the signed release
  ([pwa-release-signing.md](pwa-release-signing.md)); the audit reads the file without its `?machine=`
  query, and a push worker registered while the tab stays visible is first audited the next time the
  tab becomes visible.
- **4c. Spoofed text and deep links — confined.** A machine's worker learns which machine it serves
  from its own registration scope, which the page chose. It prefixes every title with your label for
  that machine — or, unlabelled, the start of its daemon id, never the address it chose in its own QR —
  keeps every tag in that machine's namespace (so one machine cannot replace another's notification),
  and opens only that machine's own pages. A push that still reaches the app-wide registration (the old
  shared subscription, before start-up drops it) is titled **Unverified**, kept out of every machine's
  tags, and opens only the app. A machine can still write any words after its own name.
- **Not shown here:** that each subscription really is refused by the push service for a foreign
  VAPID key needs a real push service; the Chromium tests deliver pushes over DevTools instead.

## 5. Shared storage on the phone — closed

Device keys, connection records, push device ids, step-up state and caches are all keyed by the
verified daemon id. The push subscription was the one shared entry, and is no longer shared (4b).

## What is still open

| Path                                                                                            | Owner / state                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| 2c Script in the app reaches every machine                                                      | declared limit                       |
| 2d Step-up prompt names the machine but not the act                                             | closed by the passkeys change (#464) |
| No `fy device revoke` at the machine                                                            | closed by the passkeys change (#464) |
| 3c through the CLI records the source's own name only                                           | no browser to verify it              |
| 4c A machine chooses the words after its own name                                               | inherent: the daemon writes the body |
| 4b A push worker re-registered while visible waits for the next visibility change to be audited | declared                             |
