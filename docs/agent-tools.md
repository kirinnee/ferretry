# Agent tools: terminals and browsers by name

Agents (and people, and scripts) drive a session's terminals and browser pages by **name**:
`%terminal:dev`, `%browser:app`. A person writes the reference in a message; the agent passes the same
name to its tools. This document is the contract for that surface and for what it does and does not
protect. Implement against it.

## Names

A name is a lowercase letter, then up to 31 lowercase letters, digits or dashes
(`SurfaceNameSchema`), unique within its session, and never twelve hex characters (that is what a
terminal id looks like, and `%terminal:<key>` accepts either). Terminal names live on the tmux pane
(`@fy_terminal_name`), so they survive a daemon restart. Page names live with the browser that holds
the page and end with it. The reference grammar is unchanged — see
[reference-standard.md](reference-standard.md) §2.

## Tools

`terminal.list` · `terminal.open(name, folder?, command?, askOwner?)` · `terminal.send(name, text?, keys?)` ·
`terminal.read(name, lines?)` · `terminal.wait(name, text | exit, timeoutMs?)` · `terminal.close(name)` · `terminal.ask_owner(name, message?)` ·
`terminal.request_input(name, prompt, sensitivity, submit?, expiresInSeconds?, blocking?, chain?)` · `input.wait(id, timeoutMs?)` ·
`browser.list` · `browser.open(name, url?, incognito?, askOwner?)` · `browser.navigate(name, url | history)` ·
`browser.click(name, target, button?, double?, modifiers?)` · `browser.type(name, target, text, submit?, slowly?)` ·
`browser.read(name, mode: text | a11y | snapshot, target?, find?, depth?, boxes?)` ·
`browser.screenshot(name, target?, fullPage?, format?)` · `browser.dialog(name, action, promptText?)` ·
`browser.tabs(action: list | adopt, id?, as?)` · `browser.wait_for(name, condition, timeoutMs?)` ·
`browser.console(name, level?, since?, limit?)` · `browser.network(name, action: list | get, id?, filter?, types?)` ·
`browser.emulate(name, viewport?, media?, geolocation?, locale?, timezone?, cpuThrottle?, network?, permissions?, reset?)` ·
`browser.upload(name, target, files, mode?)` · `browser.download(name, id?, saveAs?, overwrite?)` ·
`browser.pdf(name, saveAs?, overwrite?)` ·
`browser.hover` · `browser.drag` · `browser.mouse` · `browser.press` · `browser.scroll` · `browser.select` · `browser.check` ·
`browser.fill_form` · `browser.highlight` (see [Pointer and keys](#pointer-and-keys)) ·
`browser.eval(name, function, target?, timeoutMs?)` (owner-gated: [Page scripts](#page-scripts-owner-gated)) ·
`browser.close(name)` · `browser.ask_owner(name, message?)`.

A **target** is exactly one of a `ref`, a `selector`, or — for a click only — a point `x`, `y`; see
[Refs and targets](#refs-and-targets). `history` is `back`, `forward` or `reload`.

The wire body is `AgentToolCallSchema` (`packages/protocol/src/lib/agent-tools.ts`); the answer is
`AgentToolResultSchema`. The same actions are `fy terminal …` and `fy browser page …`
(`fy browser page open <name> [url] --incognito`; `fy terminal open <name> --ask [message]`;
`fy terminal ask <name> [message]`).

A single value at a prompt (a password, passphrase, one-time or 2FA code) is `terminal.request_input`, not `terminal.ask_owner`: the owner types it on a card (or `fy input answer`), and the agent never receives it ([input-requests.md](input-requests.md)). A one-time code is sensitivity `code`: the ferret may see it, and may instead read it from an inbox it has and type it itself, only on the page of the sign-in it is for ([one-time codes](input-requests.md#one-time-codes-code)). `fy input ls|answer|cancel` is the owner's command and refuses to run inside a ferret.

A value the agent must move but not see (a token it just minted, a key a command prints) is `secure.copy`: the daemon captures it as `sealed:<name>`, masks it everywhere it scrubs text, and the agent learns only its source, length and expiry. `secure.list` shows the session's copies and `secure.discard` lets go of one. Pasting a copy is an owner-approved input request ([secure-copy.md](secure-copy.md)).

The MCP names swap the dot for an underscore: `terminal_open`, `terminal_ask_owner`, `browser_ask_owner`, …

A terminal opens the owner's own login shell (zsh, bash, fish …), not `/bin/sh`; a `command` is typed into it
like keystrokes. See [terminals.md](terminals.md).

## Refs and targets

`browser.read` with `mode: "snapshot"` answers the page's accessibility tree with a **ref** beside every
element — `- button "Sign in" [ref=e4]`, or `f1e3` for an element inside a frame. Every act that names an
element takes `ref: "e4"` in place of a selector, so an agent reads once and acts on what it read
(the target rules live in `packages/protocol/src/lib/browser-target.ts`).

- **A ref is good only against the page's latest snapshot.** It is Playwright's own `ai`-mode snapshot and
  `aria-ref` selector (playwright-mcp's mechanism, in the `playwright-core` we already pin). A ref the page
  no longer knows — it navigated, or was never snapshotted — is refused with the fix ("read the page again
  with mode `snapshot`"), never resolved to a guess.
- **`find`** keeps only the snapshot lines that contain a text (case-insensitive, at most 200), each still
  carrying its ref. `depth` limits the tree; `boxes` adds each element's viewport box, for a click by point.
  Asking for any of the three without a `mode` reads a snapshot.
- **A point** (`x`, `y`, viewport CSS pixels, 0–10,000) is for a canvas, a map or anything a snapshot cannot
  name, and only a click takes one. A point's modifier keys are pressed around the click and always released.
- **Reads keep the top.** A snapshot or tree longer than one answer keeps its first lines (cut on a line), and
  the summary says how to read less; visible text keeps its tail, as it always has.
- A screenshot is the viewport, the `fullPage`, or one element; PNG unless `format: "jpeg"`. The MCP server
  sends it with the matching MIME type.
- The CLI reads the same shapes from one word: `fy browser page click app e12`, `… click app 120,340`,
  `… read app --snapshot --find "Sign in"`, `… navigate app back`.
- An MCP client that sends `false` for an on-only flag (`double`, `submit`, `slowly`, `boxes`, `fullPage`,
  `incognito`, `overwrite`, and `reset`, `print` and `offline` in `browser.emulate`) is read as having left it out.

## Page lifecycle

Six tools for what happens around a page rather than on it. Each is `fy browser page <verb>` and
`browser_<verb>` over MCP (`browser_wait_for` for `wait`).

- **`browser.dialog`** answers an `alert`, `confirm`, `prompt` or `beforeunload` the page is blocked on:
  `action: "accept" | "dismiss"`, and `promptText` with an accept. An unanswered dialog is held **up to 30 s per
  page**, then dismissed. While one is pending, **every act result on that page reports its type and its
  scrubbed message**, so the agent knows why the page is not answering. The audit records the type, whether it
  was accepted and the length of `promptText` — never the text.
- **`browser.tabs`** is `list` or `adopt`. A popup whose opener chain ends at a page this agent opened or was
  handed is the agent's; `list` shows it with its `openerId` and whether it is `available` to the agent, and
  `adopt` (`id`, `as`) gives it a name so the other tools can reach it. It never selects a tab and never
  brings one to the front — there is no active tab ([above](#the-browser-one-shared-agent-profile-per-machine)).
- **`browser.wait_for`** waits for **exactly one** condition: an element (`ref` or `selector`, `state` =
  `visible` (the default), `hidden`, `attached` or `detached`), `text`, `textGone`, a `url` fragment, a
  `load` state, or a `time`. `timeoutMs` is **at most 25 s per call** on the wire. The page is checked in
  **slices of at most 1 s**, and the takeover check runs between slices, so a person taking the page back stops
  the wait. The MCP server and the CLI repeat the call, as `terminal.wait` does, until it matches or
  **120 s** are spent (`timeoutMs` default 25 s, `fy browser page wait --timeout`); a `time` wait is not
  repeated. A miss answers `matched: false`, never an error. The audit records the condition's **kind and the
  timeout only**, never the text or the url.
- **`browser.console`** reads the page's console: a ring of **500 entries per page**, each numbered.
  `level` means that level **and worse** (`error` > `warning` > `info` > `log` > `debug`); `since` is an
  entry number and returns only later ones; `limit` is 100 by default and 500 at most. Messages are scrubbed
  and clipped.
- **`browser.network`** is `list` or `get`. A ring of **300 requests per page**; `list` gives each an id
  (`r12`), method, address, status, kind and timing, narrowed by `filter` (address contains) and `types`.
  `get` takes an `id` and adds the response headers and, for text, the body — **at most 64 KiB**. `Cookie`,
  `Set-Cookie`, `Authorization`, `Proxy-Authorization` and **any header whose name contains `token`,
  `api-key` or `secret`** are always stripped. This version shows **no request bodies and no full headers**.
  Everything is scrubbed like any other page text.
- **`browser.emulate`** changes how one page presents itself, **per page, over CDP**: `viewport` (the same
  bounds and the same resize as the page-size control), `media` (`colorScheme`, `reducedMotion`,
  `forcedColors`, `contrast`, `print`), `geolocation`, `locale`, `timezone`, `cpuThrottle`, `network`
  (`offline`, `latency`, `throughput` in kbit/s) and `permissions`. **Never the user agent or client hints, and
  never clipboard-read.** `permissions` is a closed list, and `reset: true` puts everything back.

On the command line: `fy browser page dialog app accept --text hi`, `… tabs`, `… tabs adopt p7 popup`,
`… wait app --text "Welcome" --timeout 60000`, `… console app --level warning --since 40`, `… network app`,
`… network app r12`, `… emulate app --viewport 390x844 --color-scheme dark`, `… emulate app --reset`.

## Pointer and keys

Nine more tools drive the pointer and the keyboard. They are the same agent-tool path as a click — the
browser switch, the session's own pages, the takeover guard (a taken-over page is a `409 taken_over`), the
driving marker and exactly one audit record — and their grammar is one file,
`packages/protocol/src/lib/browser-pointer.ts`, shared by the wire tool and the browser's own action (the
worker parses the action again with the same schema).

| Tool                                                             | Does                                                                                                                                                                                    | Bounds                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `browser.hover(name, target)`                                    | Moves the pointer over an element, or to a point                                                                                                                                        |                                                  |
| `browser.drag(name, from…, to…, steps?)`                         | Element to element with Playwright's `dragTo` (HTML5 drag and drop), or point to point (`fromX/fromY` → `toX/toY`) with the mouse down, `steps` moves, up — for a slider, canvas or map | `steps` 1–100 (10); never an element and a point |
| `browser.mouse(name, action, x?, y?, button?, deltaX?, deltaY?)` | `move` (needs a point), `down`, `up` (optional `button`), `wheel` (needs a delta)                                                                                                       | delta ±20,000                                    |
| `browser.press(name, keys, target?)`                             | Presses each chord in order, focusing the element first when one is named                                                                                                               | ≤ 32 keys of ≤ 40 characters                     |
| `browser.scroll(name, target \| text \| deltaX/deltaY \| pages)` | Into view, to a text, by pixels or by screens — exactly one                                                                                                                             | pixels ±20,000; pages ±20; text 256              |
| `browser.select(name, target, values)`                           | Picks options by value or by label                                                                                                                                                      | ≤ 64 values of ≤ 256                             |
| `browser.check(name, target, checked)`                           | Ticks or unticks; `checked: false` is meaningful and is never read as "left out"                                                                                                        |                                                  |
| `browser.fill_form(name, fields)`                                | Per field, a target and exactly one of `text`, `checked`, `option`, `value`                                                                                                             | ≤ 32 fields; ≤ 64 KiB of text in all             |
| `browser.highlight(name, target \| clear)`                       | An outline the person watching sees; `clear: true` removes it                                                                                                                           |                                                  |

- **A key is a closed grammar**: zero or more distinct modifiers (`Alt`, `Control`, `ControlOrMeta`, `Meta`,
  `Shift`), then a named key (`Enter`, `Tab`, `Escape`, `ArrowDown`, `F1`–`F12`, …) or one printable character:
  `Enter`, `a`, `Control+Shift+K`, `Control++`. Anything else is refused before the first key is pressed.
- **Scrolling does not need a viewport**: a distance or a number of screens scrolls the page itself; a text
  scrolls to its first place and says so when it is not on the page.
- **A password field is flagged, not blocked.** When `browser.type` or `browser.fill_form` writes into an
  `input type=password`, the worker notices, the answer says it was a password field and that **a real
  secret must never go in a tool call** — it would sit in the agent's transcript — and to hand the page to the
  owner with `browser_ask_owner` so they type it. The audit record carries `passwordField: true`.
- **Audit facts are counts, lengths, refs and flags**: `keys: 2`, `values: 1`, `fields: 3` with the total
  `textLength`, a drag as `from`/`to` (a ref, a clipped selector or `point`), `checked`. Never a key name,
  an option, a value or typed text.
- The CLI has a verb for each but `fill_form`: `fy browser page hover app e3`, `… drag app e1 '#bin'`,
  `… drag app 1,2 300,2 --steps 25`, `… press app Control+a Delete --on e4`, `… scroll app --to e9` /
  `--text Terms` / `--by 0,-600` / `--pages 1`, `… select app e5 uk`, `… check app e6 --off`,
  `… highlight app e2` / `--clear`. `fill_form` is on the wire and in MCP only.
- An MCP client that sends `clear: false` is read as having left it out; `checked: false` is kept.

## Page scripts (owner-gated)

`browser.eval` runs an agent's **own JavaScript function** in a page it drives: `() => …`, or `(element) => …`
with a ref or selector, at most 4 KiB, stopped after `timeoutMs` (5 s by default, 10 s at most). The answer is
the value as JSON, or its string when it is not serialisable, clipped to 64 KiB and scrubbed by the vault
redactor like every other page text. `fy browser page eval <name> <function> [--of <target>]`; `browser_eval` over MCP.

- **Off until the owner turns it on.** It needs "What agents may control › **Page scripts**"
  (`machine.agentControl.pageScripts`, default `false`) as well as Browsers. Turning it on is a loosening, so
  it is **held until the owner confirms it** ([config-files.md](config-files.md)): an agent that edits
  `machine.yaml` itself only ever makes a held edit. The owner turns it on in the app (Settings › a machine ›
  What agents may control › Page scripts), with `fy machine set agent-control scripts on`, or in
  `machine.yaml`; off applies at once. While it is off the tool is still listed, and a call is refused with
  exactly those ways to turn it on. The switch holds for a **person's** call too, so a paired device with the
  browser grant cannot reach the shared profile's sign-ins through a script.
- **A world of its own.** The function runs in an isolated world Ferretry creates on the page's main frame
  (DevTools `Page.createIsolatedWorld`, then `Runtime.evaluate`): it shares the page's **DOM** but none of
  its JavaScript, so the page's own variables, patched built-ins and framework state are not visible to it,
  and nothing the page defines can change what it reports. Being DevTools' own evaluation, it is not refused
  by the page's Content Security Policy. An element crosses into that world by a one-time
  `data-ferretry-script` attribute, removed afterwards whatever happened — the page can see it for the length
  of the call.
- **The usual rules.** Own pages only; the takeover guard runs inside the page's queue (409 `taken_over`); a
  dialog the script opens is reported like any act's; the driving marker goes up. The audit records the
  function's **length**, the target (ref, clipped selector), the timeout and the **length** of the answer —
  never the function or what it returned.
- **Honest limit.** Even isolated, a script reads what the page holds: its DOM, its non-HttpOnly cookies and
  its `localStorage`. On the shared agent profile that can include sign-ins to every site the owner signed
  that profile in to. That is why it is off by default and why turning it on waits for the owner.
- **Still refused.** Raw DevTools access (it reaches every session's pages and the profile's HttpOnly
  cookies); running in the page's own world (a hostile page could tamper with what the agent reads); a
  navigation `initScript` and network route mocking (the same power, persisting across navigations).

## Routes

| Route                                                     | Who                       | Session from                                                              |
| --------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `POST /v1/agent/tools`                                    | an agent, on this machine | its session credential ONLY                                               |
| `POST /v1/sessions/:sessionId/surfaces/terminals/tools`   | a person (CLI, app)       | the path; `terminal` grant                                                |
| `POST /v1/sessions/:sessionId/surfaces/browser/tools`     | a person                  | the path; `browser` grant, plus `filesystem` for the [file tools](#files) |
| `POST /v1/sessions/:sessionId/surfaces/terminals/control` | a person: control         | the path; `terminal` grant                                                |
| `POST /v1/sessions/:sessionId/surfaces/browser/control`   | a person: control         | the path; `browser` grant                                                 |
| `GET /v1/sessions/:sessionId/surfaces/terminals/control`  | a person: who drives what | the path; `terminal` grant                                                |
| `GET /v1/sessions/:sessionId/surfaces/browser/control`    | a person: who drives what | the path; `browser` grant                                                 |

A control request is `{ action: 'takeover' | 'handback' | 'handover', key }` and answers
`SurfaceControlView { sessionId, driving[], takeovers[], handed[], opened[], asked[] }` for that kind.
`opened` and `asked` default to `[]`, so a newer app reads an older daemon.

Control changes are published on the session's journal, so `/v1/events` streams them:
`surface.driving` (`SurfaceDrivingSchema`, carrying `until` — show the marker while `now < until`, and
`incognito` for an incognito page), `surface.takeover`, `surface.handback`, `surface.handed`,
`surface.opened` (`SurfaceOpenedSchema`) and `surface.asked` (`SurfaceAskedSchema`). The daemon replays its
journal on start, so a takeover, a hand-over, an open or an ask outlives a restart.

## Files

`browser.upload`, `browser.download` and `browser.pdf` move files between a page and the **session's own working
folder** — the one `terminal.open` resolves `folder` against. They never reach anywhere else on the host.
`fy browser page upload <name> <target> <files…> [--drop]`, `… download <name> [saveAs] [--id dl-3] [--overwrite]`
and `… pdf <name> [saveAs] [--overwrite]` are the same calls; MCP has `browser_upload`, `browser_download`, `browser_pdf`.

**Which paths are accepted** (`packages/daemon/src/lib/agent-files/`, the pure policy; the disk is a port,
`NodeAgentFilesystem` in `src/adapters/agent-files/`). A path is resolved twice: lexically, then by `realpath`
(a destination that does not exist yet is resolved through its nearest existing ancestor), and must land inside
the folder's own real path both times. Refused, in a sentence that names the rule: `..`; an absolute path
outside the folder; a symlink — file or directory — that leads out; anything inside `.git/` at any depth; and
the daemon's own scratch entries at the top of the folder (`DAEMON_OWNED_SCRATCH_ENTRIES`: `chat.jsonl`,
`events.jsonl`, `config.json`, `attachments/` …). An upload may instead name `{ "attachment": "att_<64 hex>" }` — a file
the owner put in THIS session's chat; the daemon copies it into its own private directory for the call and
removes it afterwards.

**Caps.** An upload is at most 20 files, 50 MiB each and 200 MiB per call. A download or PDF saved is at most 500 MiB.

**`browser.upload`.** `target` is a ref or a selector, as for a click. `mode: "input"` (the default) fills an
`<input type=file>`, or clicks the target and answers the file chooser it opens; `mode: "drop"` drops the files on
the target's centre, for a dropzone with no input. The summary tells the agent when the page now shows a human
check, and lists any download the upload started.

**`browser.download`.** The browser worker stages every file a page downloads in a daemon-owned directory for
15 minutes. The act that started one reports it ("A download started: name, size — save it with browser_download (id dl-3)"),
and `browser.download` copies the chosen one (the page's latest when `id` is absent) into the folder: at `saveAs`, else
`downloads/<sanitized name>`. It never replaces a file that is already there unless `overwrite: true`, never writes
through a symlink (it is opened `O_EXCL|O_NOFOLLOW`), and never sets an executable bit (mode 0644). The name a page
suggests is sanitised to a leaf name and scrubbed like any page text.

**`browser.pdf`.** Prints the page with CDP `Page.printToPDF`, then saves it by the same rule (`downloads/<title>.pdf`).
Chrome prints only when headless; in **Real window** mode it is refused with one sentence.

**Wire shape.** The file actions are NOT in `BrowserActionSchema`, so the toolbar route cannot carry a host path: the
daemon hands the worker an already-confined absolute path (`BrowserFileAction`, daemon-only), and a download comes back as
a staged path the daemon alone saves.

## Handing a surface to the owner

An agent that needs the person to act — a sudo or password prompt, an OAuth or device-code login,
`gh auth login`, 2FA, "press Enter", a TUI wizard, a web login, a captcha, a payment or consent screen —
is told, in the always-on tools section of every prompt (`AGENT_TOOLS_INSTRUCTION`), to open a terminal or
page, drive it as far as it can, then hand it over and wait. It never puts a secret in chat or in a tool
call.

- **An open is announced.** When an AGENT opens a surface the daemon publishes `surface.opened` once
  for it (never for a person's own open), and the app adds it as a tab beside Chat and Console. The tab is
  added once per surface: closing it does not close the surface and does not bring the tab back, and the
  ＋ menu offers "Reopen" for a surface that is still alive.
- **An ask is a hand-off.** `askOwner` on `terminal.open` / `browser.open` (`true`, or up to 280 characters
  saying exactly what to do), or a later `terminal.ask_owner` / `browser.ask_owner`, publishes
  `surface.asked`. The app switches to that tab and marks it "Your turn here". Asking again is a fresh
  ask. An ask stands until a person takes the surface over or hands it back (both end it, in the live
  state and on replay) or the surface closes. Only an agent can ask; a person's call is refused.
- **The message is not audited.** The audit record keeps only whether a message was sent, like the typed
  text of `terminal.send`.
- **Focus.** An open never moves focus, selection or the active tab of a pane that already has one — it
  adds a tab and a small "new" mark, and a banner that says "Agent opened terminal dev" with a Show
  button. Only an ask moves to the tab, because the agent is now waiting on the person.
- **Closed surfaces vanish from the view.** A close is not journaled, so `GET …/control` reads `opened` and
  `asked` against the surfaces still alive in the session.

## The browser: one shared agent profile per machine

- **One Chrome per machine**, headless on every platform, over Ferretry's own dedicated agent profile —
  never a person's own Chrome profile. **Every agent on the machine shares that profile's cookies and
  sign-ins.** An agent signed in to a site is signed in for every agent; a person who signs the profile
  in (the sign-in window) signs every agent in. That is the trade-off for "agents can just use the
  sites you use": treat anything the profile is signed in to as reachable by every agent here.
- **Incognito pages** (`browser.open(…, incognito: true)`) are the exception: each is its own
  throwaway browser context — its own cookies and storage, nothing shared with the profile or with
  any other page — discarded when the page closes or its session ends. Pages and events carry
  `incognito: true`.
- **Every page belongs to the session that opened it**, opens in its own window, and is listed to and
  actable by that session alone; a popup belongs to its opener's session. Chrome renders and streams
  a tab only while it is visible in its window, which is why each page gets its own window — and a
  headless window is never shown, so the daemon's per-session ownership, not the window, is what keeps
  agents' tabs apart.
- **One window per page, grouped per agent in the UI.** The window is Chrome's rendering unit, not
  what a person sees: a reader groups pages by their owning session, so every page one agent opened
  shows together as that agent's browser ("Hadi's browser"). Every page summary carries what that
  grouping needs, popups included (a popup is its opener's): `ownerSessionId`, and `ownerName` —
  what a person calls the agent, its first name or else its task title. Every driving event carries
  `agentSessionId` and `agentName`, the same name.
- **There is no active tab.** Every act, every input and every screencast names its page (each page's
  own CDP session). A person's input and live view go to the page their session is viewing; an
  agent's act moves nothing. Acts are serialized per page, not per browser, and input never queues
  behind a page load — a person and an agent work at the same time without blocking each other.
- Caps: 20 pages per session, 60 per machine — refused past them, never hidden. The machine cap
  counts every page that belongs to a session, so the popups an agent's clicks opened count too; the
  pages are read fresh before each open. The browser stops
  after 15 minutes with nobody watching and nobody acting.
- **Passkeys are off.** Every page carries a virtual authenticator that never confirms user presence, so
  sites see no platform passkey and a WebAuthn prompt fails at once and falls back to the password form.
  The user agent is never changed. A login that needs the owner's own passkey or key is handed over with
  `browser_ask_owner`. See [input requests › Pages](input-requests.md#pages).
- **Logins go through the input bridge.** `browser_request_input` asks the owner for a form's values on one
  card (a `plain` e-mail and a `secret` password, say) and the daemon types each into its field; the agent
  never holds a secret. A captcha is never solved: the agent hands the page over.
- The CDP port listens on loopback and accepts no cross-origin WebSocket (`--remote-allow-origins` is
  gone; the worker sends no `Origin`).

## What is enforced, and where

1. **An agent reaches only its own session.** `POST /v1/agent/tools` names no session anywhere: the
   daemon hashes the credential presented as `Authorization: Bearer fys_…` or on `x-fy-session-capability`
   and finds the one LIVE session whose stored hash matches (constant-time). The call schema is strict, so
   a body `sessionId` is refused; `x-ferretry-session-id` may only agree with the credential, and one
   naming another session is `401 session_mismatch`, audited. Surfaces are looked up in that session's
   listing only.
   The credential (`FY_SESSION_BOARD_CAPABILITY`) is re-issued for every pane launch — the first one
   and every revive — and the previous one stops working at that moment, so a leaked copy dies with its
   pane; a daemon restart that leaves panes running does not change it.
2. **No host authority.** The agent route is `none` + `privilegedOnly`: it is served only over a
   privileged loopback carrier (never a paired device or the relay), and the session credential is the
   whole of its authority — it neither needs nor reads the admin token. `fy mcp serve` and an agent's
   `fy terminal`/`fy browser page` send no bearer token at all.
3. **An agent acts only on what it opened, or what a person handed to it.** A person's own terminal or
   page in the agent's session is refused ("… is a person's, not yours") until they hand it over
   (`handover`). An agent's `terminal.list` / `browser.list` show only its own surfaces and the ones
   handed to it: a person's page is absent — not its name, its URL or its title — until it is handed
   over.
4. **A person's route refuses an agent that says it is one** (`peer:` / `warden:` actors).
5. **What agents may control.** Every agent call first asks the machine's `AgentControlPolicy` (unit S's
   store, read per call). The same switches also wrap every ordinary terminal, browser and filesystem
   route — HTTP and sockets — for an agent caller, so `files` is enforced on the session filesystem
   routes. A person is never asked. **The three [file tools](#files) need the `files` switch AS WELL AS
   `browser`**; on a person's route `POST /v1/sessions/:id/surfaces/browser/tools` they additionally need the
   `filesystem` grant on `use` ([grants.md](grants.md)), so a paired phone granted the browser cannot reach the host's
   disk through it. A caller whose grants cannot be read is refused; the owner at the machine is not governed.
6. **Take over / hand back, per tab and per terminal.** While a person holds a surface, every agent tool
   call on THAT surface is refused ("A person has taken over %terminal:dev; wait or ask them."); the
   agent keeps working everywhere else. The check is repeated inside the page's own queue, so a takeover
   landing while an act waits its turn still wins; an agent's `terminal.wait` stops the moment the
   terminal is taken over. An act already running when the takeover lands finishes (a page load is
   bounded at 45 s); several people typing into one terminal at once is fine.
7. **Audit.** Every call writes one `agent.tool` record: tool, surface name, outcome, lengths and
   `incognito` — never typed text, a URL's path or query (host only), or a selector over 120 characters.
   A target is recorded as its ref, its clipped selector or `point: true` (never the coordinates); a
   `find` as its length; options (`double`, `submit`, `fullPage`, `format`, a history step) by what they were.
   The one exception to "no text" is the file tools: `browser.upload` records the count, total bytes and, for up to four files,
   the leaf name (≤120 characters, never a path) and size; `browser.download` and `browser.pdf` record the saved size and
   extension only. A refused credential or a body that is not a call is recorded too (`reason`). Takeovers and
   hand-overs write `surface.control`. Identical successes fold per minute like all activity.
8. **What a page shows is scrubbed.** Every text a browser tool hands back — a read, a snapshot, the address
   in the summary — goes through the vault redactor first, to an agent and a person alike, as the operator's
   screen and transcript reads do: a dashboard that shows an API key the vault holds comes back
   `[redacted:NAME]`. A vault that cannot be opened withholds the text (`unavailable`) rather than serving it
   raw; the act itself has already happened. Screenshots are pixels and are not scrubbed.
9. **Bounds.** Text 16 KiB, 64 keys, 2000 lines read, 64 KiB returned, a 25 s wait per request (a client
   loops up to 120 s), URLs `http`/`https` only and 2 KiB, selectors 1 KiB; terminal creation is
   serialized, so two opens racing for one name leave one terminal.

## The ferret session credential

Every agent pane holds its own credential: 32 random bytes the daemon mints at each pane launch, keeps
only the SHA-256 of (`sessionCapabilityHash` in the session's `config.json`), and writes into the pane as
`FY_SESSION_TOKEN` — the documented name — and `FY_SESSION_BOARD_CAPABILITY`, the older name, kept for one
release. It is also a **bearer class** of its own, `session`, beside the admin and warden tokens:

- **Shape.** Every value minted now is `fys_` followed by 43 base64url characters, so the daemon knows a
  session bearer from its shape and looks only those up. A value of any other prefix or length is answered
  as a stranger without a lookup. A pane launched before the prefix holds an unprefixed value; it is still
  accepted on `x-fy-session-capability`, the agent tools' header, until that pane is next launched.
- **It names its session.** The session comes from the credential, never from `x-ferretry-session-id`.
  Absent, the header is not needed; present and naming another session, the request is
  `401 session_mismatch` and a `session.credential-refused` record — on every route, the agent tools'
  included — names the session the credential named, never the credential.
- **Revocation.** The lookup reads only ACTIVE sessions: a session that stops, completes, fails or is
  deleted is no longer consulted, so its credential names nobody from that moment. Every pane launch
  rotates it. A daemon restart keeps the hashes of sessions still running, because their panes survive it.
- **From this machine only.** A session-shaped bearer is looked up only when the request arrived on the
  privileged loopback carrier; from the tunnel, a LAN bind or any other remote carrier it is a stranger's,
  answered without a lookup. A live and a dead credential get the same `401 unauthorized`.
- **Not advertised yet.** `session.credential.1` is defined, and `GET /v1/health` will list it once routes
  accept the credential. A client that sees it presents this credential and never falls back to the
  admin token, whatever the answer — so listing it now would cut a ferret off from `fy send`.

**What this release does NOT change yet.** A session bearer reaches nothing it could not reach before:
on every route the authorization boundary authenticates it is refused — `401`, exactly as a stranger —
and the only route that takes it is `POST /v1/agent/tools`, which reads it itself. `fy` and the MCP server
still present the admin token plus `x-ferretry-session-id` everywhere else, so "ferret or person" outside
the agent tools is still decided from that header (the [declared gap](#declared-gaps) below). Refusing a
session credential on a person's route and admitting it on an agent's, per route, is the next step;
`fy` and the MCP server presenting it instead of the admin token is the one after.

## Sub-ferrets and the Ferretry verbs

The same tools server serves a lead and a sub-ferret; the **daemon** tells them apart by session identity
(`config.parent`). A sub-ferret may read everything and report with `fy send`, `fy task note` and `fy task link
--pr` / `--branch`; agenda writes, `fy notify` and card moves are refused with `forbidden` and the line to tell its lead
([pack-mode.md](pack-mode.md#sub-ferret-limits)). Nothing here is a tool the model is withheld: the refusal is on
the route, so it holds for an MCP call and a shell `fy` alike. A lead may `edit`, `surface`, `done` and `dismiss`
agenda items in a sub-ferret's session with `-s <session>`, proven by lineage.

## Declared gaps

- **The shared admin token.** An agent runs as the same user as the daemon and can read the admin token
  from the state home. Such an agent can call a person's route without identifying itself and act past a
  takeover, on a person's own surface, or past a switch. This is the boundary `isHumanAdminActor`
  already states — for honest clients, not a sandbox.
- **Same-user processes** can read each other's environment, including another session's credential.
- **The shared profile** is shared by design: see above.
- **Chrome's sandbox on Linux.** The agent browser still runs with `--no-sandbox` on Linux. Measured on
  this project's Ubuntu host (`kernel.apparmor_restrict_unprivileged_userns=1`, a Nix-packaged Chrome
  whose `chrome-sandbox` helper is not setuid): without the flag Chrome does not start. A
  distro-packaged Chrome with a setuid `chrome-sandbox`, or a kernel that allows unprivileged user
  namespaces, can run sandboxed — dropping the flag where the host supports it is a follow-up, not a
  removal this change can make unconditionally. Until then a renderer exploit on a page an agent is
  steered to runs as the daemon's user.
- **A terminal's folder** is where the shell starts, not a boundary.
- **Files: check, then use.** A path is confined by `realpath` when the call is made, and the worker reads it a
  moment later; a same-user process that swaps a checked path for a symlink in that window can still redirect an
  upload. The file tools' destination is closed against this (`O_EXCL|O_NOFOLLOW`); the read side is not.
- **PDF needs a headless browser.** In Real window mode `browser.pdf` is refused rather than faked.
- **A staged download** sits in a daemon-owned directory (mode 0700) for up to 15 minutes before it is saved or pruned.

## The tools server in every agent runtime

`fy mcp serve` is a stdio MCP server (hand-written JSON-RPC 2.0: `initialize`, `ping`, `tools/list`,
`tools/call`; notifications are never answered). It holds exactly the authority of the agent session
whose credential is in its environment, and nothing else: it talks only to the daemon on this machine,
sends no bearer token, and never reads the host's admin token. The fleet's fixed layer adds it to every
agent runtime as a locked entry, with a short built-in instruction (the tools, the rules for changing
Ferretry's own settings, then how to notify the owner and, in agenda mode, raise agenda items) in the system prompt:

- **Claude**: `--mcp-config=<inline JSON for server "ferretry">` (the person's own servers stay; its
  `env` blanks `FY_TOKEN`, since Claude hands a stdio server its whole environment) and
  `--append-system-prompt=<instruction>`. A profile's own `--append-system-prompt` is KEPT: Ferretry's
  instruction is appended after it, in the one flag Claude takes.
- **Codex**: `-c mcp_servers.ferretry.command/args/env_vars` (forwarding `FY_HOME`, `FY_URL`,
  `FY_SESSION_ID`, `FY_SESSION_BOARD_CAPABILITY` — never `FY_TOKEN`) and
  `-c developer_instructions=<instruction>`. A profile's own `developer_instructions` is kept the same
  way: the person's text first, then Ferretry's.

The wrapper appends each ferret's own sections to that same value at launch — hypermedia, Pack mode and
the lessons teaching, each when its switch is on ([hypermedia.md](hypermedia.md#delivered-as-system-instructions-per-ferret)).

The server's own `initialize` instructions are one line; `lessons_suggest` files a lesson through
`POST /v1/agent/lessons` ([learning.md](learning.md)); `instructions` answers, from the environment the
server inherited, which of those sections this ferret launched with — the `fy instructions` report
([hypermedia.md](hypermedia.md#delivered-as-system-instructions-per-ferret)).

`search_work` {`query`, `kind`?, `open`?} is `fy search` for a ferret: cards and agenda items by what they say
(or an id like F303 or A3), one text line per hit — id, kind, standing, title, the matching line. It calls
`GET /v1/search` through the person gateway the MCP server already holds (the route is operator-minimum plus
`fleet:use`, and an agent's own credential is not that), so it adds no route of its own. The ferret is told
to search before it files (the board and agenda sections end their opening with the same rule), and
`fy task create` / `fy agenda add` run the daemon's related check themselves
(`POST /v1/search/related`): a strong match refuses the create unless `--new` (or `--related <id>`) says what to
do instead. A daemon without `work.search.1` answers 404 and the create goes ahead with one dim line.

MCP tool names use `_` (`terminal_open`), because provider tool APIs refuse `.`; each maps one-to-one to
the wire tool (`terminal.open`). A refusal comes back as a tool result with `isError: true` and the
daemon's sentence, so the model reads it. The server reads lines up to 1 MiB and drops longer ones.
