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

Two of the five types render as pictures. **The other three are shown as their own escaped source,
with the limitation printed on screen.** That is the current build, not a bug to work around:

| `type:`   | Today                                       |
| --------- | ------------------------------------------- |
| `svg`     | renders as a picture                        |
| `image`   | renders as a picture (raster only)          |
| `html`    | shown as source — **nothing executes**      |
| `mermaid` | shown as source — no renderer in this build |
| `lottie`  | shown as source — no player in this build   |

So: reach for `svg` when you want a diagram someone will actually see. Writing `mermaid` today gets
your reader a code listing, which is sometimes still the right call — just choose it knowingly.

**Do not write `type: html` expecting interactivity.** No JavaScript in it will ever run. If you need
to show HTML, an ordinary `html` code fence says the same thing with less ceremony.

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
   the visible caption, so write it for someone who cannot see the picture. "Diagram" is not a
   description; "The pairing handshake, browser to daemon to browser" is.
4. A line that is exactly `---` separates the headers from the payload.

`mime:` is required for `type: image`, and forbidden everywhere else. Allowed values:
`image/png`, `image/jpeg`, `image/gif`, `image/webp` — **and the bytes must actually be that type**,
because the file is checked against its own magic number. AVIF is not accepted. The payload is
base64; wrapping it across lines is fine.

If any of that is wrong, your block renders as a plain code fence. It will not warn you.

## The reader has to press a button

**Your illustration does not draw itself.** The block offers a **Render illustration** control, and
**no browser image decoder mounts until the reader presses it**. Your block is still read
automatically — the header, the base64, the container's records — so inputs that fail those admission
checks are refused whether or not anybody presses anything. They are a signature, record ordering, a
terminal shape and the declared size; a file can pass all of them and still be corrupt inside, which
the browser finds out only when it decodes. What the press gates is that decode: the size of a
payload is bounded, the work of drawing it is not, and you are not the person whose device pays.

Two consequences worth designing around:

- Write an `alt:` that stands on its own, because for many readers it is all there will be.
- Approval is to the exact bytes, so **any** change while your message streams withdraws it and the
  block returns to **Render illustration**. There is no Reload to press afterwards; once the stream
  settles the reader makes a fresh choice. (A reader who presses mid-stream sees whatever your SVG
  amounted to at that moment, and then gets the offer again when the next bytes land.)

## Limits

| `type:`   | Payload cap                       |
| --------- | --------------------------------- |
| `html`    | 200 KiB                           |
| `svg`     | 100 KiB, and at most 500 elements |
| `mermaid` | 20,000 characters                 |
| `lottie`  | 1 MiB                             |
| `image`   | 2 MiB decoded                     |

Anything that reaches a decoder is also capped at **8192 pixels on either axis and 16,777,216 pixels
in total**. The two limits are independent, so 4096 × 4096 and 8192 × 2048 are both fine and
8192 × 8192 is not. For a raster that is read from the file's own header; for an SVG it is
the `width`, `height` and `viewBox` you declare.

**No animation.** An animated PNG, GIF or WebP is refused, because this build has no pause control
and will not show you a loop nobody can stop. Use a still frame.

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

A caption (your `alt`), a **Render illustration** control, a **Source** button that shows exactly
what you wrote, and a **Fullscreen** button; once rendered, **Reload** takes the Render control's
place. If the browser cannot decode your payload, the block says so and opens the source instead of
showing an empty frame.

## Before you paste one

- Is this a conversation? If it is a file, stop.
- Is `type:` the first line?
- Does `alt:` describe the picture to someone who cannot see it — and would it still serve if nobody
  pressed Render?
- For `svg`: does it begin with `<svg`, carry a resolvable `width`/`height` or `viewBox`, stay under
  8192 on each axis and 16,777,216 pixels in total, and reference nothing external?
- For `image`: is `mime:` present, raster, still, and actually the type the bytes are?

The full contract, the threat model and the declared gaps are in
[docs/fy-render.md](../../../docs/fy-render.md).
