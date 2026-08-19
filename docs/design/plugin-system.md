---
id: plugin-system
title: Can a capability and its user interface be a plugin?
---

# Can a capability and its user interface be a plugin?

**Status: PROPOSED. Nothing here is built, and this document changes no production code.**
**Verified against `origin/main` at `635cf559` (`Brew cask update for ferretry version v3.0.0`).**
Every claim about current behaviour below cites a file and line at that commit.

It answers the owner's request:

> i want users to be able to add things to the UI to visualize things (they can add capabilities).
> for example, we have browser and terminal features. i want these to be plugins. or kanban board, or
> if they want graph or loop engineering etc, it can all be added in! UI changes and stuff too

So a plugin is **a capability AND its user interface**, not one or the other. That framing is right,
and it is also why the two halves get different answers.

---

## 0. The part that cannot be done safely, first

**A plugin cannot ship its own JavaScript into this product's user interface. Not in the app's
origin, not in a sandboxed frame, not with any browser-side mitigation that exists. This is not a
schedule problem and not a design gap — `fy-render` already ran the experiment and refused to ship
the result.**

`docs/fy-render.md:588-604` is the measurement, and it is the single most important input to this
document:

> Three independent probes established that a browser-only boundary does not exist: in the required
> opaque-origin `sandbox="allow-scripts"` frame, hostile script performed a real self-navigation that
> an external beacon server received; `<link rel="prerender">` produced a real TCP connection and HTTP
> GET under `default-src 'none'`; and `RTCPeerConnection` sent real STUN and TURN UDP under
> `connect-src 'none'`, with Chromium 150 rejecting the proposed `webrtc 'block'` directive as
> unrecognised. — `docs/fy-render.md:590-596`

Read what that means for a plugin panel. The frame shape everyone reaches for — opaque origin, no
`allow-same-origin`, `default-src 'none'` — **does not stop code inside it from talking to the
internet.** It stops `fetch`, `XMLHttpRequest`, `WebSocket`, workers and subresources
(`docs/fy-render.md:171-181`); it does not stop navigation, prerender or WebRTC, because CSP's fetch
directives do not govern those. A plugin panel is by definition shown data the reader is looking at.
So an author-code plugin panel is a **proven** exfiltration channel for whatever the panel is
allowed to see, and the mitigation that would close it (`allow-same-origin`) destroys the boundary it
was meant to protect (`docs/fy-render.md:596-598`).

`fy-render`'s answer was to ship `type: html` **as escaped text that does not execute**
(`docs/fy-render.md:588`), and to run only **trusted code over untrusted data** — Mermaid and Lottie
are libraries Ferretry ships and pins by SHA-256, fed author bytes as input
(`docs/fy-render.md:182-188`). That distinction is the whole design, and it is stated in the
component itself: _"interprets bounded, untrusted DATA inside an opaque-origin frame … a genuinely
different claim from 'author JavaScript is sandboxed'"_ — `packages/pwa/src/components/fy-render-sandbox.tsx:5-8`.

**So the brief's premise that "the UI half is largely solved by `fy-render`" is half right, and the
half it gets wrong is the important half.** `fy-render` solved _rendering untrusted data_. A plugin
that "adds things to the UI" is untrusted _code_. Those are not the same box.

There is a second, independent reason, and it would bite even if the first were solved. The
`fy-render` shell is not something the parent constructs at runtime — it is a **static file in the
deployed bundle at a fixed path** (`/fy-render-sandbox.html`,
`packages/pwa/src/components/fy-render-sandbox.tsx:76-83`) with its own headers block in
`packages/pwa/public/_headers:9-21`, including a load-bearing `!` line that removes the site-wide
policy, and a validate gate that pins those four header lines exactly
(`scripts/validate/pages-config.sh:63-66`). A plugin's bytes are not in the deployment and cannot get
their own headers block. The boundary is a **build-time artefact**, and a plugin arrives after the
build.

**What this leaves, and it is a real product:** a plugin's user interface is a **view document** —
data — rendered by components Ferretry ships. The plugin decides _what_ is on screen; Ferretry decides
_how_ anything can be drawn at all. §5 prices that honestly, including what it costs: **a plugin can
never draw something the PWA does not already know how to draw**, so "add a kanban board" means
Ferretry ships a board primitive and a plugin fills it, not that a plugin brings a board.

The backend half is the opposite story. It is achievable, it follows a pattern that already exists in
this daemon, and §3 recommends it without reservation.

---

## 1. The acceptance test: `terminal` and `browser` as plugins

The owner named these two, so reimplementing them is the honest proof. Both are read below as they
exist, not as they might be factored.

### 1.1 What each one actually is

**`terminal` — seven route declarations, all in one mount.**
`rg -c --fixed-strings "capability: 'terminal'" packages/daemon/src/lib/runtime/mounts/*.ts` returns
exactly one file with seven hits: `terminals.ts`. Five HTTP routes over
`/v1/sessions/:sessionId/terminals` (`terminals.ts:212-247`), a stream ticket (`:268-269`) and the
stream itself (`:311-312`).

**`browser` — eight, likewise in one mount.** `browser-login.ts`: four session-scoped actions
(`:147-178`), a stream ticket (`:188-189`), the host login window (`:212-221`), and a socket route
(`:236-237`).

That is the encouraging half: **the daemon-side authority surface of both capabilities is already
namespaced, already declarative, and already sits behind one enforcement point** — a route names its
capability and the dispatcher asks the operator's grant, failing closed if a route names one and no
guard is wired (`packages/daemon/src/lib/api/dispatcher.ts:168-175`).

### 1.2 Part by part, and whether it survives the move

| part                                         | where                                                                                 | survives as a plugin?                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| the seven/eight route declarations           | `terminals.ts:212-312`, `browser-login.ts:147-237`                                    | **yes**, re-hosted under one namespaced prefix — §6.2            |
| the capability demand on each                | same lines                                                                            | **yes**, but as a consumed capability, not a new member — §4     |
| the out-of-process worker                    | `packages/daemon/bin/browser-worker.ts:1-11`                                          | **yes** — it is already exactly the plugin shape, §3             |
| the worker transport (JSON lines, stdio)     | `adapters/browser/transport/worker-client.ts:25-30`                                   | **yes** — this becomes the plugin ABI                            |
| the tmux process adapter                     | `packages/daemon/src/adapters/tmux/`                                                  | **yes**, it is an implementation detail of the plugin            |
| terminal ownership / stream / runtime policy | `packages/daemon/src/lib/terminal/{ownership,policy,runtime-policy,stream-policy}.ts` | **yes**                                                          |
| the WebSocket stream, both of them           | `terminals.ts:311-312`, `browser-login.ts:236-237`                                    | **not today** — §6.2; the route table's socket half is separate  |
| secret redaction of a screen read            | `docs/secrets.md:48-56`                                                               | **only if the bytes pass through the daemon** — §3.3             |
| the side-pane instance tab                   | `packages/pwa/src/shell/side-pane-tab-model.ts:74`                                    | **no** — `SidePaneInstanceKind` is a closed union of three       |
| the tab icon                                 | `side-pane-tab-model.ts:176`, `side-pane-tab-icons.ts:24`                             | **no** — a closed `Record` of Lucide components                  |
| `%terminal:<key>` / `%browser:<key>`         | `docs/reference-standard.md:52-53`, `:102-103`                                        | **no** — the reference grammar is closed and extended in code    |
| the operator-facing capability sentences     | `packages/pwa/src/lib/grants.ts:57`, `:69`, `:88`                                     | **no** — `Record<DaemonCapability, string>`, written by a person |
| the panel itself (deck, surface, snapshot)   | `packages/pwa/src/components/session-terminal-{deck,surface}.tsx`                     | **as a view document only** — §5                                 |
| the release packaging of the worker          | `scripts/release/compile.sh:12`                                                       | **no, and it does not survive today either** — §1.4              |

### 1.3 The finding: what fails is never the capability

Read that table again by its "no" rows. **Not one of them is the capability.** Every one is a place
where the capability had to take out a membership in a **closed set owned by a different subsystem**:

1. `DaemonCapability` — six members, a compile-time literal
   (`packages/protocol/src/lib/grants.ts:99`), mirrored into the daemon's configuration schema by a
   mapped type over the same array (`:132`), and independently compared in both directions by
   `scripts/validate/closed-set-agreement.ts`.
2. `SidePaneInstanceKind` — `'file' | 'browser' | 'terminal'` (`side-pane-tab-model.ts:74`).
3. `SidePaneTabIconName` — a `Record` mapping each name to an imported Lucide component
   (`side-pane-tab-icons.ts:24`); the icons are in the bundle.
4. The reference grammar — `%terminal:` and `%browser:` are rows in a table, and adding a kind is a
   four-step code change _"in one place, not forked"_ (`docs/reference-standard.md:241-252`).
5. The operator-facing sentences — three `Record<DaemonCapability, string>` maps of English prose
   (`packages/pwa/src/lib/grants.ts:57`, `:69`, `:88`).

**So "make `terminal` a plugin" is not one project. It is one easy project (move seven routes and a
tmux adapter behind a namespace) and five hard ones (open five closed sets, each of which is closed
on purpose).** A design that only does the first and calls it a plugin system produces a plugin that
cannot appear in the tab strip, cannot be referenced from the composer, cannot be described to an
operator in the grants screen, and cannot be switched off by name.

That is the real content of the acceptance test, and it is why §4 recommends opening **exactly one**
of the five and §5 recommends going through the other four rather than around them.

### 1.4 One thing the acceptance test found that is not about plugins

`packages/daemon/package.json` declares two binaries — `fyd` and `fyd-browser-worker`. The release
compiles one: `scripts/release/compile.sh:12` reads `.bin | to_entries[0].value`. The daemon looks
for a compiled sibling and, not finding one, falls back to running `bin/browser-worker.ts` through
Bun (`packages/daemon/bin/fyd.ts:3801-3809`).

**So the product's one existing out-of-process capability child is not packaged by the release
pipeline.** Stated here because §7 is about distributing plugin executables, and it would be
dishonest to argue from a packaging precedent that does not exist. It is a defect in its own right,
it is not caused by anything proposed here, and it is not this document's to fix.

---

## 2. What a plugin is

**All three — manifest, process, view — and the minimal one is a manifest plus a process.**

| piece        | required? | what it is                                                                                                         |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------------ |
| **manifest** | always    | a JSON document: id, name, ABI major, the capabilities it consumes, its actions, and whether it contributes a view |
| **process**  | usually   | an executable the daemon spawns and speaks a line protocol to                                                      |
| **view**     | optional  | a declaration of surfaces (a side-pane tab, a session panel) plus, at runtime, view documents                      |

Three shapes fall out, and naming them is what stops "plugin" meaning four things in one conversation:

- **A capability plugin** — manifest and process, no view. Reachable by an agent and by `fy`. This is
  the minimal plugin and the one with no unsolved problems in it.
- **A view plugin** — manifest and view, no process. Draws from data the daemon already has. Cheapest
  to ship and the one most of the owner's examples (kanban board, graph) actually are.
- **A full plugin** — all three. `terminal` and `browser` are this shape.

**A manifest alone is not a plugin.** It declares intent with nothing behind it, and a surface that
appears and then does nothing is worse than an absent one. The daemon refuses it.

---

## 3. The backend half: out of process, and in-process is not arguable

### 3.1 In-process deletes the secret store's only real property

An in-process plugin runs **as the daemon**, inside its object graph. `packages/daemon/src/lib/secrets/vault.ts:1-14`
is explicit that the security property is a **type**, not a check:

> `SecretDirectory` is what a ROUTE is handed. It can list, replace and delete. It has no method that
> returns a value and no field it could reach one through, so "there is no API that returns a secret"
> is a fact about the type rather than a rule a reviewer has to check. … If a future change needs a
> vault somewhere else, that is the moment to re-derive the whole property; adding a getter here
> quietly deletes it. — `secrets/vault.ts:6-8`, `:13-14`

An in-process plugin does not need a getter. It **is** somewhere else, and it can reach `SecretVault`
directly because it shares the runtime. `docs/secrets.md:39-42` says a getter added "just for
testing" would delete the whole property; an in-process plugin API deletes it without adding
anything. It also walks past redaction (`docs/secrets.md:48-56`), past any future per-child resource
limit, and past every possibility of the daemon surviving the plugin crashing.

**There is no in-process design that keeps the secret property. Recommend out-of-process, and treat
this as settled rather than as a trade-off with two sides.**

### 3.2 The pattern already exists, and it is small

`packages/daemon/bin/browser-worker.ts` is a separate program the daemon spawns and speaks
newline-delimited JSON to. Its client is
`packages/daemon/src/adapters/browser/transport/worker-client.ts`, and two of its properties are
exactly what a plugin host needs:

- **A bounded environment.** _"Only the variables a browser needs; nothing else about this host leaks
  into the child"_ — `worker-client.ts:29`, six variables at `:30`. A plugin child gets the same
  treatment and no more.
- **Bounded time.** 15s to become ready, 60s per request, 2s to shut down (`worker-client.ts:25-27`).

Generalise those into a plugin host: one subsystem, wired once at the composition root, that reads
manifests, spawns children, and speaks one versioned line protocol.

### 3.3 What a plugin gets to call, and why secrets are structurally out of reach

**A plugin is a callee, not a caller.** This is the whole mechanism, and it is what makes "can it
touch secrets" answerable with something better than a rule:

- The plugin child is handed **no admin token, no device token, no `FY_HOME`, and no daemon URL** —
  the same treatment `worker-client.ts:29-30` gives the browser worker. It therefore cannot dial
  `/v1/...` at all. There is no credential to narrow, no route to reach, and no grant to
  misconfigure.
- Its **only** channel is the stdio line protocol, whose message set the daemon defines. Secrets are
  absent from that set the way they are absent from `SecretDirectory`: there is no verb, so there is
  nothing to disallow.
- **A plugin never receives a secret value, and it does not need one.** The product already has the
  answer: a plugin asks the daemon to run a command _with_ a named secret, and the value lands in a
  grandchild's environment, exactly as `fy secret use` does today (`docs/secrets.md:34-36`). The
  plugin holds the **name**. That is the same shape an agent gets, and for the same reason.

**The honest residual:** a plugin runs as the user, on the user's machine. It can read
`<FY_HOME>/state/secrets.json` and `secrets.key` off the disk if nothing stops it, and
`docs/secrets.md:82-86` already says that of any process running as your user. **The line protocol
buys the same thing `sudo` buys** — it stops the plugin _interface_ from being a way to read secrets;
it is not a sandbox, and §9 does not pretend otherwise.

### 3.4 Supervision: say what is true, which is that there is none

The brief asks that a plugin process be supervised by the warden. **It cannot be today, and claiming
otherwise would be the most misleading sentence in this document.**

The warden's subject is agent sessions: it produces reports, blesses or refuses to bless, and can
trigger failover (`packages/daemon/src/lib/warden/sweep.ts:1-16`). It has no notion of a daemon child
that is not a session, and the browser worker — the only such child today — is not supervised by it
either. What bounds the browser worker is three timeouts in its transport
(`worker-client.ts:25-27`), which is a **transport bound, not supervision**.

Resource limits are a separate mechanism again, and a narrower one than its name suggests:
`packages/daemon/src/lib/cgroups/config.ts:1-25` describes limits that are **off by default**, apply
to _"every managed agent"_ launched through one composition seam, and exist only where the Linux
unified hierarchy and a reachable user manager do. On macOS there is nothing.

So the honest position, and the one §10's decision includes:

- **v1: the plugin host owns plugin lifecycle** — spawn, timeouts, restart budget, kill — modelled on
  `worker-client.ts` and stated as such. Not the warden.
- **A plugin process is not resource-bounded on any platform, and is not resource-bounded on Linux
  either unless someone extends the cgroup seam to a second kind of child.** Write that down at the
  install surface, not in a document.

---

## 4. Capabilities: one new member, never one per plugin

### 4.1 Per-plugin capabilities are not representable, and that is a feature

`DAEMON_CAPABILITIES` is a literal array of six strings (`packages/protocol/src/lib/grants.ts:99`).
The daemon's configuration schema is derived from it by a mapped type (`:132`), a validate gate
compares the two shapes in both directions and rejects duplicates
(`scripts/validate/closed-set-agreement.ts:14`), and the PWA carries three `Record<DaemonCapability, string>`
maps of operator-facing English (`packages/pwa/src/lib/grants.ts:57`, `:69`, `:88`).

A capability per plugin would need every one of those to be dynamic — including the English. And the
English is the part that cannot be automated: `capabilityReach` promises _"what each capability
actually reaches, in one line"_ (`packages/pwa/src/lib/grants.ts:81-88`), written by somebody who
verified it. A plugin author's own description of their plugin's reach is marketing copy in a
security surface.

**Recommendation: exactly one new member, `plugin`, with the standard two axes.**

| axis               | governs                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `plugin.use`       | may a caller who is not on this host invoke any plugin action at all? |
| `plugin.configure` | may they enable, disable or reconfigure plugins on this host?         |

Installing is deliberately absent from that table. See §7.

### 4.2 A plugin's own authority is borrowed, never granted

The brief is right that a third authority mechanism is the mistake to avoid. So:

**A plugin declares which existing capabilities it consumes, and every call it makes is decided by
the operator's existing grants for those capabilities, against the credential of the caller who
invoked it.** A plugin that wants to open a terminal consumes `terminal.use`; if the operator has
switched `terminal` off for remote callers, the plugin's terminal action is refused for a remote
caller, in the same words, from the same decision — and the refusal already names the remedy
(`docs/grants.md:365-373`).

Two invariants that fall straight out of the existing model and must be stated rather than assumed:

- **A plugin can never hold more than the caller who invoked it.** The grant layer _"only ever
  narrows"_ (`docs/grants.md:328-333`), and a plugin call is one more thing inside a request that has
  already passed authentication, the route's credential minimum and the operator's grant.
- **A plugin's declared consumption can only narrow further.** A manifest that names nothing gets
  nothing; a manifest that names `terminal` still gets whatever the operator's `terminal` grant says
  on the day of the call, which may be less.

### 4.3 Answering `docs/grants.md`'s "before you add capability seven"

`docs/grants.md:176-181` sets three questions for any new capability. They are load-bearing and this
is the answer:

1. **What does somebody reach for this switch to STOP?** A plugin doing something they did not
   expect, from a device they no longer trust.
2. **Does switching it off also stop the thing that undoes it?** **Yes, and this is the trap.** If
   disabling a bad plugin runs through `plugin.configure`, then switching `plugin` off from a phone
   also switches off the ability to disable the individual plugin that was the actual problem —
   precisely the shape `pairing` hit (`docs/grants.md:163-168`), where the coarse switch disables the
   remedy.
3. **So where does the way back go?** On the control. The remote turn-off warning for `plugin` must
   carry _"disable that plugin FIRST"_, from `COARSE_SWITCH_ALSO_STOPS` in
   `packages/pwa/src/lib/grants.ts:146-171`, which already exists for exactly this and is keyed per
   capability _"because the next capability whose switch disables its own remedy needs its own
   sentence and no generic wording could carry it"_ (`packages/pwa/src/lib/grants.ts:154-155`).

And yes to the brief's question 2: it appears in "What devices may do" like every other capability,
because it **is** one — one row, two switches, the same sentences, the same one-way widen rule
(`docs/grants.md:304-313`). What it does **not** get is a row per plugin.

---

## 5. The UI half

### 5.1 The three shapes, priced

| shape                                                 | verdict                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. plugin-authored code in a sandboxed frame**      | **Refused.** Proven egress under `default-src 'none'` (`docs/fy-render.md:590-596`); the fix needs `allow-same-origin`, which destroys the boundary (`:596-598`). And the shell must be a static deployed file with its own pinned headers (`_headers:9-21`, `pages-config.sh:63-66`), which plugin bytes cannot be.                                                                                      |
| **B. a cross-origin iframe pointed at the daemon**    | **Refused, for a product reason as well.** Over the relay the PWA does not dial the daemon: the URL is _"read apart into a §14 record by `relay-carrier.ts`"_ rather than fetched (`packages/pwa/src/lib/daemon-transport.ts:5-9`). A browser-issued `iframe src` bypasses that transport entirely, so a plugin panel would work on the laptop and be blank on the phone — the case the relay exists for. |
| **C. a view document rendered by shipped components** | **Recommended.** Same relationship `fy-render` has with Mermaid: trusted renderer, untrusted data (`fy-render-sandbox.tsx:5-8`).                                                                                                                                                                                                                                                                          |

### 5.2 What shape C is, and what it costs

A plugin returns a **view document** — a validated tree of primitives Ferretry ships: a list, a
board, a table, a form, a chart, a text block, an action. The PWA parses it at the boundary like
every other wire document and renders it with its own components, its own theme, its own touch
targets and its own accessibility.

- **The plugin ships no code to the browser.** Nothing to sandbox, nothing to pin, no new CSP block,
  no new deployed file, no new gate.
- **It works identically over the relay**, because a view document is an API response like any other
  and rides the same §14 translation as everything else.
- **The cost, stated plainly: a plugin can only draw what the renderer can express.** "Add a kanban
  board" means Ferretry ships a board primitive; the plugin supplies columns and cards. A plugin that
  wants a visualisation nobody anticipated is stuck until Ferretry ships the primitive. **That is a
  real limitation and it is the price of §0.**

**Answering the brief's question 3 — what can it see of the app? Nothing.** There is no plugin code in
the browser to see anything with. Even if a future build ships a frame for shape A, the existing
contract is the one to copy: opaque origin, no `allow-same-origin` (`fy-render-sandbox.tsx:374-379`),
trust by `event.source` identity and never `event.origin` because the origin is the literal string
`"null"` (`:40-43`, `:325-326`), exactly one accepted global message which buys a fresh
`MessageChannel`, and every later global message ignored (`:333-336`).

### 5.3 Where a plugin surface appears — the seam exists and has never been used

`packages/pwa/src/shell/side-pane-tab-model.ts:307` exports `registerSidePaneTab`, and the file's own
header describes the intent: _"later modules (browser HUD, files bar, skills groups) call
`registerSidePaneTab` from their own module scope and appear in the strip without touching this file.
The registry is versioned and subscribable, so late registration re-renders any live strip"_
(`side-pane-tab-model.ts:11-13`). A definition may carry its own `render`
(`side-pane-tab-model.ts:188`), and `SidePaneTabId` is `string` (`:56`), so ids are already open.

`rg -n --fixed-strings "registerSidePaneTab" packages/pwa/src` returns **only the file that defines
it**. Every caller is a test. **The dynamic-tab extension point was built, is tested, and has zero
production registrants.**

That is good news and a caution in one line. Good: the strip does not have to be redesigned to hold a
plugin tab. Caution: an extension point that has never had a real registrant has never had its
assumptions tested, and two of its neighbours are still closed — the icon is a `Record` of bundled
Lucide components (`side-pane-tab-icons.ts:24`) and instance kinds are a union of three
(`side-pane-tab-model.ts:74`). **A plugin therefore picks an icon from Ferretry's set. It does not
bring one.** Bundling an author's SVG would put author bytes back in the app's origin, which is §0
again wearing a smaller hat.

---

## 6. The six gates, one by one

### 6.1 Closed-set agreement — paid once

One new member in `DAEMON_CAPABILITIES` (`packages/protocol/src/lib/grants.ts:99`), which the mapped
type at `:132` propagates, plus three English sentences in `packages/pwa/src/lib/grants.ts`. The gate
compares registered pairs in both directions and will fail until both sides agree
(`scripts/validate/closed-set-agreement.ts:14`), which is the gate doing its job. **One-time cost,
no ongoing exemption.**

### 6.2 Route agreement — a namespace, and one piece of gate work

The gate reads _"Every `{ method, path }` pair in `packages/daemon/src/lib/runtime/mounts/**` and
`packages/daemon/src/lib/api/routes/**`"_ (`scripts/validate/route-agreement.ts:44-45`) — statically,
from source, and from those two directories alone (`:47-49`). A dynamically registered route
is invisible to it, and the allowlist _"may only shrink"_
(`scripts/validate/route-agreement-allowlist.txt:4-6`), so a plugin route cannot buy a line.

**So plugin routes must be a fixed, small number of literals in one mount file**, with the plugin id
and the action as parameters:

```
POST /v1/plugins/:pluginId/actions/:action
GET  /v1/plugins/:pluginId/view/:view
GET  /v1/plugins
```

Core route agreement then stays exact: three more literals, dialled by name from the PWA, no
wildcard needed for the common case.

**One honest piece of work, not free:** if a plugin ever needs a path tail of its own, the router
does support a catch-all segment (`packages/daemon/src/lib/api/router.ts:18`), but
`rg -n "path: '/v1/[^']*\*" packages/daemon/src/lib/runtime/mounts/*.ts` returns **nothing** — no
served route uses one — and `route-agreement.ts` has no notion of `catch-all` anywhere in its 1876
lines. A `*` in a served path would be a shape that gate has never been asked to reason about. **Do
not assume it works; the parameterised form above avoids needing it, and that is why it is the
recommendation.**

The two WebSocket streams are a separate table again (`mounts/index.ts:435`), so a streaming plugin
is a second decision and not part of a first slice.

### 6.3 Coverage ledgers — the boundary is the repo edge, literally

The ledger's scope is computed, not listed:
`find packages -mindepth 3 -maxdepth 3 -type d -path "packages/*/src/lib"` for the unit tier and
`src/adapters` for int (`scripts/ci/test.sh:38-40`), plus four PWA directories and `App.tsx`
(`:52-68`).

So the answer is exact and needs no new rule: **the plugin host is in the ledger at 100%, because it
is `packages/*/src/lib` and `packages/*/src/adapters` like everything else. A plugin's own code is
outside `packages/`, so it is outside the ledger.** The boundary falls at the repository edge, which
is where it already falls for every other file on the user's machine.

The consequence worth naming: **the ledger stops being a statement about everything that runs in the
product.** Today it is close to one. After plugins it is a statement about everything Ferretry ships.
That is a genuine reduction in what a green build means, and §9 lists it as a trade rather than
hiding it here.

### 6.4 Composition reachability — satisfied, because the host is static

The gate requires that _"starting at the composition root, some symbol of the module is transitively
demanded"_ and warns that _"loading a module is not using it"_
(`scripts/validate/composition-reachability.ts:19-20`); its allowlist is _"a work schedule, not an
exemption policy"_ (`reachability-allowlist.txt:5-6`).

Dynamic registration is only the opposite of that if the _modules_ are dynamic. Here they are not:
the plugin host is one subsystem, constructed once and passed to `mountedDaemonRoutes`
(`packages/daemon/src/lib/runtime/mounts/index.ts:274`) like every other. Plugins are **data the host
reads**, not modules the graph loads. **No allowlist line, no new exemption.**

And the gate's own stated blind spot is the one to respect while building this: it cannot see _"a
service the composition root imports, constructs a factory for, and then never calls"_
(`reachability-allowlist.txt:17-22`). A plugin host that is constructed and never invoked would pass
every gate in the repository and do nothing.

### 6.5 Grants — identical, by construction

§4. One member, two axes, the same decision path, the same refusal vocabulary, and the widen
asymmetry untouched: a caller who is not on the host can switch `plugin` off and can never switch it
back on (`docs/grants.md:304-313`).

### 6.6 The warden — §3.4, and the answer is "not today"

Stated there rather than repeated here, because the temptation is to write "the warden supervises it"
and the truthful sentence is that nothing does.

---

## 7. Distribution and trust: this is where the risk actually is

**Installing a plugin means putting an executable on the machine and telling a long-running daemon to
run it. That is the same act a fleet apply performs, and the fleet needed an entire authority model
for it.**

The precedent is exact, and it landed while this document was being written. A fleet apply writes
executable wrappers into the user's home, and `prune` — its one destructive operation — is bounded
twice, to one directory and to files carrying a managed marker
(`packages/fleet/src/lib/provisioning.ts:33-34`, `:84-90`). The capability layer alone would let a
remote paired phone do it; what stood in the way was a parallel approval system with its own codes,
TTLs and refusal vocabulary; the owner decided to dissolve its authorization half into the capability
model (`docs/design/fleet-authority-unification.md:25-39`, `:338-348`), and **that is now built** —
`19405223`, `feat(fleet)!: govern the fleet by the capability model (#362)`, whose §9 records what
shipped (`fleet-authority-unification.md:487-507`).

**So the one thing this document must not do is invent a second install-authority mechanism in the
same week the first one was deleted.** It does not have to, and that is new information: what
replaced the fleet's approval flow is general, and `docs/grants.md` says so at the point it is
described.

**Option A — install is a local act, full stop.** `fy plugin install <path>` on the host. No remote
route, no `plugin.install` axis, nothing to gate, nothing to phish. A person at the machine could
already run any program they like (`docs/grants.md:14-19`), so this adds no exposure whatsoever, and
"what does installing mean" gets an answer a person can hold: _somebody standing at this machine put
a program here._

**Option B — remote install under `plugin.configure`, confirmed by the operator password against the
exact artifact.** This is no longer a mechanism to design. `docs/grants.md:259-288` describes the
per-change confirmation as shipped: the **same** secret, the **same** five-try budget and
fifteen-minute lockout, checked by `CapabilityGrantService.confirmChange`, minting nothing and spent
inside the one request that carries it (`:265-274`). And the section closes with an invitation this
document is the first caller of:

> **Why only the fleet.** … a fleet apply is a discrete, reviewable artifact — a numbered manifest of
> writes a person reads before agreeing — so there is something for a confirmation to be _bound to_.
> `terminal.use` is a stream of arbitrary code with no such boundary … If a second capability ever
> grows a reviewable artifact, the machinery is `CallerGovernance.confirmChange` and it is not
> fleet-specific. — `docs/grants.md:290-295`

**A plugin install is exactly that artifact**: a manifest, a digest, a declared capability list and a
path — a thing a person can read before agreeing. **A plugin action is not**, and the distinction
matters more than it looks: confirming every plugin call would be the per-keystroke prompt that
section rules out by name. So if Option B is ever taken, the confirmation belongs on **install**, and
nowhere else.

Its one inherited limitation is unchanged and stated at `docs/grants.md:279-282`: on a machine with
no operator password — the default — there is no secret to bind an artifact to, and a control that
cannot refuse is theatre.

**Recommend A for v1 anyway**, and say why in one sentence: the first version of a plugin system
should not also be the product's second remote code-installation path — and Option B stays available
at any later date at a cost that is now measured rather than guessed.

Three further v1 refusals, each because it converts one decision into a standing one:

- **No registry and no URL install.** A plugin comes from the filesystem.
- **No auto-update.** An installed plugin is the bytes that were installed. A plugin that updates
  itself is a plugin whose review expired silently.
- **A plugin is enabled explicitly after install, and disabling is never harder than enabling** —
  the asymmetry the whole grant model rests on (`docs/grants.md:324-326`).

---

## 8. Upgrade: the product has no version negotiation, and a plugin needs one

Searching the protocol package for a negotiated version turns up **none**. The only version machinery
is `packages/protocol/src/lib/version-skew.ts`, and its answer to disagreement is to tell a person to
fix it: _"the versions differ; install matching fy and fyd builds"_ (`version-skew.ts:116`).

The reason is stated in that file's header and it is the constraint that matters here:

> Every device-facing response in this package is a `strictObject`, which REFUSES an unknown key
> rather than ignoring it. … **a key added to a device-facing `strictObject` ships in the same release
> as the client that reads it, or it is a breaking change.** — `version-skew.ts:9-16`

**The product's compatibility model is lockstep.** That works because Ferretry ships both ends. **It
cannot work for plugins, because the whole point is that somebody else shipped one end** — and under
§7 option A, they installed it by hand and nothing will update it.

So the plugin ABI has to be the one place in this product with real versioning, and the rules follow
from the existing doctrine rather than from taste:

1. **A manifest declares an ABI major.** The host implements a set of majors and **refuses** a plugin
   outside it — loudly, by name, with a remedy, the way an undetermined grant document refuses
   everything rather than guessing (`docs/grants.md:337-343`).
2. **Plugin-facing messages are additive within a major**, which means they must not be
   `strictObject` in the plugin direction. That is a deliberate departure from the device-facing rule
   above, and the reason is the sentence in bold two paragraphs up.
3. **A disabled-by-skew plugin says so where its surface would have been.** A tab that silently stops
   appearing after an upgrade is indistinguishable from a bug.
4. **The refusal is at load, not at first call.** A plugin that starts working and stops mid-session
   is the failure mode nobody can report usefully.

**What breaks today if this is skipped:** every daemon upgrade silently breaks every plugin, with no
diagnosis and no version to point at.

---

## 9. What is traded away, in one place

Not caveats — costs, stated so they are agreed to rather than discovered.

1. **The capability set stops being closed in spirit.** It stays closed at seven members, but one of
   them is a door. `docs/grants.md:91-93` justifies closure on the grounds that a list which grew to
   cover every route would become a second copy of the route table; a `plugin` member does not do
   that, but it does mean one switch now governs an open-ended amount of behaviour.
2. **The coverage ledger stops meaning "everything that runs"** and starts meaning "everything
   Ferretry ships" (§6.3).
3. **A second thing writes runnable files to the machine** — mitigated to near-nothing by §7 option A
   (a person at the machine), and not mitigated at all under option B.
4. **A plugin process is unsupervised and unbounded** on every platform today (§3.4). The warden does
   not watch it; cgroups do not cap it.
5. **A plugin can only draw what Ferretry can draw** (§5.2). This is the cost of §0 and it is
   permanent until browsers offer a boundary they currently do not.
6. **The "use, never read" secret property survives at the interface and not at the OS**
   (§3.3) — the same boundary `sudo` has, which is the boundary `docs/secrets.md:80-81` already
   claims and no more.

---

## 10. The decision

The engineering is tractable. The trade is not, and it is one question:

> **Do we ship a plugin system in which a plugin is (a) an out-of-process program the daemon spawns
> and speaks one versioned line protocol to, (b) governed by a single new `plugin` capability whose
> actions borrow the operator's existing grants and can never exceed the caller's, (c) installed only
> at the host command line, and (d) able to contribute a user interface only as a DATA document
> rendered by components Ferretry ships — accepting that a plugin can never bring its own code, its
> own icon, or its own visualisation to the browser?**

**Yes** → §§2-8 are the work, in that order, and the first slice is a capability plugin with no view
at all, because it has no unsolved problems in it.

**No** → then the honest alternatives, both of which are coherent products:

- **Plugins run author code in the browser anyway.** This is `type: html`, which
  `docs/fy-render.md:588-604` measured and declined. Choosing it means accepting a proven
  exfiltration channel out of any plugin panel, and it should be chosen in those words or not at all.
- **There is no plugin system, and new capabilities are contributed upstream.** The five closed sets
  in §1.3 stay closed, the ledger keeps covering everything that runs, and `terminal` and `browser`
  stay what they are.

**Implementation is not authorised by this document.**

---

## Appendix A: what this document does not propose

- **No change to `fy-render`.** Its shell, its CSP block, its gates and its measured claims are
  untouched. This document reads them; it does not extend them.
- **No plugin access to the relay.** A plugin speaks to the daemon over stdio and to nothing else.
  Whether a plugin may reach the network at all is a separate decision that needs its own paragraph
  and does not have one here.
- **No second authority mechanism.** §4.2 is the whole authority story: borrowed capabilities,
  decided once, by the layer that already decides them.
- **No fix for `fyd-browser-worker` not being compiled** (§1.4). It is a real defect, it is
  pre-existing, and it belongs to whoever owns release packaging.
- **No opinion on which plugin ships first.** Kanban, graph and loop engineering are all shape B
  (view plugins) and none of them is analysed here.

## Appendix B: the claims a reader is most likely to want to re-check

| claim                                                            | how to re-check it                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| author code in an opaque frame can still egress                  | `docs/fy-render.md:588-604`                                                                  |
| the sandbox shell is a static, separately-headered deployed file | `packages/pwa/public/_headers:9-21`; `scripts/validate/pages-config.sh:63-66`                |
| `terminal` is 7 declarations, `browser` 8, each in one mount     | `rg -c --fixed-strings "capability: 'terminal'" packages/daemon/src/lib/runtime/mounts/*.ts` |
| the dynamic tab registry has no production registrant            | `rg -n --fixed-strings "registerSidePaneTab" packages/pwa/src`                               |
| no served route uses a catch-all segment                         | `rg -n "path: '/v1/[^']*\*" packages/daemon/src/lib/runtime/mounts/*.ts`                     |
| the ledger scope is computed from directory names                | `scripts/ci/test.sh:38-40`                                                                   |
| there is no protocol version negotiation                         | `packages/protocol/src/lib/version-skew.ts:116`                                              |
| a relayed request is translated, not dialled                     | `packages/pwa/src/lib/daemon-transport.ts:5-9`                                               |

Use `--fixed-strings` on every one of those greps. `rg -r` is `--replace`, so `rg -rn "pattern" path`
prints each hit with the pattern rewritten to `n` and reads as "it is not there" — the mistake
`docs/grants.md:186-190` records, and one made twice while writing this document.
