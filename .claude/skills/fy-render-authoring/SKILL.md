---
name: fy-render-authoring
description: Write an fy-render block so a diagram or picture renders inline in a Ferretry chat message. Use when you want to show an illustration in a conversation — and read the prohibition first, because fy-render must NEVER appear in documentation, handovers, READMEs, specs, source files, or exported artifacts.
---

# Authoring an `fy-render` block

## STOP — this is conversation-only

**NEVER use `fy-render` when writing or editing documentation, handovers, READMEs, specs, source
files, or exported artifacts.** Use the document's native format and ordinary static assets instead.

A Mermaid diagram in a document is an ordinary `mermaid` fenced block. A picture in a README is an
image file and a link to it. An `fy-render` block in any of those places renders as nothing but raw
text to every reader who is not looking at a Ferretry transcript, and it is refused mechanically:
`scripts/validate/no-fy-render-in-docs.sh` fails the commit that puts a fence opener anywhere except
this file and `docs/fy-render.md`.

Use it in **one** place: a message you are writing into a chat, right where the explanation is.

## What renders today

Every type renders **by itself, inline in the message**, as soon as it scrolls near the screen — no
button, no card, no caption:

| `type:`   | Today                                                                       |
| --------- | --------------------------------------------------------------------------- |
| `svg`     | renders as a picture                                                        |
| `image`   | renders as a picture (raster only) — inline base64, or from `src:`          |
| `mermaid` | renders as a diagram — drawn in a sandbox, shown as a picture               |
| `lottie`  | plays as an animation, with Pause and Play                                  |
| `html`    | **runs** as an interactive page in an isolated frame — your JavaScript runs |
| `video`   | plays in the browser's own player, from `src:`                              |
| `audio`   | plays in the browser's own player, from `src:`                              |
| `pdf`     | a workspace PDF opens in a new tab or downloads; an https PDF is a link     |

So write `mermaid` when a flowchart, sequence or state diagram is what you mean; you no longer have
to hand-draw it as `svg`. Reach for `svg` when you want exact control over the drawing, `lottie` when
motion genuinely helps, and `html` when the reader should be able to **do** something — drag a
slider, step through states, toggle a comparison.

### Writing `html` that works

Your page runs in an opaque-origin frame with its own strict policy. Design for exactly that:

- **One self-contained document.** Inline `<style>` and inline `<script>` (classic or
  `type="module"`) run, in order, after your markup is in place — so you can query the DOM at the top
  level. `DOMContentLoaded` and `load` are dispatched once for you.
- **No network, at all.** `fetch`, XHR, WebSocket, external scripts, stylesheets, fonts and remote
  images are all refused. Images, media and fonts may only be `data:` or `blob:` URIs you build
  yourself. There is no CDN: no React, no D3 — write plain DOM or `<canvas>`.
- **No storage, no cookies, no `eval`, no `new Function`, no forms, no popups, no `alert`.**
- **Never navigate.** Setting `location`, following a link inside the frame or building a meta
  refresh stops the page: the block replaces it with a note and the source. Authored `<meta>`,
  `<base>` and `<link>` elements are removed before the page runs.
- **Respect the reader's theme.** The page is frameless and defaults to the conversation's own
  background, text colour and font, in the reader's light or dark `color-scheme` — so it reads as
  part of the message. If you set your own background, set your own text colour too.
- **Keep it short.** Inline, the frame grows to your page's height up to 640px and then scrolls; the
  reader can open it fullscreen. It stops after ten minutes, with Run again to restart it.
- **Do not reach for `html` for a static picture.** A diagram is `mermaid` and a drawing is `svg`;
  they are cheaper, they need no scripts, and they are what a reader expects.

### Showing a file or a link with `src:`

`image`, `video`, `audio` and `pdf` can name their bytes instead of carrying them:

```fy-render
type: video
alt: The new onboarding flow, recorded at 390px
src: @recordings/onboarding.mp4
---
```

- **`src: @path`** is a file in your session's workspace, written exactly as an `@file` reference —
  `@relative/path`, `@./relative/path`, or `@/absolute/path` inside your folder — **without** a
  `:line`. It is read with the **reader's** access, so a file they could not open from the Files tab
  shows a file row saying so. Gitignored files and protected secrets are never served. **At most 1 MiB**:
  a longer recording will show a "too large" row, so trim it or link it.
- **`src: https://…`** is fetched by the reader's browser as soon as the block is near the screen, and
  the host sees their address — so link only hosts you would be comfortable having the reader's
  browser contact. Video and audio play directly. An https **image** must come from a host that allows
  cross-origin reads (many CDNs and `raw.githubusercontent.com` do); otherwise the reader gets a
  link. An https **PDF** is always a link. `http:`, `data:` and `blob:` are refused.
- **Nothing after `---`.** A `src:` block has an empty payload. For `image`, use `src:` **or**
  `mime:` with base64, never both.
- File types: `image` — png, jpg/jpeg, gif (still), webp; `video` — mp4, m4v, webm, ogv, mov;
  `audio` — mp3, m4a, aac, wav, ogg, oga, opus, weba, flac; `pdf` — pdf.

### What "renders in a sandbox" means for you

`mermaid` and `lottie` are handed to a trusted library running in an isolated frame that has no
access to the app, no storage, and no ability to fetch anything for itself. **For these two, your
payload is data, never code.** Two consequences you should design around:

- **A Lottie expression is refused.** A string-valued `"x"` key anywhere in the animation — the field
  a full player would compile and run as JavaScript — makes the whole block fail to parse. Bezier
  easing handles (`{"x":[0.833]}`) and separated-dimension positions are numbers and objects, not
  code, and are perfectly fine. Export without expressions.
- **A Lottie animation cannot load remote assets.** Embed images as `data:` URIs or leave them out;
  anything fetched from a URL will silently not appear.

### It renders inline, as if it were part of the message

There is no offer and no Render button. A block draws itself where it sits, sized to the message
column, once it comes near the screen; a block far down a long transcript costs nothing until the
reader scrolls toward it. There is no caption under it and no status line — the picture is the
explanation, so write the prose around it as you would around any figure.

Two things follow for you as an author. **Your `alt:` is still required**, but it is now the
picture's accessible description rather than a visible caption: write it for someone who cannot see
the picture. And **while your message streams**, the block waits for your bytes to stop changing for
a moment before it redraws, so a half-written diagram is not redrawn on every token.

## The shape

```fy-render
type: svg
alt: A ten by ten square, filled solid
---
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>
```

Four rules, and every one of them is a parse error if you break it:

1. The info string is exactly `fy-render`. Not `fy-render svg`, not `fy-render-diagram`.
2. **`type:` is the first line.** Always. It is what makes a block readable from its opening line.
3. **`alt:` is required** — one line, at most 200 characters. It is the accessible description and
   what a screen reader says for the picture, so write it for someone who cannot see it. "Diagram" is not a
   description; "The pairing handshake, browser to daemon to browser" is.
4. A line that is exactly `---` separates the headers from the payload.

`mime:` is required for `type: image`, and forbidden everywhere else. Allowed values:
`image/png`, `image/jpeg`, `image/gif`, `image/webp` — **and the bytes must actually be that type**,
because the file is checked against its own magic number. AVIF is not accepted. The payload is
base64; wrapping it across lines is fine.

If any of that is wrong, your block renders as a plain code fence. It will not warn you.

## If it cannot be drawn

If the browser cannot decode your payload, or Mermaid cannot parse your diagram, the block quietly
becomes an ordinary code block showing exactly what you wrote. Nothing in the app's voice says it
failed — so check that your diagram actually drew. When the renderer itself failed to load (not your
bytes), a small **Try rendering again** link sits under the code.

## Limits

| `type:`   | Payload cap                                                  |
| --------- | ------------------------------------------------------------ |
| `html`    | 200 KiB                                                      |
| `svg`     | 100 KiB, and at most 500 elements                            |
| `mermaid` | 20,000 characters                                            |
| `lottie`  | 1 MiB                                                        |
| `image`   | 2 MiB decoded                                                |
| `src:`    | no payload; a workspace file ≤ 1 MiB, an https image ≤ 2 MiB |

Anything that reaches a decoder is also capped at **8192 pixels on either axis and 16,777,216 pixels
in total**. The two limits are independent, so 4096 × 4096 and 8192 × 2048 are both fine and
8192 × 8192 is not. For a raster that is read from the file's own header; for an SVG it is
the `width`, `height` and `viewBox` you declare.

**No animated raster.** An animated PNG, GIF or WebP is refused, because an `<img>` has no pause
control and the build will not show you a loop nobody can stop. Use a still frame — or `lottie`,
which is the one animated type here and does have Pause and Play. A Lottie animation starts paused
for a reader who has asked for reduced motion, and stops on its own after two minutes of playback,
with Replay to start it again.

An SVG is also refused if it declares a `<!DOCTYPE>` or `<!ENTITY>`, contains `<script>`,
`<foreignObject>` or `<use>`, uses more than 32 filter primitives, has an unterminated comment or
tag, or does not begin with an `<svg>` element. Give the root a `width`/`height` in plain numbers or
`px`, or a `viewBox` — `em`, `vh`, `%` without a `viewBox`, and `calc()` are all refused, because a
size that cannot be resolved cannot be bounded.

## Writing an SVG that actually shows up

Your SVG is rendered as the `src` of an `<img>`, as a `data:image/svg+xml,…` URL. That has
consequences worth knowing before you spend effort on markup that will be discarded:

- **Reference nothing outside the payload.** No web fonts, no `<image href="https://…">`, no external
  stylesheet, no external filter or mask. In that exact sink, measured in Chrome 150, none of them
  loaded — every external reference across 25 hostile vector families produced zero requests. Treat
  that as the authoring rule everywhere; treat it as _evidence_ only for Chrome 150 in an
  `<img src="data:image/svg+xml,…">`. **Firefox, WebKit and Safari are unmeasured**, and the same
  bytes in an active top-level SVG document did fetch, so the property belongs to the sink and not to
  your markup.
- **Do not rely on script**, including `onload` and `onclick` attributes. Under the same measurement,
  script and script event handlers did not run. Self-contained SMIL or CSS animation is a different
  capability and was not measured either way, so do not read this as "the picture cannot move".
- **Same-document references are fine; `<use>` is not.** A `url(#id)` pointing at something defined
  inside your own payload — a `<marker>` arrowhead, a `<clipPath>`, a gradient or pattern fill —
  resolves normally, so you can draw arrows the ordinary way rather than hand-building polygons.
  `<use>` stays refused (a cycle detector is not worth building for a chat illustration), and every
  reference OUT of the payload stays forbidden. This is scoped to the measured
  `<img src="data:image/svg+xml,…">` sink and says nothing about inline SVG.
- **Text needs a real font stack** — `font-family="sans-serif"` or similar — because your reader's
  installed fonts are all you get.
- Give the root an explicit `viewBox` so it scales into the block instead of being cropped.
- Colours are yours to pick and do not follow the app's theme. Prefer marks that read on both a light
  and a dark background, or set an explicit background rectangle.

The validator **accepts** most of the things above and they simply do not render — it bounds size and
refuses a short list of constructs, it does not tell you what will appear. If your picture comes out
blank or incomplete, an external reference is the first thing to check.

## What the reader gets

The picture, inline. Hovering it — or a long press on a phone, or tabbing to it — shows two small icons
in its corner: **Source** (exactly what you wrote) and **Fullscreen**. A Lottie animation plays by
itself while on screen and adds a **Pause/Play** icon; under a reduced-motion preference it starts
paused with Play showing. An `html` page runs by itself, frameless, painted with the conversation's
own background, text colour and font, so leave its background unset unless you need one. A `pdf` is
a compact file row — name, size, **Open** and **Download** — never an embedded viewer. An animation
stops after two minutes and an `html` page after ten; each leaves one muted line with a way to run it
again.

## Before you paste one

- Is this a conversation? If it is a file, stop.
- Is `type:` the first line?
- Does `alt:` describe the picture to someone who cannot see it — and would it still serve if nobody
  pressed Render?
- For `svg`: does it begin with `<svg`, carry a resolvable `width`/`height` or `viewBox`, stay under
  8192 on each axis and 16,777,216 pixels in total, and reference nothing external?
- For `image`: is `mime:` present, raster, still, and actually the type the bytes are — or is it a
  `src:` with nothing after `---`?
- For `html`: is it one self-contained page with no network, no navigation and no external library?
- For `src: @path`: is the file under 1 MiB, in your workspace, and not gitignored?

The full contract, the threat model and the declared gaps are in
[docs/fy-render.md](../../../docs/fy-render.md).
