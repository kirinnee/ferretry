# Hypermedia

A ferret explains with more than words when words are not enough: a Mermaid diagram of a flow, an
interactive chart of numbers, an SVG drawing, a static HTML fragment, or a video, recording, PDF or
picture it made or found, rendered inline in the Chat transcript. **Hypermedia** is the per-ferret switch that tells a ferret it
may — and should, when an idea is not straightforward — communicate that way.

This page is the contract for the switch and the instruction it injects. The markup itself is
**not a new grammar**: it is the existing `fy-render` fence, whose grammar, caps, sinks and declared
gaps are owned by [docs/fy-render.md](fy-render.md). References (`@file`, `:agent`, …) stay owned by
[docs/reference-standard.md](reference-standard.md); a media `src: @path` uses the same `@path` form
and the same filesystem proof.

## The switch

| Fact                    | Where                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| A ferret's switch       | `config.hypermedia` on its session document; **absent means the mode's default**              |
| What a launch is handed | `FY_HYPERMEDIA=1` or `0` in the pane environment                                              |
| Who reads it            | the runtime wrapper, which appends the instruction to the system prompt iff it is `1`         |
| Changing it             | `PATCH /v1/sessions/:sessionId/hypermedia {enabled}` — `operator`                             |
| The UI                  | Info › Runtime "Hypermedia" row, Actions › "Hypermedia" toggle, an icon on the session header |

- **The default follows the mode.** An **interactive** ferret — one a person is talking to — is on by default: the start and the adopt record `hypermedia: true`. A ferret that runs **auto** (a worker, and the background helpers: wardens, learning miners) is **off** by default, because nobody is reading its chat to look at a picture and the instruction is context it pays for every turn. The start of an auto ferret records `hypermedia: false`. Only the owner's explicit switch overrides the default, in either direction, and `sessionHypermediaEnabled` in `packages/protocol` is the one place that resolves it for the daemon and the PWA.
- **A ferret that existed before the switch** has no `config.hypermedia` and no stored variable, so it reads as its mode's default: an existing interactive ferret is instructed at its next launch (restart, resume or revive) unless the owner turns it off first, and an existing auto ferret is **not** instructed at its next launch unless the owner explicitly turned it on.
- **A change takes effect at the next launch, and the answer says so.** A running ferret's
  environment and its system prompt were fixed when it started, so the switch never re-instructs a
  running ferret and never sends it a message — unlike passive learning, there is nothing here worth
  a turn. The PATCH answer's `note` names whether a restart is needed.

### Delivered as system instructions, per ferret

Every Ferretry instruction is in the **appended system prompt** — Claude's `--append-system-prompt`,
Codex's `developer_instructions` — because a harness weighs that far above a tools server's MCP
`initialize` instructions, which an agent can ignore. (Hypermedia used to ride those; it no longer does,
and the tools server now says one line.)

A runtime's wrapper is materialised once and serves every ferret launched on it, so a static launch
argument could not differ per ferret. The wrapper therefore **composes the one value at exec time**
(`packages/fleet/src/lib/wrappers.ts`): the person's own appended instruction, then Ferretry's tools,
settings rules and notify rule (always on), then each per-ferret section whose switch the daemon set to `1` in that ferret's launch
environment, in this order: hypermedia (`FY_HYPERMEDIA`), Pack mode (`FY_PACK`,
[pack-mode.md](pack-mode.md)), lessons (`FY_LEARNING_PASSIVE`, [learning.md](learning.md)). A restart,
migration, resume or revive runs the same wrapper with the same stored environment and the session's
recorded mode, so it keeps them; a switch the store never recorded is derived from the session's record
at each launch rather than read as off (`LaunchEnvironmentStore`). A wrapper run by hand, where nothing
set the switches, carries no section.

**A resumed conversation hears the new sections.** Claude Code records a conversation's system prompt at
its first request and, by default, replays that record on every later request and `--resume` even when a
later launch passes different text (`--system-prompt-snapshot`). Every Restart, migration, revive and
import relaunches into the SAME conversation, so a ferret started before a section existed — or with its
switch off — was never told, and "takes effect at the next restart" was false. A Claude agent runtime's
wrapper therefore passes `--system-prompt-snapshot=off` wherever the installed Claude lists that flag in
its `--help` (an older one would refuse a flag it does not know). Codex reads `developer_instructions`
afresh at every launch.

**A ferret can check.** `fy instructions` (or the `instructions` MCP tool) reports which sections this
ferret launched with, read from the same variables the wrapper read, and for each one that is off, where
the owner turns it on: the ferret's Actions › Hypermedia / Pack mode / Passive learning, effective from its
next restart. A ferret should check before telling the owner a section is missing.

## The injected instruction

Exactly this, from `HYPERMEDIA_INSTRUCTION` in `packages/fleet/src/lib/account/fixed-layer.ts` (with the binary's
name for `fy`). It is in every turn's context, so it is kept short: mermaid, svg and html are taught whole, chart keeps
one line, and every type's full spec is one `fy render guide <type>` away, printed from
[fy-render.md](fy-render.md). Change it there and here together.

````text
Hypermedia: when you teach, explain, compare or walk through anything not straightforward (a flow, architecture, state machine, layout, change over time), show it as well as saying it. Do not overdo it: simple answers stay plain text.
Always inline: never publish an artifact, page, gist or link to explain, unless asked.
Let the reader drive it: step-through Next buttons, sliders, tap to reveal. One idea per step, short labels, gentle motion (honour prefers-reduced-motion).
Write a fenced block whose info string is exactly fy-render: `type: <type>`, `alt: <one line>`, a `---` line, then the payload.
- mermaid: Mermaid source (flowchart TB, sequenceDiagram, …): top-down, short labels; auto-themed, so no %%{init}%% or colours.
- svg: one self-contained <svg>…</svg> (CSS animation welcome); no script, foreignObject or external links.
- html: a fragment with inline CSS and <script> for interaction (runs isolated); no network loads.
- chart: JSON/YAML {kind: bar|line|area|pie|…, x: […], series: [{name, data}]}; full spec: `fy render guide chart`.
- map, image, video, audio, pdf: `fy render guide <type>`.
```fy-render
type: mermaid
alt: How a request flows
---
flowchart TB
  Phone --> Relay --> Daemon
```
Renders inline in chat. Chat only: never write fy-render into files, docs, commits or PRs.
````

## The supported forms

Every form is an `fy-render` fence (grammar: [fy-render.md § The grammar](fy-render.md#the-grammar)).
A block the grammar refuses renders as an ordinary escaped code fence, so a malformed block never
breaks the transcript. **An illustration never chooses its own colours.** A `chart` series asks for a
`tone` (`accent`, `good`, `warn`, `bad`, `muted`) or a palette slot `1`–`8`, and a Mermaid diagram is
painted from the same theme tokens; the reader's theme decides what each looks like, and a theme switch
repaints them. A `chart` that names a colour is refused, and a Mermaid `%%{init}%%` that sets `theme`,
`themeVariables` or `themeCSS` is ignored ([fy-render.md § Charts](fy-render.md#charts)).

A block renders by itself once it is near the screen — there is no Render button any more
([fy-render.md § Inline by default](fy-render.md#inline-by-default--the-owners-decision)).

| `type:`   | Payload / header                                  | Renders as                                                                                       |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `mermaid` | Mermaid source                                    | a diagram, compiled in the sandbox frame, painted in the reader's theme tokens                   |
| `chart`   | small JSON/YAML in the chart language             | an interactive Chart.js chart in the page, in the theme's colours; the source fence if refused   |
| `map`     | small JSON/YAML: centre, markers, lines, polygons | an inline interactive map (Leaflet, OpenStreetMap tiles); a coordinates list if it cannot draw   |
| `svg`     | one `<svg>` document                              | a picture through the measured `<img>` sink — never inline SVG                                   |
| `html`    | one self-contained fragment                       | no script: sanitized markup in a closed shadow root; with script: a live page in an opaque frame |
| `image`   | `src:` — or `mime:` + base64 inline               | a picture; an https image needs CORS from its host, else a link row                              |
| `video`   | `src:`                                            | the browser's native player (https plays directly)                                               |
| `audio`   | `src:`                                            | the browser's native player (https plays directly)                                               |
| `pdf`     | `src:`                                            | a file row with Open / Download; an https PDF is a link (no in-frame viewer)                     |

`src:` is one of three things, and nothing else:

- **`media:<file>`** — a file in the session's MEDIA folder, `$FY_MEDIA_DIR` in the agent's pane
  (`state/sessions/<id>/media` under `FY_HOME`). It is where an agent puts what it MADE to show the
  person: outside any repository, so no ignore rule decides whether it can be shown, and read through
  the same route and grant as a workspace file (`scope=media`), never secrets.

- **`@path`** — a file in the ferret's workspace, written and resolved exactly as an `@file`
  reference is: session-relative, `./`-relative, or absolute inside the session's folder. It is read
  through the session filesystem route **as the reader**, so the reader's own grants decide it
  ([grants.md](grants.md) — `filesystem` _use_), the same as opening the file in the workspace. The
  bytes become a short-lived object URL; no daemon URL or credential ever reaches a media element.
  A workspace file is capped at 1 MiB, the daemon's per-file view limit; a larger one shows a
  "too large" row.
- **`https://…`** — a link the reader's browser fetches as soon as the block is near the screen.

A file that is missing, unreadable, over its cap or denied to this reader renders a file row that
says which — and for a file the daemon will not serve, WHICH RULE refused it (the ignore file, line
and pattern, a Git failure, or the denied name) — never a broken player and never the denied bytes.

## Security

The renderer side is reviewed against [grants.md](grants.md) and the PWA content security policy in
[fy-render.md](fy-render.md) and the PR that introduces each renderer. The invariants this page
depends on:

- **The switch grants nothing.** It changes what a ferret is _told_, not what any caller may do. The
  PATCH route is an `operator` write to a session's own configuration, like rename.
- **No new path to a file.** A workspace `src:` goes through the same session filesystem route and the
  same grant check an `@file` click does; the transcript never holds a daemon URL, token or path the
  reader could not already open.
- **Agent-authored HTML runs only inside an opaque-origin frame** with no access to the app, the
  daemon, tokens or storage. What that frame can and cannot reach is stated in fy-render.md, including
  the residuals a browser-only sandbox cannot close.
