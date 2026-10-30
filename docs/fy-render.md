# `fy-render` — inline illustrations in a conversation

A fenced block an assistant can put in its own chat message so a diagram, a drawing or a screenshot
renders where the explanation is, instead of as a wall of markup the reader has to imagine.

**Read this first: one kind of block runs an author's code, and it runs it somewhere that cannot reach
the app.** `svg` and inline `image` become an `<img>` directly. `map` is drawn **in the page** by a bundled map library from a small JSON/YAML description, with
OpenStreetMap tiles as its one remote load ([Maps](#maps)). `chart` is drawn **in the page** too, by bundled Chart.js from a
small description in this package's own chart language, in the theme's colours, loading nothing
([Charts](#charts)). `mermaid` and `lottie` are handed as
**data** to a trusted library running inside an opaque-origin sandbox frame. `html` WITHOUT script is a
**static fragment**: sanitized against a strict allowlist and rendered into a closed shadow root in the
message ([The `html` fragment](#the-html-fragment)). `html` WITH script **runs**, in its own
opaque-origin frame on its own static shell, with no storage, no reach into the app, no daemon token
and no ordinary network ([The interactive `html` frame](#the-interactive-html-frame)).
`image`, `video`, `audio` and `pdf` with a `src:` header name bytes that live in the session's
workspace or behind an https link, and are read or fetched once the block is near the viewport
([Media from `src:`](#media-from-src)).

Running an interactive page is the owner's decision, made with the residual stated rather than hidden:
a frame that runs script can still navigate itself, prerender and open WebRTC, and no browser bounds a
frame's CPU or memory ([gap 16](#declared-gaps)). Static HTML stays the default an agent is told to
prefer. [handover.md](../handover.md) row 65 **stays open**: it asks for author JavaScript under an
enforceable CPU and memory bound, and a stall guard and a wall-clock lifetime are not that.

**`fy-render` is conversation-only.** It exists for live explanation between an agent and a person in
a transcript. **NEVER use `fy-render` when writing or editing documentation, handovers, READMEs,
specs, source files, or exported artifacts.** Use the document's native format and ordinary static
assets instead — a Mermaid diagram in a document is an ordinary `mermaid` fenced block, rendered by
whatever that document's own renderer supports or left as text, never an `fy-render` block. This is
not a convention: `scripts/validate/no-fy-render-in-docs.sh` fails the commit that puts a fence
opener anywhere outside the two files that teach the syntax — this one and
[the authoring skill](../.claude/skills/fy-render-authoring/SKILL.md).

---

## The grammar

The fence's info string must be the literal lowercase token `fy-render` and **nothing else**. A fence
opened as `fy-render notes` or `fy-render-x` is a different language and takes the ordinary
highlight-or-escape path, untouched.

The **delimiter** may be any form CommonMark accepts — three or more backticks, three or more tildes,
and any of those nested inside a blockquote or list item — because remark produces the same node for
all of them and the renderer therefore treats them alike.
`scripts/validate/no-fy-render-in-docs.sh` matches that same set, and
`packages/pwa/tests/unit/markdown.test.tsx` pins the agreement in both directions: a form that
renders must be a form the gate finds.

The body is a **header block**, a **boundary line**, then a **payload**:

````markdown
```fy-render
type: svg
alt: A ten by ten square, filled solid
---
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>
```
````

**Header block** — `key: value` lines, one per line, from a closed set:

| Key    | Required                                             | Value                                                                                       |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `type` | yes, **and on the FIRST line**                       | one of `html`, `svg`, `lottie`, `mermaid`, `map`, `chart`, `image`, `video`, `audio`, `pdf` |
| `alt`  | yes                                                  | ≤ 200 characters, one line, no control characters                                           |
| `mime` | for an inline `image` only                           | one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`                                 |
| `src`  | for `video`, `audio`, `pdf`; or instead of an `mime` | `@path` in the session's workspace, or an `https://` URL; ≤ 2048 characters                 |

`type` is positional, not merely present, so a block is identifiable from its opening line alone — by
a reader scrolling and by a grep. `alt` is required rather than optional so an author cannot ship an
inaccessible block by omission; leaving it out is a parse error, not a quieter render. Any other key
is a parse error, and so is a repeated one.

**`image` has two exclusive shapes**: `mime:` with an inline base64 payload, or `src:` with none.
Both together is a parse error — the reader would not know which bytes they were shown. A block
with a `src:` must have an **empty payload** (blank lines are not content).

**`src:` is one of three things and nothing else.** `media:<file>` names a file in the session's
MEDIA folder (below): a relative name with no `..`, no empty or `.` segment, no leading `/`, no
whitespace or backslash. `@path` is an `@file` reference, parsed by the
reference grammar's own token reader (`parseReferenceToken`), without a line suffix — the same
session-relative, `./`-relative or absolute-inside-the-folder forms
[reference-standard.md](reference-standard.md) defines. `https://…` is parsed by the platform's URL
parser; `http:` (a downgrade), `data:` (a second inline grammar), `blob:` (a page-local handle) and any
URL carrying `user:pass@` (a credential written into a transcript) are refused.

**Boundary line** — a line that is exactly `---`. It makes header parsing unambiguous, so a payload
may begin with anything, including a line that looks like `key: value`.

**Payload** — every byte from the line after `---` to the fence close, verbatim. The one exception is
`image`, where the base64 is whitespace-stripped, because authored base64 is line-wrapped and the
renderer needs the compact form.

### One rule for every failure

Any parse failure, any cap violation, any unknown type: the block renders as an **ordinary escaped
code fence** — the same path an unknown fence language already takes. There is no partial-render
state and no error chrome. A bad block is visually indistinguishable from a plain fence, which is
also what it is.

### Caps

Single-owned constants in `packages/pwa/src/lib/fy-render.ts`; this table and the tests read the same
numbers.

| Type      | Payload cap                      | Also refused                                                                                                                                                                                                                                                                                                          |
| --------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `html`    | 200 KiB                          | —                                                                                                                                                                                                                                                                                                                     |
| `svg`     | 100 KiB                          | `<!DOCTYPE>`/`<!ENTITY>`; `<script>`; `<foreignObject>`; `<use>`; more than 500 element opening tags; more than 32 filter primitives; a declared canvas over 8192 per axis or 16,777,216 pixels; an unterminated comment, CDATA section or tag; a payload that does not begin with `<svg>`                            |
| `mermaid` | 20,000 characters                | —                                                                                                                                                                                                                                                                                                                     |
| `map`     | 32 KiB                           | a blank payload; invalid JSON/YAML (aliases refused); more than 100 markers, 50 lines+polygons or 2,000 vertices; a coordinate off the globe; a zoom outside 0–18; a label over 80 or a popup over 500 characters — each falls back to a coordinates list, never a blank block                                        |
| `chart`   | 64 KiB                           | a blank payload; invalid JSON/YAML (aliases refused); any key the chart language does not name (a colour included); more than 12 series, 500 points a series, 500 labels, 30 frames or 10,000 points across every frame; a title over 120 or a name or label over 80 characters — each falls back to the source fence |
| `lottie`  | 1 MiB                            | invalid JSON; a non-object root; a **string-valued** `"x"` expression key at any depth, or an array containing one at any index; more than 500 layers; deeper than 64 levels                                                                                                                                          |
| `image`   | 2 MiB decoded (≈ 2.7 MiB base64) | anything that is not canonical base64; bytes that disagree with the declared MIME; a declared size over 8192 per axis or 16,777,216 pixels; animation; a container that fails the selected admission checks below                                                                                                     |
| `src:`    | no payload at all                | a workspace file over **1 MiB** (the daemon's own per-file view limit, mirrored, not chosen); an https `image` over 2 MiB; an `image` whose fetched bytes fail the same admission checks below                                                                                                                        |

**A `src:` image passes the inline image's admission, once it is read.** Its bytes do not exist at
parse time, so `FyRenderMedia` runs `fyRenderRasterRefusal` — the same function an inline payload
passes — on what the workspace read or the https fetch returned, before any decoder sees them. One
policy, two arrivals.

**The selected pre-decode admission checks, exactly.** The parser reads a format signature, walks the
container's records, and reads what those records DECLARE — dimensions, animation markers, and a
format-specific ordering and terminal shape:

- **PNG** — the signature; a first and only `IHDR` of length 13; exactly one consecutive `IDAT` run;
  no `acTL`; a zero-length `IEND` at exactly the end of the file.
- **JPEG** — `SOI`; every segment extent validated before anything inside it is read; at least one
  `SOFn` before `SOS`, max-bounded across all of them; a terminal `EOI`.
- **GIF** — the logical screen; each image descriptor fitting inside it; exactly one frame; the
  trailer as the last byte.
- **WebP** — a RIFF size matching the file; every chunk length fitting; a recognised dimension record
  long enough to read, max-bounded across all of them; no `ANIM`/`ANMF`; the walk landing exactly on
  the end.

**CRCs and compressed image content are NOT validated, and neither is anything the records do not
declare.** A file can satisfy every check above and still be rubbish inside. That is the browser
decoder's job and it happens after admission, so read "admitted" as "passed these checks", never as
"valid".

**The element count is a count of element opening tags, and means it.** It uses the full XML 1.0
`NameStartChar` production, so `<_/>`, `<:a/>` and `<À/>` all count, and it is a small lexical
scanner rather than a pattern — it advances across comments, CDATA sections, processing instructions,
declarations, quoted attribute values and closing tags, so tag-like text inside a comment is not an
element. The root's `width`, `height` and `viewBox` are read the same way: exact, unqualified
attribute names, so `data-width` and `x:width` are not `width`, and a `>` inside a quoted value does
not end the tag.

**Declared canvas rules.** Unitless and `px` lengths resolve to themselves; a percentage resolves
against the `viewBox` and is accepted only above 0% and at most 100%; omitted dimensions are accepted
only behind a bounded, positive `viewBox`; every other unit — `em`, `rem`, `vh`, `cm`, `calc()` — is
unresolvable and refused. Each axis is resolved independently before the pair is checked, so a
percentage on one axis cannot carry an oversized length on the other.

---

## Where a block renders, and where it cannot

Rendering is gated by `MarkdownProps.enableFyRender`, which **defaults to `false`**. Exactly one
production call site sets it: `AssistantProse` in
`packages/pwa/src/components/transcript-row.tsx`. Every other `<Markdown>` consumer — file previews,
warden reports, and the composer's own preview once it lands — gets the inert escaped fence
automatically by not passing it, with no new code on those surfaces.

**This structural default is the whole answer to "how does it stay conversation-only".** It is not a
rule somebody has to remember; it is a capability a surface must name deliberately.
`packages/pwa/tests/unit/fy-render-opt-in.test.ts` holds the count at one and fails on the second.

Two properties this feature must never change, and does not:

1. The Markdown pipeline has **no `rehype-raw`**, so literal HTML typed in prose renders as escaped
   text, never DOM. Adding it would execute a `<script>` typed into any chat message.
2. A fence whose info string is anything other than the exact token takes the pre-existing branch.

---

## Per type, in this build

| Type               | Renders as                                                            | Why                                                                                                          |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `svg`              | `<img src="data:image/svg+xml,…">`                                    | The measured boundary — see below                                                                            |
| `image` (inline)   | `<img src="data:{mime};base64,…">`                                    | No script surface exists in a raster decode                                                                  |
| `html` (no script) | a static fragment in a closed shadow root, sanitized by DOMPurify     | Nothing runs; [The `html` fragment](#the-html-fragment) says what is stripped and what contains the rest     |
| `html` (script)    | a live page in its own opaque frame, `/fy-render-html.html`           | The owner asked for interaction; [The interactive `html` frame](#the-interactive-html-frame) is the boundary |
| `mermaid`          | `<img src="data:image/svg+xml,…">`                                    | Compiled to SVG in the sandbox frame in the theme's tokens, then re-admitted through the authored-SVG gate   |
| `map`              | a Leaflet map in the message, tiles from `tile.openstreetmap.org`     | The payload is data placed with `textContent`; [Maps](#maps) says what loads and what is refused             |
| `chart`            | a Chart.js `<canvas>` in the message, with page-text legend and steps | The payload is data in a closed language, painted by `fillText`; [Charts](#charts) says why not a frame      |
| `lottie`           | live player inside the sandbox frame                                  | An animation has to keep running to animate, so this one stays live                                          |
| `image` (`src:`)   | `<img src="blob:…">` of admitted bytes                                | Workspace or https bytes, checked like inline ones — [Media from `src:`](#media-from-src)                    |
| `video`            | the browser's native `<video controls>`                               | A workspace file as a `blob:`; an https URL directly, which `media-src https:` admits                        |
| `audio`            | the browser's native `<audio controls>`                               | As `video`                                                                                                   |
| `pdf`              | a file row: workspace Open / Download of a minted `blob:`; https link | Measured: Chromium blocks its PDF viewer in a sandboxed frame, and the app policy refuses `blob:` frames     |

### Maps

**A `map` block is a Leaflet map drawn in the message, from a payload that is data.** Pan, zoom and tap a
marker for its popup, like a native map; the theme follows light/dark. The payload is JSON or YAML (JSON is
a YAML subset), at most 32 KiB:

```text
center: [51.5074, -0.1278]   # [lat, lng]; omit it to fit the view to everything drawn
zoom: 12                     # 0–18; with a fit it is the closest the fit may zoom
fit: true                    # fit to every marker and shape (implied when there is no centre)
markers:
  - {at: [51.5007, -0.1246], label: Big Ben, popup: "Clock tower", color: red}
lines:                       # polylines / routes: [[lat, lng], …] or {points, label, color}
  - {points: [[51.5, -0.12], [51.51, -0.1]], label: Route, color: blue}
polygons:                    # {points, label, color}; a ring needs three points
  - {points: [[51.50, -0.15], [51.51, -0.14], [51.50, -0.13]], label: Park}
geojson: {…}                 # Point, LineString, Polygon and their Multi*/Feature/Collection forms
```

Colours are a short palette (`red`, `blue`, `green`, `amber`, `purple`) or a `#hex` literal, resolved before
they reach a style.

**What loads, and why it is safe.**

- **The library is bundled and pinned** (Leaflet 1.9.4; `yaml` reads the payload) in a lazy chunk, fetched only
  once a map is near the viewport. No runtime CDN.
- **Markup is never built from the payload.** Labels and popups are placed with `textContent` into elements
  the engine creates; Leaflet's string-markup paths (its zoom and attribution controls, the popup close
  button) are not used — the component draws its own zoom buttons and attribution as ordinary React. A
  label that looks like HTML is text.
- **Trusted Types.** The page refuses a string at `innerHTML` (`require-trusted-types-for 'script'`, no default
  policy). Leaflet writes `div.innerHTML = '<svg/>'` once at load to test for inline SVG; a build-time Vite
  plugin (`leafletTrustedTypes` in `vite.config.ts`) removes that write and throws if Leaflet's source ever
  stops matching, so a Leaflet upgrade must be re-audited. `tests/unit/build-contract.test.ts` pins it.
- **One remote origin.** `img-src` names `https://tile.openstreetmap.org` and nothing else remote
  (`public/_headers`; `scripts/validate/pages-config.sh` pins the line and still refuses a bare `https:`).
  Markdown `![](url)` images remain requests the policy refuses. No API key exists anywhere in the client.
- **Tile provider and policy.** OpenStreetMap's standard tile layer needs no key and permits light
  interactive use under [its tile usage policy](https://operations.osmfoundation.org/policies/tiles/):
  visible attribution (the component's © OpenStreetMap contributors link), a valid `Referer` (the tile
  `<img>`s alone carry `referrerpolicy="strict-origin-when-cross-origin"`; the page's own policy stays
  `no-referrer`), no bulk fetching, zoom capped at 18, a one-tile buffer, tiles loaded only when the map
  is idle. A map draws only when it is near the viewport. Heavy deployments should move to a hosted
  provider: change `MAP_TILE_ORIGIN` (`fy-render-map-tiles.ts`) and `img-src` together; the unit test and
  the Pages gate fail until they agree.
- **Touch.** On a coarse pointer one finger scrolls the transcript and the map is dragged in Fullscreen
  (where the wheel zoom is also on); the Zoom buttons work inline.
- **Dark mode** is a CSS filter on the tile pane, not a second tile source.

**It fails to something readable.** A payload that is too large, not JSON/YAML, off the globe or over the
caps shows the reason and a **coordinates list** (`Point: 51.5, -0.12`, up to 200 lines) taken from
whatever could be read; the same list appears if the map library cannot load (offline, a blocked chunk).
Tiles that fail to load leave the pins and lines on a plain background.

### Charts

**A `chart` block is an interactive chart drawn in the message by Chart.js, from a description in this
package's own small chart language — never a Chart.js configuration.** An author says what the chart
says; the renderer decides how it looks, in the reader's theme. The payload is JSON or YAML, at most
64 KiB:

```text
kind: bar                    # line | bar | area | pie | doughnut | scatter | radar
title: Warden spend          # optional; a frame may override it
x: [26 Oct, 27 Oct, 28 Oct]  # category labels, or {label, values}; scatter takes {label, format}
y: {label: USD, format: money, currency: USD, min: 0, max: 10}
stacked: true                # line, area and bar only
horizontal: false            # bar only
series:
  - {name: Investigations, data: [2.1, 2.2, 2.0]}          # null is a gap
  - {name: First-pass filter, data: [0.3, 0.3, 0.29], tone: muted}
  - {name: Trend, data: [2.4, 2.5, 2.3], kind: line}       # a line over bars
frames:                      # optional step-through: Previous / Next, a slider, the step's label
  - {label: Before}
  - {label: After, title: Spend after, series: [...], x: [...]}
```

- **A series never names a colour.** It asks for a `tone` — `accent`, `good`, `warn`, `bad`, `muted` —
  or a palette slot `1`–`8`; without one, series _n_ takes slot _n_. Any key the language does not name,
  `color:` included, refuses the block, so an author sees it fall back rather than a chart silently in
  other colours.
- **Formats are a closed set**: `number`, `percent` (the value is already a percentage, `42` → `42%`),
  `money` (ISO 4217 `currency`, default USD), `duration` (seconds → `450 ms`, `3m 20s`, `2h 5m`) and
  `bytes` (binary units). Ticks use a compact form (`12.3K`); tooltips and the data table the full one.
  There is no author formatter and no author callback anywhere.
- Scatter data is `[[x, y], …]` or `[{x, y}, …]` on a numeric x axis; every other kind is one value per
  label. Caps are in the table above; a refusal is the ordinary source fence with the reason as its
  `title` (`data-fy-render-failure="render"`), and a chunk that will not load is `library`, with
  **Try rendering again**.

**The theme, and only the theme, paints it.** The block reads the app's tokens from its own element and
resolves each to a hex literal through a one-pixel canvas (`components/fy-render-theme.ts`) — the
browser's own colour parser, so a `color-mix()` or `oklch()` token works. Series colours come from
`--viz-1` … `--viz-8` in `styles/themes.css`; each slot NAMES a hue every family already restates per
mode (the per-tool hues, the keyword violet, the Claude orange, the error red), so a new family gets a
palette without writing one. Their order is measured, not chosen: across all 22 themes the first five stay
at least 70 apart in RGB (of 441) and all eight at least 40, and the browser suite re-checks that against
the sheet. The accent is deliberately not a slot — in several families it _is_ one of those hues — so a
chart that wants the brand colour says `tone: accent`. Grid, ticks, tooltip, font and corner radius
(`--radius-xs`, so a Neo bar is square) come from tokens too. `lib/fy-render-chart-config.ts` is the one
place a spec meets Chart.js, and a unit test walks every kind's configuration and finds no colour the theme
did not supply.

**Interaction.** Tooltips on hover or tap. The legend and the step controls are **page text**, not
canvas: one toggle button per series (per slice on a pie), `aria-pressed`, and Previous / a range slider /
Next with the step's label in a polite live region — all reachable and operable from the keyboard. Line
and area charts zoom along the x axis (`chartjs-plugin-zoom`, bundled) without trapping the page: inline,
a mouse drags a box or pinches a trackpad (Ctrl + wheel), and a finger is left to the transcript's scroll —
nothing binds a touch gesture to the canvas. In **Fullscreen** the chart takes the wheel, a pinch and a
drag to pan. **Reset zoom** appears once zoomed. Under `prefers-reduced-motion: reduce` nothing animates.

**Accessible.** The canvas is `role="img"` named `Chart: <alt>` and described by a visually hidden table
of the numbers behind the current frame (one row per label, one column per series, values in the axis
format) — clipped inside a wrapper, because a table never shrinks below its content and a transcript's
`.md table` rule would otherwise paint it over the canvas (measured, and pinned in the browser suite).

**Why in the page, and not in the sandbox frame.** The library sandbox exists because Mermaid and Lottie
are large libraries interpreting rich author input, and Mermaid writes raw `innerHTML`, which this page's
Trusted Types policy refuses. A chart is neither:

- **The input is not a language a library interprets.** It is parsed by a strict zod schema
  (`lib/fy-render-chart.ts`) into numbers and short strings; Chart.js receives a configuration this
  package builds, every function in it this package's own. Nothing an author writes becomes code,
  markup, a style or a URL: labels and names reach Chart.js's `fillText` and React text.
- **The libraries hold no sink the page would refuse.** Chart.js 4.6.1, `chartjs-plugin-zoom` 2.2.0 and
  its Hammer.js 2.0.8 write no markup, compile no string and open no request —
  `tests/unit/build-contract.test.ts` scans the exact files bundled for `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `new Function`, `eval`, `fetch`, `XMLHttpRequest` and
  `importScripts`, and fails an upgrade that adds one. So no Trusted Types policy, CSP source or
  `_headers` line changes for it (and none is in this build).
- **The theme lives here.** A frame would need every token, the font, a resize protocol and every gesture
  carried across a port; in the page the chart reads the theme like any component and redraws when it
  changes.

The residual is the map's: a bundled library, given bounded data, could still have a bug its own input
reaches. That is [gap 17](#declared-gaps).

**Bundled and lazy.** Chart.js, the zoom plugin and Hammer.js are one lazy chunk (≈ 220 KB, ≈ 75 KB
gzipped) and the reader with its YAML and schema one more (≈ 4 KB); both are fetched only once a chart is
near the viewport. The main bundle grows by the component and the palette, ≈ 17 KB (≈ 6 KB gzipped).

### Mermaid on a phone

**A diagram is read, not squeezed.** Mermaid compiles at 16px text and the compiled SVG declares `width="100%"`,
so as an `<img>` it used to be stretched or squeezed to the message column: a wide left-to-right flowchart on a
390px phone landed at 8–10px text. Two decisions in `lib/fy-render-mermaid-layout.ts` (pure, unit-proven) fix that.

- **Vertical on a narrow column.** When the block's content width is under 520px, the header of a `flowchart` or
  `graph` declared `LR`/`RL` is rewritten to `TB`/`BT` **in the source, before it is compiled**. Only the direction
  token of the diagram's own header line moves (past blank lines, `%%` comments, a `%%{…}%%` directive and front
  matter); a label that spells `flowchart LR`, a subgraph's own `direction`, and every other diagram kind are left
  byte for byte. The width is re-read on resize and rotation, and crossing 520px recompiles off stage exactly like a
  theme change: the old picture stays up until the new one arrives, and only while the block is on screen.
  Fullscreen never flips the direction (the decision is the inline column's), so enlarging a diagram does not redraw it.
- **A readable size.** The image's width is set from its `viewBox`: natural size when the column allows, shrunk to fit
  only while the text stays at 85% of the body size (never under 12px), and **scrolling sideways inside its own box**
  past that (a focusable `region` named "Diagram, scrolls sideways"). Inline, text never exceeds 1.25× the body size;
  fullscreen, which already pans on both axes, may enlarge up to twice natural size.

_Why scroll rather than tap-to-expand:_ pan-in-place needs no new control or state, is discoverable (the diagram is
cut off at the edge), and fullscreen already exists for the reader who wants the whole plane.

The security gates are unchanged: the rewrite runs on the authored source before the shell's `secure` list and the
SVG re-admission see it, and neither is touched.

### Mermaid in the theme

**A diagram is painted from the same tokens.** The parent resolves the theme (as above), turns it into
Mermaid's `base`-theme `themeVariables` (`lib/fy-render-palette.ts`: nodes in the accent's soft wash
with the accent itself as the border and body ink as the text, cluster and label edges in `--border-strong`
(the theme's strong edge), lines muted, notes the warn wash, a pie and a git graph on the
`chart` palette, the page's font) and sends them as data with the render command. The shell admits only
those keys, only hex literals, and a font stack with no brace or semicolon, because Mermaid writes them
into the compiled SVG's own `<style>`; anything else is dropped and `base` derives that slot itself.

**The author cannot repaint it.** `theme`, `themeVariables`, `themeCSS` and `darkMode` join the shell's
`secure` list, which no `%%{init}%%` directive or front matter reaches — measured in real Chromium: a
directive, and front matter, asking for `forest` and `#ff0000` each compile in the app's palette with no
trace of the red. A diagram's own `style` and `classDef` colours are NOT blocked — they are styling an
author chose, inert in the `<img>` sink — and the authoring skill tells agents to leave them out.
Every existing gate is untouched: `securityLevel: 'strict'`, `htmlLabels: false`, the `<foreignObject>`
refusal and the re-admission of the compiled SVG through the authored-SVG checks.

**The cache key is the palette, not the mode.** The shell echoes the key it painted with
(`<mode>:<8 hex>`, a hash of every resolved token, the font and the radius) and the wire refuses any other
shape. A diagram is redrawn when that key differs from the page's AND it is on screen — so a switch
between two dark themes repaints too, which a light/dark key would have missed.

### The `html` fragment

**An `html` block is a STATIC FRAGMENT rendered directly in the message — nothing an author writes in
it runs.** The owner's decision: "no need to render full HTML — just render HTML fragments that don't
allow scripts, directly." There is no frame, no shell and no message port (the interactive-page frame
that used to stand here is deleted, with its static shell, its `_headers` rules and its pins).
`fy-render-fragment.tsx` sanitizes the markup with DOMPurify (pinned, bundled, its own instance) and
appends the result as DOM nodes into a **closed shadow root** in the message.

**What is stripped**, by the sanitizer's configuration and hooks rather than by review:

- every `<script>`, and every element that could run, frame, submit or reconfigure the page —
  `iframe`, `frame`, `object`, `embed`, `portal`, `form` and every form control, `base`, `meta`,
  `link`, `template`, `noscript` — plus SVG's `foreignObject`, `use` and SMIL animation, and the
  page's own players (`audio`, `video`; a recording is a `src:` block);
- every `on*` handler, and `action`, `formaction`, `srcset`, `ping`, `background`, `poster`, `srcdoc`
  and every author `data-*` attribute;
- every URL that is not one of exactly three shapes: an `https:` link on an `<a>`, which opens a new tab
  `noopener noreferrer`; a `data:image/` picture; or `media:<file>` from the session's media folder,
  read through the reader's grant, admitted like any other picture and shown as a `blob:` this page
  minted. `javascript:`, every other `data:`, and every relative or same-origin URL are dropped — a
  fragment has no business addressing the app;
- in CSS, inline and in `<style>`: `@import`, and every `url(…)` or `image-set(…)` that is not a
  `data:image/`, which become `none`.

**What is kept**: structure and text, tables, `<details>`/`<summary>`, lists, code, inline SVG with
its filters, `style` attributes and `<style>` elements.

**What contains what is left.** The closed shadow root keeps the fragment's styles from reaching the
app and the app's selectors from reaching the fragment; custom properties still inherit, which is how
the theme tokens arrive (a small baseline stylesheet inside the root uses them). The host carries
`contain: layout paint`, so a `position: fixed` overlay is fixed to the fragment and clipped by it
rather than covering the app, and its height is bounded (`min(70dvh, 900px)`, then it scrolls). The
page's own policy is the backstop under all of it: `img-src`, `font-src` and `connect-src` refuse a
remote load the sanitizer missed, and `require-trusted-types-for 'script'` refuses any string at a
script sink. DOMPurify's own parse runs under the one dedicated `fy-fragment` Trusted Types policy
(`lib/trusted-types.ts`, added to the `_headers` allowlist), which `fy-render-opt-in.test.ts` holds to
a single user, and the result never reaches a sink as a string.

**Measured in real Chromium** (`tests/integration/fy-render-fragment.security.test.ts`, the shipped
block under the exact `/*` policy from `_headers`, Trusted Types included, and a server-side request
ledger): a corpus — free of `<script>` and `on…` handlers, since either one now routes a block to the
interactive frame — of a `javascript:` link, a relative link, an inline-style `url()`, a `<style>` with `@import` and `url()` and rules aimed at the
HOST page's `body` and `#outside`, a form with an action, an `iframe srcdoc`, an `object`, an `embed`, a
meta refresh, a `link` stylesheet, a `base`, an SVG `foreignObject`, a `use`, a remote image and a
`position: fixed` overlay. Nothing set `window.__fyPwned` — before or after the test clicked the links
and the submit button — the page never navigated, the ledger saw **zero** `/beacon` requests, the host
page's computed styles were unchanged, the overlay stayed inside the fragment's box, and the page raised
no Trusted Types or CSP violation. With the CSS neutraliser disabled, the same test fails on three
same-origin beacons — the app's own `img-src 'self'` would have let them through.

**Why Mermaid is NOT rendered in the page too**, though the owner asked for it: measured under this
same policy, `mermaid.render()` throws "This document requires 'TrustedHTML' assignment" — Mermaid
writes raw `innerHTML` itself, and still does with DOMPurify's own policy name allowed. The only way to
run it in the page is a catch-all `default` Trusted Types policy, which would silently re-open every
markup sink in the app. So Mermaid keeps compiling in the opaque library sandbox and its diagram is
shown inline as an `<img>` — the reader sees no difference.

### The interactive `html` frame

**An `html` block WITH script runs; one without stays a static fragment.** The owner's decision, in two
steps: static fragments first, then "bring back interactive HTML with JavaScript, safely". The route is
decided on the raw bytes before anything is sanitized (`fyRenderHtmlRunsScript`: any `<script` or
`on…=` handler-shaped attribute). Both answers are safe, so the test errs towards "runs": a static
fragment that only looked scripted runs in the frame, and a scripted page that only looked static is
sanitized and its scripts stripped.

**Where it runs.** `/fy-render-html.html`, a **separate static shell** from the library sandbox, in an
`<iframe sandbox="allow-scripts">` (`fy-render-html-frame.tsx`). It has to be separate: the library
shell's `script-src` lists build-time hashes and nothing else, which is exactly what keeps Mermaid and
Lottie honest and exactly what an agent's own script can never match. So this shell carries its own
policy instead — `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src
data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri
'none'`, checked by the build — and the same `_headers` treatment the library shell has, for **both**
the `.html` path and the extensionless one Pages' pretty URLs redirect it to (the bug that once made
every shell unframeable in production), both pinned by `pages-config.sh`.

- **Opaque origin and nothing else granted.** No `allow-same-origin` (no storage, no cookies, no
  `parent.document`), no `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals` or
  `allow-downloads`. The parent trusts `event.source` identity only, and believes only bounded facts
  from the port: a height (clamped), an Escape keypress, a heartbeat.
- **The page arrives as data** over a `MessagePort`; the bootstrap parses it with `DOMParser`, strips
  `meta`, `base`, `link`, embedded frames and objects and speculation rules, deletes the
  `RTCPeerConnection` family, then re-creates the page's classic and module scripts so they run in
  order.
- **Inline and frameless, as if native.** It paints the message column's background, colour and font
  (`FyRenderHtmlPaint`, re-sent on a theme change, never a remount), takes its own reported height
  clamped to 640px — past that it scrolls inside itself, so it can never push or cover the app — and
  stays invisible until its first draw. A replaced element cannot draw outside its box: a
  `position: fixed` cover inside the page is fixed to the frame.
- **A quiet marker says it runs**: one muted "interactive" line above the page, in the flow so it never
  sits on the page's own controls. The frame's accessible name is `Interactive illustration: <alt>`.
- **Unloaded when far away.** A page runs only while its block is within a screen or so of the viewport
  (or fullscreen). Scrolled further, the frame is REMOVED — its scripts with it — and a plane of its
  last reported height holds its place; scrolled back, it starts again.
- **Two guards, neither of them a quota.** A **stall guard**: once drawn, the shell beats every second;
  a page that holds the thread stops beating and is stopped after five seconds of silence while the tab
  is visible ("stopped because it stopped responding", **Run again**). And ten minutes of **wall-clock
  life**, armed at mount and cleared by nothing the page says. Author code shares the shell's realm and
  could keep beating while it computes, so neither bounds how hard it works (gap 3).
- **A navigation tears it down**: the second `load` after `src` means the page sent its frame
  elsewhere, and the block falls back to the authored source.

**Measured in real Chromium** (`tests/integration/fy-render-html.security.test.ts`, the real generated
shell and a server-side request ledger): author script runs, reports its height and answers a real
click; `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `parent.document`, the parent's
globals and every trace of the parent's token yield nothing; `top.location` assignment throws;
`window.open` is `null` and so is `opener`; a `position: fixed` cover over the whole page leaves the
app's own element beside the frame on top; `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, a remote
image, a worker, a nested frame and a form submission produce **zero** requests; authored meta refresh,
prerender link, `base` and speculation rules cause none either. And the residual, measured as one: a
page that sets its own `location.href` **does** reach the server, and the parent sees the second
`load` it tears the frame down on. The production build runs one under real Pages headers
(`tests/e2e/fy-render-pages.e2e.test.ts`) and inline in a real session (`product-journeys`).

### Media from `src:`

A `src:` block (`fy-render-media.tsx`) reads or fetches nothing until it is near the viewport, and
everything it creates goes with the block: unmounting aborts a read in flight and revokes the object
URL.

- **`@path` is read as the reader.** The block receives exactly one capability from the session's
  reference surface: `readWorkspaceMedia(path) → bytes | refusal`. It never holds a connection, a
  token, a daemon URL or a session id. The far side (`fy-render-workspace-media.ts`) makes the path
  session-relative exactly as an `@file` reference does and reads it through the session filesystem
  route's bounded preview, over the carrier router — so the daemon's grant check decides it
  ([grants.md](grants.md), `filesystem` _use_), the same as opening the file from the Files tab. The
  bytes become a `blob:` this page minted; that is the only address a media element sees.
- **The type comes from the extension**, decided before any byte is read, so a file this type cannot
  show costs no transfer: `image` takes `png`/`jpg`/`jpeg`/`gif`/`webp`; `video` takes
  `mp4`/`m4v`/`webm`/`ogv`/`mov`; `audio` takes `mp3`/`m4a`/`aac`/`wav`/`ogg`/`oga`/`opus`/`weba`/`flac`;
  `pdf` takes `pdf`.
- **`media:<file>` reads the session's MEDIA folder** — `state/sessions/<id>/media` inside the daemon's
  `FY_HOME`, created at every launch and handed to the agent's pane as `FY_MEDIA_DIR` (derived like
  `FY_SESSION_ID`, so a stored variable cannot redirect it). It is the official place for an agent to
  put media it MADE to show the person: outside any repository, so a generated chart never dirties a
  working tree and no repository's ignore rules decide whether it can be shown. It is read through the
  same route with `scope=media` — the daemon names the folder from the session id; a caller never names
  a directory — under the same `filesystem` _use_ grant, the same denylist and the same 1 MiB bound.
- **A refusal names the rule that refused it.** The daemon's file view carries `rule`: the ignore
  source, line and pattern Git matched (`git check-ignore -v`), the Git failure that stopped the check
  (the gitignore gate fails closed, so a Git error used to read as "ignored" with no way to tell), or
  the denied name. A 403 that is about the PATH (`escapes_root`, `denied`, `ignored`) is named as
  such rather than as the reader's lack of access. "Not served — gitignored, a protected secret, or
  outside the folder" was one sentence for four different causes, and an agent's own freshly written
  image in a dotfiles repository got it with no way to find out which.
- **Every refusal is a file row that says which** — missing, denied to this reader (a 403 from the grant
  check), not served (gitignored, a protected secret, or outside the folder), over the 1 MiB cap,
  unsupported, unavailable, refused by an https host, or undecodable — never a broken player and never
  the bytes of a file the reader may not open.
- **https `video` and `audio` go to the native player directly**, which is the one consumer the app's
  `media-src` now admits `https:` for. Nothing else in the app creates a `<video>` or `<audio>` from
  authored text — Markdown has no `rehype-raw` — so the widening reaches exactly the players an
  `fy-render` block mounts, which it now does once near, with `preload="metadata"`.
- **https `image` does NOT widen `img-src`.** Markdown renders `![](url)` as an `<img>` on every
  surface with no gesture at all; `img-src https:` would make every remote image an agent writes an
  automatic request carrying the reader's address. Instead the parent fetches it — `credentials:
'omit'`, no referrer, `cors` mode, capped at 2 MiB — runs the inline admission checks on the bytes,
  and shows a `blob:`. A host that does not allow a cross-origin read gets a file row with the link
  instead. `pages-config.sh` refuses an `img-src` that gains `https:`.
- **A workspace `pdf` is a file row — name, size, Open, Download — not an embedded viewer — measured.** The file
  preview's shape, a `blob:` in an `<iframe sandbox="">`, renders "This page has been blocked by
  Chrome" in Chromium, which refuses its PDF viewer inside a sandboxed frame; and the app's
  `default-src 'self'` refuses to frame a `blob:` at all (a CSP violation, also measured). Embedding
  would mean widening `frame-src` and dropping the sandbox on bytes an agent chose, for a viewer a new
  tab provides anyway. The admitted bytes stay a `blob:` this page minted, so the link carries no
  daemon URL. **The same measurement says the Files tab's own PDF preview
  (`rich-file-preview.tsx`) is blocked in Chromium today** — a separate defect, recorded here and not
  changed by this build.
- **https `pdf` is a link**, opened in a new tab (`rel="noopener noreferrer"`), because embedding it
  would mean widening `frame-src` for a stranger's document.
- **The reader's address is the cost of an https source, and with no gesture it is paid as soon as
  the block is near.** There is no consent sentence any more; this is residual 2 of
  [Inline by default](#inline-by-default--the-owners-decision).

**Why the two sandbox types end up in different places.** A Mermaid diagram is static, so the frame
that drew it has no further job: it hands back SVG text, is destroyed, and the text goes to the `<img>`
sink measured below — which means the measured result covers Mermaid too, and no live opaque-origin
document is left in the transcript for every diagram a reader scrolls past. Lottie cannot do that.

### The sandbox frame, and exactly what it is worth

A `mermaid` or `lottie` block mounts `/fy-render-sandbox.html` in an
`<iframe sandbox="allow-scripts">` — **no `allow-same-origin`**, so the frame's origin is opaque and
it has no storage, no cookies, no reach into this document, and no useful `event.origin` (it is the
literal string `"null"`, so the parent trusts `event.source` identity and nothing else).

- **The frame fetches no subresource, which is narrower than "the frame has no network".** Its own
  policy is `default-src 'none'` and it carries no `<script src>`, so every ordinary subresource —
  `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, worker, nested frame, font, remote image — is
  refused, measured in real Chromium and corroborated by a server-side request ledger. What that does
  **not** cover: self-navigation, `<link rel=prerender>` and WebRTC STUN/TURN were all measured
  egressing from this exact frame shape under this exact policy, because CSP's fetch directives do not
  govern navigation and Chromium does not recognise `webrtc 'block'`. Reaching any of them needs
  script execution inside the frame, which the hash-pinned `script-src` denies — so the honest claim
  is "no code that CAN run there issues a request", never "the frame cannot". Gap 2 below.
  The parent fetches the one library the block needs with `credentials: 'omit'`, `redirect: 'error'`
  and a per-library byte cap, and transfers the bytes over a `MessageChannel` port.
- **Author bytes cannot become code, and CSP is what enforces that.** The shell's `script-src` lists
  nothing but the build-time SHA-256 of the bootstrap and the two bundles — no `'self'`, no
  `'unsafe-inline'`, no `'unsafe-eval'`. Measured in real Chromium inside the opaque frame: a
  dynamically created inline script whose text matches a pinned hash runs, and the identical
  primitive with any other text does not. The shell does hold a code-install primitive, and saying
  otherwise would be dishonest — what makes it safe is that it is cryptographically incapable of
  running anything not fixed at build time.
- **A split deploy fails closed and visibly.** If the shell and the bundles are ever served from
  different releases, the hash will not match, the library global never appears, the frame reports an
  error, and the block returns to its escaped source. That is correct behaviour, not a bug to chase.
- **Lottie's remote-asset loaders are unreachable rather than absent.** The light bundle still ships
  its `path`-based `XMLHttpRequest` and `img.src` asset loader. The bootstrap passes no `path`, and
  the shell CSP allows only `img-src data:`, so an animation's `assets[].u`/`.p` cannot egress. The
  accurate claim is inability, not absence.
- **Two independent refusals of Lottie expressions, and they are not the same strength.**
  `lottie_light` genuinely registers no expression evaluator — that is an ABSENCE, and the build
  fails if a bump reintroduces a statically named `Function`, `eval`, constructor or expression-plugin
  execution target through a call, `new` or tagged template, including member, computed, optional and
  static `call`/`apply`/`bind` receiver spellings. Runtime-built property names, aliases and other value
  handoffs need data flow and remain outside that syntactic check. Mermaid is a weaker claim and is kept
  separate on purpose: its bundle carries four
  `Function("return this")` global-lookup fallbacks inherited from lodash, which never evaluate because
  `self` is defined in a browser and the `||` chain short-circuits, and which CSP would refuse anyway
  because `'unsafe-eval'` is absent. Short-circuit plus policy is not the same as absence, and the two
  must not be merged.
- **The `<foreignObject>` refusal is a fail-closed guard, and measurement says it is untriggered
  today.** Mermaid protects only a fixed list of config keys from an in-diagram `%%{init: …}%%`
  directive; the shell extends that list, but `flowchart` is deliberately left out because protecting
  it would block every benign flowchart directive — so on paper an author can ask for HTML labels and
  the parent's `<foreignObject>` refusal is what would catch it.

  Measured in real Chromium against the shipped shell and the pinned bundle, three sources —
  `%%{init: {"flowchart": {"htmlLabels": true}}}%%`, `%%{init: {"htmlLabels": true}}%%` and the plain
  equivalent diagram — compiled to **byte-identical** 12,359-byte SVG with **no `<foreignObject>`**.
  With `securityLevel: 'strict'` and the extended `secure` list, the directive does not defeat the
  option. So the refusal is a guard against a future Mermaid release changing that, not a fallback
  path any reader reaches; the reachable failure route for a `mermaid` block is a **parse error**,
  which arrives as the `render` class with the library's own wording folded away. Do not describe the
  `<foreignObject>` refusal as the flagship fallback — that overstates what it currently does, and
  understates why it should stay.

**The watchdogs bound WALL-CLOCK LIFETIME ONLY — never CPU, never memory.** A Mermaid compile gets 15
seconds and a Lottie frame gets 120 seconds of life, armed when the frame mounts and clearable by
nothing the frame says. That is deliberate: a watchdog stood down by a `rendered` message is exactly
the defect this design exists to avoid, since reporting success is the first thing a runaway payload
would do. But it bounds how LONG a payload may compute, not how hard. See [gap 3](#declared-gaps).

### The `<img>` sink is the security boundary

An authored SVG reaches the page **only** as the `src` of an HTML `<img>`, as a
`data:image/svg+xml,…` URL. That single sentence is the security design; everything else is
authoring ergonomics.

Measured, in installed Google Chrome `150.0.7871.186`, against an HTTP request ledger running outside
the browser with no CSP present:

- **zero** external HTTP requests from any data-URL `<img>` probe, across 25 hostile vector families
  (external `<image href>`, CSS `@import`, `background-image`, `@font-face`, external
  paint/filter/mask, `<feImage>`, `xml-stylesheet`, SMIL-driven external `href`, `<use>`,
  `<foreignObject>` HTML subresources and meta refresh, inline and external `<script>`, `onload` and
  `onerror` handlers, HTTP anchors, `javascript:` anchors);
- **zero** external requests from blob-URL `<img>` probes, including same-origin cases, so the result
  is not an artefact of cross-origin blocking;
- **zero** script or event-handler DOM mutations: four pixel probes that turn a red rectangle green
  when active stayed red in all eight image cases, while the identical bytes as an active top-level
  SVG document turned green every time;
- 21 of 25 vector families produced real ledger requests as **active positive controls**, rising to
  24 of 25 with same-origin follow-ups, so the ledger demonstrably would have caught traffic.

Read that claim exactly as scoped:

- It belongs to **the sink, not the bytes**. The same payloads fetched, executed and navigated when
  served as an active top-level SVG document.
- It does **not** extend to inline SVG, `<object>`, `<embed>`, `<iframe>`, a CSS image or paint
  consumer, a top-level SVG document, or an arbitrary other use of a blob URL.
- It says scripts and script **event handlers** did not run. It does **not** say declarative SVG
  behaviour is inert — self-contained SMIL and CSS animation are a different capability and were not
  claimed either way.
- **Chrome 150 only. Firefox, WebKit and Safari are unmeasured** ([gap 4](#declared-gaps)).
- It is behavioural evidence about ordinary engine operation, not a claim against engine bugs.

`packages/pwa/tests/unit/fy-render-block.test.tsx` asserts that a static type mounts an `<img>` and
no `iframe`, `object`, `embed`, `script` or `canvas` in the rendered tree, so a future refactor that moves these bytes to a
consumer outside the measured one fails review even if the grammar is untouched.

### The grammar is a bound, not a sanitiser

The per-type checks reject a few obviously unsupported constructs and cap how much work a parser can
be made to do. They are bounded lexical and header checks, not a complete parser or sanitiser: the
three forbidden SVG element names are read by QName local name, while several other refusals remain
simple string scans. They deliberately admit constructs outside that short refusal list, and **they
are not what makes a payload safe**.

This is measured too: 15 of the 25 hostile payloads above passed `parseFyRender` unchanged —
including external image, font, stylesheet and paint references, `xml-stylesheet`, SMIL external
`href`, `onload`/`onerror` attributes, HTTP anchors and `javascript:` anchors. Every one was harmless
because of the `<img>` sink, not because validation removed anything. They render inert or
incomplete, and the grammar does not promise otherwise.

So: read a refusal as "this will not do what you think", never as "this would otherwise have been
unsafe". Read an acceptance as "this is within the caps", never as "this will render".

---

## Inline by default — the owner's decision

**An illustration renders by itself, inline, as if it were part of the message.** The owner asked for
it in those words — "make it inline, as if it's native. no need to have a special hypermedia block" —
and this build does exactly that. There is no Render control, no card around the picture, no caption
under it and no status line beside it. A picture is sized to the message column and bounded in
height (`min(60dvh, 720px)`), an `html` block is a static fragment in the column's own type and
colours, and a PDF is the same compact file row an attachment is.

**What changed is who starts the work, and nothing else.** Every security property of where author
bytes run is untouched: the `<img>` sink for `svg`, inline `image` and compiled Mermaid; the
opaque-origin library sandbox for `mermaid` and `lottie`; the sanitized, shadow-contained `html`
fragment in which nothing runs; the opaque-origin html shell, with its own policy, where a page with
script runs; the media capability
that reads a workspace file as the reader and never holds a connection. The gesture gate in front of
all of them is gone. What replaced it bounds where and when work happens, and **not** how much:

- **Near the viewport.** A block renders the first time it comes within about one phone screen of the
  viewport (`IntersectionObserver`, `800px` vertical margin) and stays rendered. A block far down a
  long transcript decodes nothing, downloads no renderer, sanitizes nothing and reads no file until the
  reader scrolls toward it.
- **Settled bytes.** A block's first bytes render at once, so a finished message from history never
  waits; later bytes replace them only once they have stopped changing for 400 ms. A streaming
  assistant therefore does not re-decode a partial SVG, recompile a diagram or re-sanitize a fragment
  on every token. A change of type takes effect immediately.
- **On screen only, for the two things that should be.** A Lottie animation plays only while it is on
  screen (or fullscreen), and a diagram or chart painted in another palette is redrawn only while it is
  on screen — so a theme switch with ten diagrams in a transcript redraws the ones in view, and the rest
  as they come back into view, never all at once. The palette, not just light or dark, is what is
  compared ([Mermaid in the theme](#mermaid-in-the-theme)).

**The residual this adds, stated rather than softened.** The gesture was the reader's chance to decline
work an agent asked their device to do. Without it:

1. **An https `src:` is contacted as soon as it is near.** The reader's browser fetches an https
   `image` (credentials omitted, no referrer) or hands an https `video`/`audio` to the native player
   with `preload="metadata"`, so the host learns the reader's address without a press. An https `pdf`
   is still a link and contacts nothing until it is followed.
2. **Decode and compile cost is spent without asking.** A payload inside every cap can still be
   expensive to rasterise or compile, and it now is, once near. The caps bound the input; the 15 s and
   120 s watchdogs, an interactive page's stall guard and its 10 min life bound wall-clock time; nothing
   bounds CPU or memory (gap 3).

These are accepted because the author is the owner's own ferret, which already runs on a host with
network access; nothing in the app is reachable to put in a request; and
the per-ferret Hypermedia switch ([hypermedia.md](hypermedia.md)) is how an owner keeps a ferret from
writing blocks at all. Anyone who considers this unacceptable can restore a gate by setting
`enableFyRender` nowhere — every block is then an ordinary escaped fence.

---

## Controls

**Two quiet icons in the top corner of a picture: Source and Fullscreen.** A Lottie animation adds
Play/Pause first. They are invisible until the reader hovers the picture, tabs to one of them, or
long-presses it on touch (a press held still for 450 ms; a moving touch is a scroll and does not
count). They are never `display: none`: a keyboard reader who tabs into the block sees the icon they
landed on. On a coarse pointer each icon resolves to the 44px touch floor through `--target-floor`;
on a fine one it stays small.

| Form                              | Source | Fullscreen |             Play / Pause             |
| --------------------------------- | :----: | :--------: | :----------------------------------: |
| `svg`, `image`, compiled Mermaid  |  yes   |    yes     |                  —                   |
| `lottie`                          |  yes   |    yes     |                 yes                  |
| `html`                            |  yes   |    yes     |                  —                   |
| `map`                             |  yes   |    yes     |            Zoom in / out             |
| `chart`                           |  yes   |    yes     | its own legend, steps and Reset zoom |
| `src:` `image` / `video`          |  yes   |    yes     |             the player's             |
| `src:` `audio`                    |   —    |     —      |             the player's             |
| `pdf` and every media refusal row |   —    |     —      |                  —                   |

An audio player gets no icons because its own controls fill that corner and there is nothing to see
in fullscreen; a file row has its own Open and Download actions.

- **Source** shows the whole fence body as an ordinary code block, escaped and truncated at 32,768
  characters, capped at `50dvh` inline and scrolling inside itself. It is a named `<section>` with
  `tabIndex={0}`, so a keyboard reader can pan a payload that is one enormous line. Its control
  carries `aria-expanded`, and `aria-controls` only while the panel exists.
- **Fullscreen** is an in-app overlay (`role="dialog"`, `aria-modal`), not the Fullscreen API, which
  iOS Safari lacks. It carries `kt-overlay`, the app's visible-viewport contract; Escape closes it,
  Tab is trapped both ways, and focus returns to the icon that opened it. A failure closes it, so Exit never vanishes under a reader standing in it.
- **Play / Pause** is a command on the live capability port, never a remount. Under
  `prefers-reduced-motion: reduce` an animation starts paused, and **the icons stay visible while it
  is paused**, so Play is never behind a hover a reader may not have. Once the reader presses either,
  that choice wins until the animation's bytes change. An authored `svg` carrying SMIL or CSS
  animation is outside this, as before.

**The description is the picture's own.** With no caption, `alt` goes where a screen reader finds it:
the `<img>`'s `alt`, the `<video>`/`<audio>` `aria-label`, and the `html` fragment's `aria-label`. The
fullscreen dialog is named `Illustration: <alt>`.

**The library frame is deliberately unreachable by keyboard and pointer** (`tabIndex={-1}` plus
`pointer-events: none`): it holds no control, and focus resting in a separate document would swallow
the Escape that leaves fullscreen.

### Error fallback

**A failure falls back to the code block, quietly.** A payload the browser will not decode, a diagram
Mermaid will not parse, a compiled diagram the re-admission gate refuses, a chart description the
chart language refuses, a sandbox that never started, a renderer that did not load, a compile that ran out of time, and an interactive page that
navigated away all show the authored source as the ordinary fence it would have been without this
feature — `.md pre`, nothing else. No sentence in the app's voice says it failed. The class travels as
`data-fy-render-failure` and the raw library or gate wording as the element's `title`, for whoever is
debugging; a jison dump quoting the author's own source is never presented as the app speaking.

**A retry only where one can help.** `startup`, `library` and `deadline` are about the deployment —
a shell that did not answer, a bundle that did not load, a cold multi-megabyte download that used up
the 15 s bound — so they carry one muted **Try rendering again** link. Bytes the browser or the
library refused, and a page that navigated, would only do the same thing again, so they carry none.

**A designed stop is not a failure.** A Lottie frame reaching its 120 s life, an interactive page its
ten minutes, or an interactive page that stopped responding keeps its place with one muted line —
"This animation stopped.", "This interactive illustration stopped after ten minutes.", "…stopped
because it stopped responding." — and **Replay** / **Run again**. No code block, no error mark.

**Media refusals are file rows.** A workspace file that is missing, denied to this reader, not
served, too large or unsupported, an https host that refused, and a player that could not decode all
become the same compact row a PDF is: a warning icon, the file's name and one muted sentence saying
which, with **Open link** for an https source. Never a broken player, and never the bytes of a file
the reader may not open.

**A tab left open across a deploy is still the quiet skew.** `/fy-render-sandbox.html` revalidates
while the parent is an immutable asset, and the wire parse refuses whole messages rather than
tolerating unknown shapes, so a version-skewed pairing drops the reply and the block reaches its
watchdog — the `deadline` fallback after 15 s for Mermaid. Reloading the page is the remedy, and that
refusal stays deliberate.

### Streaming, which is the ordinary case

A transcript row re-renders while the assistant is still emitting it, so a block sees a half-written
payload before the whole one. **State belongs to the exact bytes, and the bytes on screen lag the
bytes arriving by one quiet moment:**

- **The first bytes render at once; later ones once they settle** (400 ms unchanged). An `svg` admitted
  by prefix may be a partial document the browser refuses: it falls back to the code block, and the
  finished bytes, once settled, render by themselves — no press, no stale failure.
- **A stale error cannot fail a live image.** The `<img>` is keyed by source generation and its
  `error` handler carries the generation it was made for, so an event queued for replaced bytes is
  ignored.
- **A play decision belongs to the bytes it was made about**, so a rewritten animation starts over
  from the motion preference.
- **A redrawn diagram keeps the old one on screen** until the new one arrives: the frame compiles off
  stage, hidden rather than absent because Mermaid measures text in a laid-out document.

A raster does not stream visibly at all: the container checks require a terminal shape, so a partial
one does not parse and the fence stays an ordinary code fence until the last byte arrives.

---

## Accepted risk

**This build renders a bounded payload, automatically once near, with no resource isolation.** The
caps bound what goes in; nothing bounds what rasterising, compiling or running it costs. A
16-megapixel image within every limit, or a 100 KiB SVG with a handful of filter primitives, can
still be expensive to draw, and there is no CPU or memory ceiling anywhere in this build.

That residual is **explicitly accepted**, on these terms and no others:

1. It is **bounded-input**: magic bytes must match the declared type, declared dimensions are read
   before any decoder is handed the bytes, animation is refused, and a container that fails the
   selected admission checks fails closed. Those checks are a signature, record ordering, a terminal
   shape and the declared dimensions — **not** CRCs and not compressed content, which stay the
   browser decoder's business.
2. It is **proximity-bounded and settled**: nothing renders until it is near the viewport, nothing
   re-renders per streamed chunk, animation runs only on screen, and a theme switch redraws only what
   is in view. That decides WHEN work happens and how much of the transcript it touches — never how
   hard any one block works.
3. It is the **owner's stated decision**, recorded here and in the authoring skill with the residual
   in [Inline by default](#inline-by-default--the-owners-decision), rather than left implicit.

**This is not resource isolation.** It does not satisfy row #65's executable, resource-bounded
clause, and **row #65 stays open**. Anyone who considers even this residual unacceptable should ship
the source-only subset, which is a coherent product: set `enableFyRender` nowhere and every block
renders as an ordinary escaped fence.

---

## Guide for agents

`fy render guide [type]` prints this section and nothing else: the `### overview` body when no type is named, or that type's `###` body when one is. `image`, `video`, `audio` and `pdf` share the `### media` section, because they name bytes the same way. The CLI ships a byte-exact copy of this whole section in the binary (`RENDER_GUIDE_SECTION` in `packages/cli/src/lib/render/guide-text.ts`), and the `render-guide-doc` contract in `scripts/validate/cli-contracts.sh` fails the commit that lets the copy disagree with this section — so this section is the one owner of the text: edit it here, then copy the section whole into that constant.

Two shapes are deliberately absent from this section. An example fence, because the copy ships in the CLI's TypeScript source, where `no-fy-render-in-docs.sh` refuses a fence opener. And the per-type detail: the sections below distil the contract the rest of this document holds, and where the two disagree the contract wins and this section is wrong.

### overview

Write a fenced block whose info string is exactly `fy-render`: line 1 `type: <type>`, line 2 `alt: <one-line description>`, then a line `---`, then the payload. `type:` is always the first line, `alt:` is required (≤ 200 characters) and is the picture's description for a reader who cannot see it. `mime:` appears only on an inline `image`; a `src:` block has an empty payload. Any broken rule — an unknown type, an unknown or repeated key, a cap exceeded — renders as an ordinary code fence with no warning, so check that it drew. Chat only: never write fy-render into files, docs, commits or PRs.

### mermaid

Mermaid source (flowchart TB, sequenceDiagram, …): top-down, short labels. It is auto-themed: `%%{init}%%`, front matter and `theme`/`themeVariables`/`themeCSS` are ignored, and `style`/`classDef` colours still apply and fight the reader's theme — leave colours out. ≤ 20,000 characters. A wide left-to-right flowchart is redrawn top-down on a phone by itself, and the reader can scroll it sideways. A diagram that does not parse becomes a plain code fence.

### svg

One self-contained `<svg>…</svg>` (CSS animation welcome). No `<script>` or `on*` handler, no `<foreignObject>`, `<use>`, `<!DOCTYPE>` or `<!ENTITY>`, and no external reference — no web font, remote `<image>`, stylesheet, filter or mask: none of it loads in the `<img>` sink an SVG renders through. Give the root a `viewBox`, with `width`/`height` in plain numbers, `px`, or `%` of the viewBox. Caps: 100 KiB, 500 elements, 32 filter primitives, 8192 per axis, 16,777,216 pixels. Colours are yours — pick marks that read on light and dark, or set a background rectangle — and give text a real `font-family`.

### html

A fragment with inline CSS — tables, lists, `<details>`/`<summary>`, code, inline SVG, `<style>` — drawn straight into the message; nothing in it runs. Add a `<script>` or `on…=` handler only when the reader must do something: the block then runs as a live page in an isolated frame, marked "interactive" — one self-contained page with inline `<style>` and `<script>`, loading nothing from the network (no fetch, XHR, WebSocket, no CDN), no storage, no forms, no popups, never navigating, and no long loops (it stops after five seconds unresponsive or ten minutes). Theme tokens such as `var(--fg)` work; the fragment's styles cannot reach the app and the app's cannot reach it. ≤ 200 KiB, bounded in height, scrollable past that.

### chart

JSON/YAML {kind: bar, x: [Mon, Tue], y: {format: money}, series: [{name: Cost, data: [2, 3]}]}; kind line|bar|area|pie|doughnut|scatter|radar; format number|percent|money|duration|bytes; stacked; frames: [{label, series}] steps. No colours: tone accent|good|warn|bad|muted|1-8.

Say what the chart says; the reader's theme paints it. `title:` is optional; `y` (and a scatter's `x`) take `{label, format, currency, min, max}` — `money` takes an ISO 4217 `currency`, default USD, `duration` takes seconds, `percent` takes the number itself. `stacked:` on line, area and bar; `horizontal:` on bar; a series `kind: line` draws a line over bars; `null` in `data` is a gap; scatter data is `[[x, y], …]` on a numeric x axis. The reader gets tooltips, a legend they can toggle, zoom on line and area, and `frames` steps with Previous/Next and a slider; the numbers reach a screen reader as a table. Any key the language does not name — `color:` included — makes the block fall back to its source. Caps: 64 KiB, 12 series, 500 points a series, 500 labels, 30 frames.

### map

JSON/YAML {center: [lat, lng], zoom, markers: [{at, label, popup}], lines: [{points}], polygons, geojson}; real places.

`center` is `[lat, lng]`; omit it to fit the view to everything drawn. `zoom` is 0–18 (with a fit, the closest the fit may zoom). Markers carry `at`, `label` and `popup`; `lines` are routes (`points: [[lat, lng], …]`, `label`); `polygons` need three points a ring; `geojson` takes Point, LineString, Polygon and their `Multi*`/Feature/Collection forms. Colours: `red`, `blue`, `green`, `amber`, `purple` or `#hex`. An interactive map with OpenStreetMap tiles as its one remote load: pan, zoom, tap a marker for its popup. Caps: 32 KiB, 100 markers, 50 lines+polygons, 2,000 vertices; a refusal falls back to a coordinates list.

### media

save files you make into $FY_MEDIA_DIR and put `src: media:<file name>` before `---`, with no payload; `src: @workspace/path` and `src: https://…` also work.

That is `image`, `video`, `audio` and `pdf` — they name bytes instead of carrying them, and nothing follows the `---`. `media:<file>` is the one for anything you MADE: `$FY_MEDIA_DIR` is your session's media folder, outside every repository, so no ignore rules decide whether it can be shown; name the file by its path inside that folder. `src: @workspace/path` is written as an `@file` reference without a line, read with the reader's access — gitignored and protected files are never served, at most 1 MiB. For `src: https://…`, video and audio play directly; an image must come from a host that allows cross-origin reads (at most 2 MiB) or becomes a link; a pdf is always a link. `http:`, `data:` and `blob:` are refused. Extensions: image png/jpg/jpeg/gif/webp, video mp4/m4v/webm/ogv/mov, audio mp3/m4a/aac/wav/ogg/oga/opus/weba/flac, pdf. An `image` may instead be inline — `mime: image/png|jpeg|gif|webp` with a base64 payload, still, matching the declared type, ≤ 2 MiB decoded — `src:` or `mime:`, never both.

### lottie

A Lottie animation as JSON — the one animated type, with Pause/Play. No expressions: a string-valued `"x"` key anywhere is refused; export without expressions. No remote assets: embed images as `data:` URIs or leave them out. Caps: 1 MiB, 500 layers, 64 levels deep. It plays while on screen, starts paused under reduced motion, and stops after two minutes with Replay.

---

## Declared gaps

What this build knowingly does not do. Each of these is why row 65 is **not** ticked.

0. **`type: map` leans on a third party's tile server.** Tiles come from OpenStreetMap's public servers under its
   usage policy: the tile host sees the reader's IP and the area viewed (and a Referer carrying this app's
   origin), a hosted-provider swap is the answer to heavy use, and an offline or blocked tile host leaves
   pins on a blank background. Polygon holes are dropped (a polygon is its outer ring). Touch pan and
   pinch were not exercised on a physical device in this build (the Chromium suite emulates a
   coarse pointer), which is why Fullscreen is the documented route to full control. The page itself runs no
   author code for a map.

1. **`type: html` is a static fragment, and its residual is the sanitizer's.** Nothing in a fragment
   runs, so the egress an opaque frame could not close — self-navigation, prerender, WebRTC — has
   nothing to run it. What remains is the class of every HTML sanitizer: a DOMPurify parsing
   differential, or a browser feature it does not know to strip, would put author markup in the page
   as live DOM. Mitigated by: DOMPurify's own allowlist plus this build's narrower one, the URL and CSS
   rules, the closed shadow root and paint containment, a pinned DOMPurify version, and the page's
   policy underneath — `require-trusted-types-for 'script'` refuses a string at any script sink, and
   `img-src`/`font-src`/`connect-src` refuse a remote load. **Not eliminated.** Same-origin `url()` loads
   are refused by the CSS rewrite, not by the policy (`img-src 'self'` would allow them); the security
   test fails if that rewrite is ever removed. Anyone who considers this unacceptable should map
   `html` to source-only; nothing else depends on it.

2. **`type: mermaid` and `type: lottie` carry a residual risk that is not eliminated.** No
   attacker-authored code runs — but a trusted LIBRARY compromised by its own untrusted data would
   execute inside the opaque frame, and the proven `<link rel=prerender>` and WebRTC STUN/TURN egress
   channels would then be reachable, because CSP does not close either. Mitigated by: the shell
   holding no primitive that can run unpinned bytes, `securityLevel: 'strict'`, the `lottie_light`
   build with no expression evaluator, the parse-time refusal of string-valued `"x"` keys, the
   structure and size caps, and the re-admission of compiled Mermaid output through the SVG gate.
   **Not eliminated.** Anyone who considers this unacceptable should ship `svg`/`image` alone, which
   is a coherent product.
3. **No CPU or memory bound on anything, in any form.** The caps bound **input size and declared
   dimensions, and nothing else**. The sandbox watchdogs bound **wall-clock lifetime only** — 15
   seconds for a Mermaid compile, 120 seconds for a Lottie frame, ten minutes and a five-second stall
   guard for an interactive page — so they bound how long a payload
   may compute and say nothing about how hard. Browsers offer no per-frame CPU or memory quota at
   all. A payload inside every limit and still expensive to rasterise is bounded in neither what the
   machine spends nor, for the non-sandbox types, how long the reader waits. Do not describe the caps
   as bounding compute, do not describe the watchdogs as a quota, and do not describe the trust gate
   as isolation — it decides WHO starts the work and WHEN, not how much of it there can be.

   **NEITHER WATCHDOG HAS A BROWSER CAPTURE, and both are unit-proven only.** The 15-second Mermaid
   deadline and the 120-second Lottie lifetime are wall-clock by design, so a browser test would have
   to wait that long to see one fire; the real-component Chromium journey therefore does not capture
   either. What is proven, in `tests/unit/fy-render-sandbox.test.tsx` against shortened deadlines, is
   that each timer fires with the right class (`deadline` for Mermaid, `lifetime` for Lottie), that no
   message from the frame clears it; `tests/unit/fy-render-block.test.tsx` proves how the block
   presents each. Nothing anywhere may describe
   either bound as browser-measured. See
   [Accepted risk](#accepted-risk).

4. **Cross-browser coverage is one engine, and Chromium proof is not Safari proof.** Every measured
   result in this document — the `<img>` sink, the CSP hash pinning, the zero-request ledger — is
   Chrome 150, headless, on Linux. Firefox is unmeasured. Safari is the consequential one for a PWA,
   and CSP inheritance into a sandboxed local-scheme document is exactly the behaviour that has
   differed between engines, so the sandbox types depend on it more than the static ones do.

   **This is a RELEASE GATE, not a footnote.** Safari coverage is a real `macos-15` `safaridriver`
   job that runs the same journey against the same generated shell, and the load-bearing assertion it
   must carry is the hash-gated dynamic inline install: that a script whose text matches a pinned
   `script-src` hash runs, and that the identical primitive with any other text does not. Playwright's
   bundled WebKit is **not** accepted as a substitute — it is not Safari, and the question here is
   about a specific engine's CSP behaviour.

   Honest residuals even once that job is green: the **iOS Simulator**, a **physical iOS device**, and
   the **real Cloudflare Pages `_headers` precedence** (the `!` detachment and `frame-ancestors`
   behaviour can only be confirmed against an actual Pages preview deploy, never locally). None of
   those are covered by a macOS runner, and none should be described as covered.

   **The `html` fragment and the media stage are Chromium-only today.** The Safari job runs the library
   sandbox journey; it does not yet render a fragment or play a `src:` block, so nothing about either
   may be described as Safari-measured — including Safari's Trusted Types support, which differs.

5. **SVG admission is prefix-only, a deliberate deviation from the approved plan.** The plan asked
   for a structural "exactly one well-formed `<svg>` root". The grammar checks that a payload
   _begins_ with an `<svg>` element and does not parse the document, because the alternative is a
   `DOMParser` in `src/lib` — the domain tier, where no other module in this package touches the DOM.
   The browser's decode is the well-formedness check instead, and its failure is visible through the
   error fallback above. Nothing in this repository may describe that scan as validating a
   well-formed or single root.
6. **`<use>` is rejected outright rather than cycle-checked.** A real answer is a reference-cycle
   detector and is not worth building for a chat illustration. The probe showed the `<img>` sink
   neutralises `<use>` anyway, so this is authoring policy, not defence. Other same-document
   references are unaffected: a `url(#id)` naming a `<marker>`, `<clipPath>`, gradient or pattern
   defined inside the payload resolves normally, which is how an author draws an arrowhead. Every
   reference OUT of the payload remains forbidden by the authoring contract, and this is scoped to the
   measured `<img src="data:image/svg+xml,…">` sink — it says nothing about inline SVG.
7. **The external XML entity vector is unmeasured, not passed.** Chrome did not fetch it even in the
   active positive control, so no conclusion is claimed. It is refused by the grammar regardless.
8. **`image/avif` is not accepted.** An AVIF carries per-item `ispe` extents, and deciding which one
   a decoder actually uses means resolving `pitm` into `ipma` property associations. A parser reading
   the first box lets a small decoy mask a huge primary item — measured: a 64×64 `ispe` declared ahead
   of a 70000×70000 one was read as 64×64 and accepted. Taking the maximum over every box closes
   that, but no real AVIF sample and no sequence fixture were available on this machine to verify
   either the parser or the animation exclusion against a decoder, and an allowlist entry that cannot
   be demonstrated is a claim that cannot be backed. It returns when a decoder-verified sample and an
   adversarial primary-item fixture exist.
9. **Animation is refused rather than supported.** APNG (`acTL`), multi-frame GIF and animated WebP
   (`VP8X` flag, `ANIM`, `ANMF`) are all rejected, because this build has no Pause control and must
   not show a loop nobody can stop. That is a real limitation for authors, not a security property.
10. **The raster readers are this repository's own.** Their dimensions were cross-checked against
    Chrome's decoder — PNG, JPEG, WebP and GIF at 1×1 through 8192×2048, 18 samples, all matching
    `naturalWidth`/`naturalHeight` — but a container this parser refuses is refused even if a browser
    would have decoded it. The bias is deliberate and one-directional: it fails toward not rendering.
11. **A workspace media file is capped at 1 MiB**, because that is what the session filesystem route
    serves per file (`MAX_FILE_BYTES`), base64 over JSON. A real screen recording is larger than that
    and gets the "larger than 1 MB" row. Lifting it needs a streamed, range-capable byte route on the
    daemon, which is a separate change with its own grant review — not a bigger number here.
12. **An https image needs the host's permission to be read.** It is fetched by the parent in `cors`
    mode so that its bytes can pass the admission checks; a host that sends no
    `Access-Control-Allow-Origin` gets the link row instead. That is the price of not widening
    `img-src` for every Markdown image in the app, and it is paid deliberately.
13. **Rendering without a gesture is the owner's decision, with a residual.** An interactive page
    runs, an https `src:` is contacted, and decode or compile work is spent as soon as a block is near the
    viewport. [Inline by default](#inline-by-default--the-owners-decision) states each residual and the
    terms it is accepted on.
14. **"Near" and "settled" are unit-proven, not browser-measured.** The proximity gate is
    `IntersectionObserver` with an 800px margin and the settle window is 400 ms; both are proven in
    `tests/unit/fy-render-block.test.tsx` against a fake observer and a shortened window. No Chromium
    journey scrolls a long transcript to show a block far away doing nothing, so nothing may describe
    the gate as browser-measured.
15. **The long press is unmeasured on a real phone.** It is a 450 ms touch held still, driven in
    Chromium's touch emulation. A real iOS or Android browser may also open its own context menu for a
    long-pressed image; the corner tools still appear, but the overlap is unmeasured.

16. **An interactive `html` page executes, and the egress a browser-only sandbox cannot close stays.**
    Probed before and measured again against the shipped shell: in an opaque `sandbox="allow-scripts"`
    frame, script can **navigate the frame itself** (the server receives it), `<link rel="prerender">`
    can open a connection under `default-src 'none'`, and `RTCPeerConnection` can send STUN/TURN under
    `connect-src 'none'`, with Chromium rejecting `webrtc 'block'`. **Mitigated:** the frame is opaque,
    so the app's storage, cookies, document, globals and daemon tokens are out of reach (measured); every
    ordinary request is refused (measured against a ledger); markup-level prerender, refresh, `base`,
    frames and speculation rules are stripped and the RTC constructors deleted before the page runs; a
    navigation tears the frame down; the page runs only near the viewport, stops when it stops
    responding, and lives at most ten minutes. **Accepted, and what it can cost:** author script can
    rebuild a prerender link, reach WebRTC through a path the deletion missed, or navigate the frame —
    each of which carries a request from the reader's device. **The worst case leaks only what the page
    itself holds — its own authored content and the reader's IP address — never anything of the app**,
    plus a convincing page shown for the instant before a navigation is torn down (a phishing surface).
    Accepted because the owner asked for interaction, the author is the owner's own ferret (which already
    has network access on its host), nothing of the app is reachable to put in such a request, and the
    agent is told to prefer static HTML and to use script only when interaction genuinely helps. No
    browser offers a per-frame CPU or memory quota, so the stall guard and the lifetime are proven
    against shortened windows in `tests/unit/fy-render-html-frame.test.tsx`, not by waiting in a browser.
    Anyone who considers this unacceptable can route every `html` block to the fragment by making
    `fyRenderHtmlRunsScript` answer `false`; nothing else depends on it.

17. **`type: chart` runs a bundled library in the page on author-shaped data.** Nothing an author writes
    is code, markup, a style or a URL — a strict schema reduces it to numbers and short labels, and every
    function Chart.js is given is this package's — but Chart.js, its zoom plugin and Hammer.js still run
    in this document, so a bug their own input reaches would run here, as Leaflet's would for a map.
    **Mitigated by**: the closed language and its caps, pinned versions, a build test that fails an upgrade
    adding a markup, eval or network sink, and the page policy underneath (Trusted Types, `connect-src`).
    **Not eliminated.** Measured in Chromium only (gap 4); touch zoom in fullscreen is driven in touch
    emulation, not on a physical phone. Anyone who considers this unacceptable can map `chart` to
    source-only; nothing else depends on it.

## Evidence

Every claim above is either a test in this repository or one of these probe records. They are session
artifacts outside the repository; cite them, do not assume they will outlive the session.

| Claim                                                                                                                                                                                                                                                                                       | Record                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<img>`-loaded SVG: zero egress, no script/handler execution, Chrome 150                                                                                                                                                                                                                    | `svg-img-security-probe-report.md` with `svg-img-network-*`, `svg-img-same-origin-*` and `svg-img-script-*` ledgers                                                    |
| Opaque-frame self-navigation, prerender and WebRTC egress; Navigation API inert                                                                                                                                                                                                             | `self-navigation-result.md` with `nav-*.json` and `egress-output.json`                                                                                                 |
| Independent review concluding executable HTML is a release blocker                                                                                                                                                                                                                          | `sandbox-security-verdict.md`                                                                                                                                          |
| Slice plan, mechanism survey and cost sheet                                                                                                                                                                                                                                                 | `execution-boundary-plan.md`                                                                                                                                           |
| Static-slice security review that found the unbounded-decode blocker                                                                                                                                                                                                                        | `fy-render-static-security-review.md`                                                                                                                                  |
| UI/accessibility review of the fullscreen presentation                                                                                                                                                                                                                                      | `fy-render-static-ui-review.md`                                                                                                                                        |
| Raster header reader agreeing with Chrome's decoder, 18 of 18                                                                                                                                                                                                                               | `prototype/verify.ts` beside its `raster-header.ts`                                                                                                                    |
| Interactive `html`: storage, parent, token, top navigation, popups, ordinary requests refused; cover contained; self-navigation egresses and is seen                                                                                                                                        | `packages/pwa/tests/integration/fy-render-html.security.test.ts` (in this repository, real Chromium + request ledger)                                                  |
| `html` fragment: an XSS corpus runs nothing, loads nothing and escapes nothing under the app policy                                                                                                                                                                                         | `packages/pwa/tests/integration/fy-render-fragment.security.test.ts` (in this repository, real Chromium + request ledger)                                              |
| The production build renders every form inline, from an agent's reply, with media from `FY_MEDIA_DIR`                                                                                                                                                                                       | `tests/e2e/product-journeys.e2e.test.ts` step `hypermedia-renders-inline` (in this repository)                                                                         |
| A map renders inline under the real Pages headers: tile requests go only to the tile origin, no Trusted Types or CSP violation, pins present                                                                                                                                                | `tests/e2e/fy-render-pages.e2e.test.ts` (production build under `wrangler pages dev`, tiles fulfilled by a fake)                                                       |
| Markers + route, light and dark, phone and desktop                                                                                                                                                                                                                                          | `packages/pwa/tests/integration/fy-render-component.visual.test.tsx` (real Chromium, tiles fulfilled by a fake)                                                        |
| Charts: theme colours as exact canvas pixels, legend, tooltip, frames by button and keyboard, box zoom and Reset, no touch gesture bound inline, doughnut slices, repaint on a same-mode theme switch, the source fence for a painted chart, all eight palette slots apart in all 22 themes | `packages/pwa/tests/integration/fy-render-component.visual.test.tsx` (real Chromium)                                                                                   |
| Mermaid: painted from the theme tokens, light and dark, phone and desktop; redrawn on a same-mode palette switch; a `%%{init}%%` or front matter asking for `forest` and red reaches nothing                                                                                                | `packages/pwa/tests/integration/fy-render-component.visual.test.tsx` (real Chromium, the real shell and bundle)                                                        |
| A left-to-right flowchart drawn top-down on a phone at 16px text and kept left-to-right on a desktop (scrolling, never under 12px); redrawn across the breakpoint on rotation                                                                                                               | `packages/pwa/tests/integration/fy-render-component.visual.test.tsx` (real Chromium); the rewrite itself in `packages/pwa/tests/unit/fy-render-mermaid-layout.test.ts` |
| The chart libraries hold no markup, eval or network sink                                                                                                                                                                                                                                    | `packages/pwa/tests/unit/build-contract.test.ts`                                                                                                                       |
| The library shell is frameable under Pages pretty URLs; the `fy-fragment` policy and no other is allowed                                                                                                                                                                                    | `tests/e2e/fy-render-pages.e2e.test.ts` (production build under `wrangler pages dev`)                                                                                  |
