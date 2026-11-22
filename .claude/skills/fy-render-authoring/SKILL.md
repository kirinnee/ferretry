---
name: fy-render-authoring
description: Write a rich Ferretry chat message — Markdown with rich parts (terminal, chart, mermaid, animation, tabs…), references, and fy-render blocks for pictures, media, maps and live tasks. Use when you want to show an idea in a conversation instead of only saying it — and read the prohibition first, because fy-render must NEVER appear in documentation, handovers, READMEs, specs, source files, or exported artifacts.
---

# Writing a rich chat message

## STOP — this is conversation-only

**NEVER use `fy-render` when writing or editing documentation, handovers, READMEs, specs, source
files, or exported artifacts.** Use the document's native format and ordinary static assets instead.

A Mermaid diagram in a document is an ordinary `mermaid` fenced block. A picture in a README is an
image file and a link to it. An `fy-render` block in any of those places renders as nothing but raw
text to every reader who is not looking at a Ferretry transcript, and it is refused mechanically:
`scripts/validate/no-fy-render-in-docs.sh` fails the commit that puts a fence opener anywhere except
this file, `docs/fy-render.md` and `docs/hypermedia.md`.

Use it in **one** place: a message you are writing into a chat, right where the explanation is.

## The guide is not in this file

There is one guide, and a ferret reads the same one you do:

- **`fy render guide`** prints the overview; **`fy render guide <topic>`** prints one topic: `terminal`, `filetree`,
  `editor`, `chart`, `mermaid`, `animation`, `tierlist`, `alignment`, `tabs`, `references`, `svg`, `html`, `map`,
  `image`, `video`, `audio`, `pdf`, `lottie`, `task`, `board`.
- Its source is the `## Guide for agents` section of [docs/hypermedia.md](../../../docs/hypermedia.md#guide-for-agents).
  Edit it there, then run `bun packages/plugins/conversation/tests/support/guide-text/generate.ts`
  (`guide-drift.test.ts` fails a commit where the copy in the binary disagrees).
- **`fy render check <file|->`** is the doccheck: write the message to a file, run it, and fix every `line N:` it
  prints before you send. It exits 1 on an error. Nothing runs it for you.

## The three shapes, in one screen

1. **Markdown** — headings, lists, tables, code, links (`https://`, `mailto:` and `#heading` only). Raw HTML is shown as
   text and a Markdown image is not drawn.
2. **A part** — a fence named for it: `terminal`, `filetree`, `editor`, `chart`, `mermaid`, `animation`, `tierlist`,
   `alignment`; `:::tabs` and `:::accordion` hold prose. A part with a mistake shows as its source with the problem named.
3. **An `fy-render` block** — for a picture, media, map, live task or interactive page: info string exactly `fy-render`,
   `type:` the first line, a required one-line `alt:`, a line `---`, then the payload.

```fy-render
type: svg
alt: A ten by ten square, filled solid
---
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>
```

A broken `fy-render` block renders as a plain code fence and does not warn you — that is what `fy render check` is for.

References are plain text, never links: `:agent @file &F12 ^A3 /skill $skill %terminal:dev %browser:app`. The reader's
app proves each one before it becomes a link ([docs/reference-standard.md](../../../docs/reference-standard.md)).

## Before you send

- Is this a conversation? If it is a file, stop.
- Did `fy render check` print nothing but "no problems found"?
- Does every `alt:` describe the picture to someone who cannot see it?
- Did you leave colours to the reader's theme (no `%%{init}%%`, no `color:` in a chart)?

The contract, the threat model and the declared gaps of the `fy-render` block are in
[docs/fy-render.md](../../../docs/fy-render.md).
