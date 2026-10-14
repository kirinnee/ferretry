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

- **2a. Daemon data → script: no path found.** CSP `script-src 'self'` with two fixed hashes,
  markdown without raw HTML, highlighter-only `innerHTML`, sandboxed `fy-render` frames.
- **2b. Trusted Types — closed (Chromium).** `public/_headers` now says
  `require-trusted-types-for 'script'; trusted-types fy-highlight fy-worker`. Chromium refuses a plain
  string at every script sink, and only two policies may exist (`src/lib/trusted-types.ts`):
  `fy-highlight` accepts only highlight.js's own `<span class="…">` markup, and `fy-worker` accepts only
  the app's own signed worker URL. The harness gallery runs under the same directives and fails on any
  violation; `tests/integration/release-worker.test.ts` proves the installed page enforces them.
  Safari and Firefox ignore the directive, and the same checks run on plain strings there.
- **2c. If script DID run, it reaches every machine — open by design.** The app's origin is shared by
  every machine you paired. This is the declared "code running in the open app" limit.

## 3. Clone from another machine

- **3a. Copying runs commands on the target — closed.** MCP servers, hooks and settings start programs
  the next time an agent launches. The Clone preview now lists every one of them in words — each MCP
  command line and variable, each launch flag, each runnable settings key, each hook command, and every
  hook script and settings file in full — with a box to leave any component out. Nothing is hidden,
  because the source chose every name. The target's own description (`describeClone`, which the CLI
  prints before it asks) lists the same things from the same function (`cloneRunnables` in
  `@ferretry/protocol`). `fy machine clone` always asks first when a copy brings a command, and
  `--skip <component>` leaves one out. Applying still needs the target's own step-up.
- **3b. Paths outside the setup folder — refused early.** A bundle carrying an absolute, `~`, `$`,
  `..` or backslashed file path is refused by name before anything is planned. The provisioner's own
  containment check stays the last line.
- **3c. Provenance — recorded.** Everything a clone copies carries `clonedFrom` (the name the source
  gave itself) and `clonedFromDaemon` (the daemon id the copying browser paired with). Components show
  "Copied from ‹your label for that machine›", or "‹name› (the name it gave itself)" when this browser
  does not know the id. A clone through the CLI has no browser, so it records the name only.
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
  machine off removes only its registration. The old shared subscription is dropped the first time any
  machine moves over, and the device id it was enrolled under is revoked at that machine. Unpairing a
  machine removes its push worker; renaming it re-labels it. Each push worker is still audited against
  the signed release ([pwa-release-signing.md](pwa-release-signing.md)).
- **4c. Spoofed text and deep links — confined.** A machine's worker learns which machine it serves
  from its own registration scope, which the page chose. It prefixes every title with your label for
  that machine, keeps every tag in that machine's namespace (so one machine cannot replace another's
  notification), and opens only that machine's own pages. A machine can still write any words after
  its own name.
- **Not shown here:** that each subscription really is refused by the push service for a foreign
  VAPID key needs a real push service; the Chromium tests deliver pushes over DevTools instead.

## 5. Shared storage on the phone — closed

Device keys, connection records, push device ids, step-up state and caches are all keyed by the
verified daemon id. The push subscription was the one shared entry, and is no longer shared (4b).

## What is still open

| Path                                                  | Owner / state                        |
| ----------------------------------------------------- | ------------------------------------ |
| 2c Script in the app reaches every machine            | declared limit                       |
| 2d Step-up prompt names the machine but not the act   | the passkeys change (PR #464)        |
| No `fy device revoke` at the machine                  | the passkeys change (PR #464)        |
| 3c through the CLI records the source's own name only | no browser to verify it              |
| 4c A machine chooses the words after its own name     | inherent: the daemon writes the body |
