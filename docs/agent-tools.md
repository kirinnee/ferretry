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
`browser.list` · `browser.open(name, url?, incognito?, askOwner?)` · `browser.navigate(name, url)` ·
`browser.click(name, selector)` · `browser.type(name, selector, text)` ·
`browser.read(name, mode: text | a11y, selector?)` · `browser.screenshot(name)` · `browser.close(name)` · `browser.ask_owner(name, message?)`.

The wire body is `AgentToolCallSchema` (`packages/protocol/src/lib/agent-tools.ts`); the answer is
`AgentToolResultSchema`. The same actions are `fy terminal …` and `fy browser page …`
(`fy browser page open <name> [url] --incognito`; `fy terminal open <name> --ask [message]`;
`fy terminal ask <name> [message]`).

A single value at a prompt (a password, passphrase, one-time or 2FA code) is `terminal.request_input`, not `terminal.ask_owner`: the owner types it on a card (or `fy input answer`), and the agent never receives it ([input-requests.md](input-requests.md)). `fy input ls|answer|cancel` is the owner's command and refuses to run inside a ferret.

The MCP names swap the dot for an underscore: `terminal_open`, `terminal_ask_owner`, `browser_ask_owner`, …

A terminal opens the owner's own login shell (zsh, bash, fish …), not `/bin/sh`; a `command` is typed into it
like keystrokes. See [terminals.md](terminals.md).

## Routes

| Route                                                     | Who                       | Session from                |
| --------------------------------------------------------- | ------------------------- | --------------------------- |
| `POST /v1/agent/tools`                                    | an agent, on this machine | its session credential ONLY |
| `POST /v1/sessions/:sessionId/surfaces/terminals/tools`   | a person (CLI, app)       | the path; `terminal` grant  |
| `POST /v1/sessions/:sessionId/surfaces/browser/tools`     | a person                  | the path; `browser` grant   |
| `POST /v1/sessions/:sessionId/surfaces/terminals/control` | a person: control         | the path; `terminal` grant  |
| `POST /v1/sessions/:sessionId/surfaces/browser/control`   | a person: control         | the path; `browser` grant   |
| `GET /v1/sessions/:sessionId/surfaces/terminals/control`  | a person: who drives what | the path; `terminal` grant  |
| `GET /v1/sessions/:sessionId/surfaces/browser/control`    | a person: who drives what | the path; `browser` grant   |

A control request is `{ action: 'takeover' | 'handback' | 'handover', key }` and answers
`SurfaceControlView { sessionId, driving[], takeovers[], handed[], opened[], asked[] }` for that kind.
`opened` and `asked` default to `[]`, so a newer app reads an older daemon.

Control changes are published on the session's journal, so `/v1/events` streams them:
`surface.driving` (`SurfaceDrivingSchema`, carrying `until` — show the marker while `now < until`, and
`incognito` for an incognito page), `surface.takeover`, `surface.handback`, `surface.handed`,
`surface.opened` (`SurfaceOpenedSchema`) and `surface.asked` (`SurfaceAskedSchema`). The daemon replays its
journal on start, so a takeover, a hand-over, an open or an ask outlives a restart.

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
- The CDP port listens on loopback and accepts no cross-origin WebSocket (`--remote-allow-origins` is
  gone; the worker sends no `Origin`).

## What is enforced, and where

1. **An agent reaches only its own session.** `POST /v1/agent/tools` names no session anywhere: the
   daemon hashes the credential presented on `x-fy-session-capability` and finds the one LIVE session
   whose stored hash matches (constant-time). The call schema is strict, so a body `sessionId` is
   refused; `x-ferretry-session-id` is not read. Surfaces are looked up in that session's listing only.
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
   routes. A person is never asked.
6. **Take over / hand back, per tab and per terminal.** While a person holds a surface, every agent tool
   call on THAT surface is refused ("A person has taken over %terminal:dev; wait or ask them."); the
   agent keeps working everywhere else. The check is repeated inside the page's own queue, so a takeover
   landing while an act waits its turn still wins; an agent's `terminal.wait` stops the moment the
   terminal is taken over. An act already running when the takeover lands finishes (a page load is
   bounded at 45 s); several people typing into one terminal at once is fine.
7. **Audit.** Every call writes one `agent.tool` record: tool, surface name, outcome, lengths and
   `incognito` — never typed text, a URL's path or query (host only), or a selector over 120 characters.
   A refused credential or a body that is not a call is recorded too (`reason`). Takeovers and
   hand-overs write `surface.control`. Identical successes fold per minute like all activity.
8. **Bounds.** Text 16 KiB, 64 keys, 2000 lines read, 64 KiB returned, a 25 s wait per request (a client
   loops up to 120 s), URLs `http`/`https` only and 2 KiB, selectors 1 KiB; terminal creation is
   serialized, so two opens racing for one name leave one terminal.

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

MCP tool names use `_` (`terminal_open`), because provider tool APIs refuse `.`; each maps one-to-one to
the wire tool (`terminal.open`). A refusal comes back as a tool result with `isError: true` and the
daemon's sentence, so the model reads it. The server reads lines up to 1 MiB and drops longer ones.
