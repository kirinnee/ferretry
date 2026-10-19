# Hypermedia

A ferret explains with more than words when words are not enough: a Mermaid diagram of a flow, an
SVG drawing, a small interactive HTML page, or a video, recording, PDF or picture from its workspace,
rendered inline in the Chat transcript. **Hypermedia** is the per-ferret switch that tells a ferret it
may — and should, when an idea is not straightforward — communicate that way.

This page is the contract for the switch and the instruction it injects. The markup itself is
**not a new grammar**: it is the existing `fy-render` fence, whose grammar, caps, sinks and declared
gaps are owned by [docs/fy-render.md](fy-render.md). References (`@file`, `:agent`, …) stay owned by
[docs/reference-standard.md](reference-standard.md); a media `src: @path` uses the same `@path` form
and the same filesystem proof.

## The switch

| Fact                    | Where                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| A ferret's switch       | `config.hypermedia` on its session document; **absent means on**                              |
| What a launch is handed | `FY_HYPERMEDIA=1` or `0` in the pane environment                                              |
| Who reads it            | the runtime wrapper, which appends the instruction to the system prompt iff it is `1`         |
| Changing it             | `PATCH /v1/sessions/:sessionId/hypermedia {enabled}` — `operator`                             |
| The UI                  | Info › Runtime "Hypermedia" row, Actions › "Hypermedia" toggle, an icon on the session header |

- **On by default for every new ferret**, interactive and agent alike — the start and the adopt of an
  existing conversation both record `hypermedia: true`.
- **A ferret that existed before the switch** has no `config.hypermedia` and no stored variable. Both
  read as on, so it is instructed **at its next launch** (restart, resume or revive) unless the owner
  turns it off first.
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
(`packages/fleet/src/lib/wrappers.ts`): the person's own appended instruction, then Ferretry's tools and
settings rules, then each per-ferret section whose switch the daemon set to `1` in that ferret's launch
environment, in this order: hypermedia (`FY_HYPERMEDIA`), Pack mode (`FY_PACK`,
[pack-mode.md](pack-mode.md)), lessons (`FY_LEARNING_PASSIVE`, [learning.md](learning.md)). A restart,
resume or revive runs the same wrapper with the same stored environment, so it keeps them. A wrapper run
by hand, where nothing set the switches, carries no section.

## The injected instruction

Exactly this, from `HYPERMEDIA_INSTRUCTION` in `packages/fleet/src/lib/account/fixed-layer.ts`. It is
in every turn's context, so it is kept short; change it there and here together.

````text
Hypermedia: when an idea is not straightforward — a flow, an architecture, a state machine, a comparison, a layout, a change over time — show it in your chat reply as well as saying it. Do not overdo it: a simple answer stays plain text, and one clear picture beats several. Write a fenced block whose info string is exactly fy-render: line 1 `type: <type>`, line 2 `alt: <one-line description>`, then a line `---`, then the payload.
- mermaid: Mermaid source (flowchart, sequenceDiagram, stateDiagram-v2, …).
- svg: one self-contained <svg>…</svg>; no script, foreignObject, use or external links.
- html: one self-contained interactive page with inline CSS and JS; it runs sandboxed, so load nothing from the network.
- image, video, audio, pdf: put `src: @path/in/your/workspace` or `src: https://…` before `---`, and no payload.
Example:
```fy-render
type: mermaid
alt: How a request reaches the daemon
---
flowchart LR
  Phone --> Relay --> Daemon
```
The reader taps Render to show it. Chat only: never write fy-render into files, docs, commits or PR text.
````

## The supported forms

Every form is an `fy-render` fence (grammar: [fy-render.md § The grammar](fy-render.md#the-grammar)).
A block the grammar refuses renders as an ordinary escaped code fence, so a malformed block never
breaks the transcript. Nothing decodes, downloads or runs until the reader presses **Render**
([fy-render.md](fy-render.md#no-browser-decoder-runs-until-the-reader-asks)).

| `type:`   | Payload / header                    | Renders as                                                                   |
| --------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `mermaid` | Mermaid source                      | a diagram, compiled in the sandbox frame, theme following light/dark         |
| `svg`     | one `<svg>` document                | a picture through the measured `<img>` sink — never inline SVG               |
| `html`    | one self-contained page             | an interactive page in an opaque-origin sandbox frame with its own policy    |
| `image`   | `src:` — or `mime:` + base64 inline | a picture; an https image needs CORS from its host, else a link row          |
| `video`   | `src:`                              | the browser's native player (https plays directly)                           |
| `audio`   | `src:`                              | the browser's native player (https plays directly)                           |
| `pdf`     | `src:`                              | a file row with Open / Download; an https PDF is a link (no in-frame viewer) |

`src:` is one of two things, and nothing else:

- **`@path`** — a file in the ferret's workspace, written and resolved exactly as an `@file`
  reference is: session-relative, `./`-relative, or absolute inside the session's folder. It is read
  through the session filesystem route **as the reader**, so the reader's own grants decide it
  ([grants.md](grants.md) — `filesystem` _use_), the same as opening the file in the workspace. The
  bytes become a short-lived object URL; no daemon URL or credential ever reaches a media element.
  A workspace file is capped at 1 MiB, the daemon's per-file view limit; a larger one shows a
  "too large" row.
- **`https://…`** — a link the reader's browser fetches as soon as the block is near the screen.

A file that is missing, unreadable, over its cap or denied to this reader renders a file row that
says which — never a broken player and never the denied bytes.

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
