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

`terminal.list` · `terminal.open(name, folder?, command?)` · `terminal.send(name, text?, keys?)` ·
`terminal.read(name, lines?)` · `terminal.wait(name, text | exit, timeoutMs?)` · `terminal.close(name)` ·
`browser.list` · `browser.open(name, url?)` · `browser.navigate(name, url)` ·
`browser.click(name, selector)` · `browser.type(name, selector, text)` ·
`browser.read(name, mode: text | a11y, selector?)` · `browser.screenshot(name)` · `browser.close(name)`.

The wire body is `AgentToolCallSchema` (`packages/protocol/src/lib/agent-tools.ts`); the answer is
`AgentToolResultSchema`. The same actions are `fy terminal …` and `fy browser page …`.

## Routes

| Route                                                     | Who                       | Session from               |
| --------------------------------------------------------- | ------------------------- | -------------------------- |
| `POST /v1/agent/tools`                                    | an agent, on this machine | its session credential     |
| `POST /v1/sessions/:sessionId/surfaces/terminals/tools`   | a person (CLI, app)       | the path; `terminal` grant |
| `POST /v1/sessions/:sessionId/surfaces/browser/tools`     | a person                  | the path; `browser` grant  |
| `POST /v1/sessions/:sessionId/surfaces/terminals/control` | a person: take over/back  | the path; `terminal` grant |
| `POST /v1/sessions/:sessionId/surfaces/browser/control`   | a person: take over/back  | the path; `browser` grant  |
| `GET /v1/sessions/:sessionId/surfaces/control`            | a person: who drives what | the path                   |

Control changes are published on the session's journal, so `/v1/events` streams them:
`surface.driving` (`SurfaceDrivingSchema`, carrying `until` — show the marker while `now < until`),
`surface.takeover` (`SurfaceTakeoverSchema`) and `surface.handback` (`SurfaceHandbackSchema`).

## What is enforced, and where

1. **An agent reaches only its own session.** `POST /v1/agent/tools` names no session anywhere: the
   daemon hashes the credential presented on `x-fy-session-capability` and finds the one live session
   whose stored hash matches (constant-time). The call schema is strict, so a body `sessionId` is
   refused; the `x-ferretry-session-id` header is not read. A surface is looked up in that session's
   own listing only.
2. **Only on this machine.** The agent route is served to the host's own admin token arriving over
   loopback (`admin-token`, `privilegedOnly`) — never a paired device, a warden, or the relay.
3. **A person's route refuses an agent that says it is one** (`peer:` / `warden:` actors) and points it
   at its own route, which is the one that checks takeover and the machine's switches.
4. **What agents may control.** Every agent call first asks `AgentControlPolicy.allows(kind)` — the
   machine's "What agents may control" switches, read per call. A refusal names the setting.
5. **Take over / hand back.** While a person holds a surface, every agent tool call on it is refused
   with "A person has taken over %terminal:dev; wait or ask them." Held in memory, keyed by surface id.
6. **Audit.** Every call writes one `agent.tool` record: tool, surface name, outcome, and lengths —
   never the typed text, a URL's path or query (host only), or a selector longer than 120 characters.
   Takeovers write `surface.control`. Identical successes fold per minute like all activity.
7. **Bounds.** Text 16 KiB, 64 keys, 2000 lines read, 64 KiB returned, a 25 s wait per request (a
   client loops up to 120 s), URLs `http`/`https` only and 2 KiB, selectors 1 KiB.

## Declared gaps

- **The shared admin token.** An agent runs as the same user as the daemon and can read the admin
  token, as every in-pane `fy` command does. Such an agent can call a person's route without
  identifying itself and act past a takeover. This is the boundary `isHumanAdminActor` already
  states — for honest clients, not a sandbox — and the shell an agent is given is not a containment.
- **Same-user processes** can read each other's environment, so one agent that sets out to can read
  another session's credential. The credential holds an honest agent to its own session; it does not
  isolate agents from each other at the OS level.
- **A terminal's folder** is where the shell starts, not a boundary: the shell can `cd` anywhere the
  user can.
