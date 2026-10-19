# `fy-render` — inline illustrations in a conversation

A fenced block an assistant can put in its own chat message so a diagram, a drawing or a screenshot
renders where the explanation is, instead of as a wall of markup the reader has to imagine.

**Read this first: one type runs an author's code, and it runs it somewhere that cannot reach the
app.** `svg` and inline `image` become an `<img>` directly. `mermaid` and `lottie` are handed as
**data** to a trusted library running inside an opaque-origin sandbox frame — a library interpreting
data, not a payload running code. `html` **executes**: an agent-authored interactive page runs inside
its own opaque-origin frame, on its own static shell, under its own policy, with no storage, no reach
into this document, no daemon token and no ordinary network ([The `html` frame](#the-html-frame)).
`image`, `video`, `audio` and `pdf` with a `src:` header name bytes that live in the session's
workspace or behind an https link, and are read or fetched once the block is near the viewport
([Media from `src:`](#media-from-src)).

Running `html` is a decision the owner asked for, made with the measured residual stated rather than
hidden: an opaque frame that runs script can still navigate itself, prerender and open WebRTC, and no
browser bounds a frame's CPU or memory — [gap 1](#declared-gaps) says exactly what is mitigated and
what is accepted. [handover.md](../handover.md) row 65 **stays open**: it asks for author JavaScript
under an enforceable CPU and memory bound, and a wall-clock lifetime is not that.

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

| Key    | Required                                             | Value                                                                       |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `type` | yes, **and on the FIRST line**                       | one of `html`, `svg`, `lottie`, `mermaid`, `image`, `video`, `audio`, `pdf` |
| `alt`  | yes                                                  | ≤ 200 characters, one line, no control characters                           |
| `mime` | for an inline `image` only                           | one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`                 |
| `src`  | for `video`, `audio`, `pdf`; or instead of an `mime` | `@path` in the session's workspace, or an `https://` URL; ≤ 2048 characters |

`type` is positional, not merely present, so a block is identifiable from its opening line alone — by
a reader scrolling and by a grep. `alt` is required rather than optional so an author cannot ship an
inaccessible block by omission; leaving it out is a parse error, not a quieter render. Any other key
is a parse error, and so is a repeated one.

**`image` has two exclusive shapes**: `mime:` with an inline base64 payload, or `src:` with none.
Both together is a parse error — the reader would not know which bytes they were shown. A block
with a `src:` must have an **empty payload** (blank lines are not content).

**`src:` is one of two things and nothing else.** `@path` is an `@file` reference, parsed by the
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

| Type      | Payload cap                      | Also refused                                                                                                                                                                                                                                                                               |
| --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `html`    | 200 KiB                          | —                                                                                                                                                                                                                                                                                          |
| `svg`     | 100 KiB                          | `<!DOCTYPE>`/`<!ENTITY>`; `<script>`; `<foreignObject>`; `<use>`; more than 500 element opening tags; more than 32 filter primitives; a declared canvas over 8192 per axis or 16,777,216 pixels; an unterminated comment, CDATA section or tag; a payload that does not begin with `<svg>` |
| `mermaid` | 20,000 characters                | —                                                                                                                                                                                                                                                                                          |
| `lottie`  | 1 MiB                            | invalid JSON; a non-object root; a **string-valued** `"x"` expression key at any depth, or an array containing one at any index; more than 500 layers; deeper than 64 levels                                                                                                               |
| `image`   | 2 MiB decoded (≈ 2.7 MiB base64) | anything that is not canonical base64; bytes that disagree with the declared MIME; a declared size over 8192 per axis or 16,777,216 pixels; animation; a container that fails the selected admission checks below                                                                          |
| `src:`    | no payload at all                | a workspace file over **1 MiB** (the daemon's own per-file view limit, mirrored, not chosen); an https `image` over 2 MiB; an `image` whose fetched bytes fail the same admission checks below                                                                                             |

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

| Type             | Renders as                                                            | Why                                                                                                      |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `svg`            | `<img src="data:image/svg+xml,…">`                                    | The measured boundary — see below                                                                        |
| `image` (inline) | `<img src="data:{mime};base64,…">`                                    | No script surface exists in a raster decode                                                              |
| `html`           | a live page in its own opaque frame, `/fy-render-html.html`           | The owner asked for interactive explanation; [The `html` frame](#the-html-frame) is the boundary         |
| `mermaid`        | `<img src="data:image/svg+xml,…">`                                    | Compiled to SVG in the sandbox frame, then re-admitted through the same gate an authored SVG passes      |
| `lottie`         | live player inside the sandbox frame                                  | An animation has to keep running to animate, so this one stays live                                      |
| `image` (`src:`) | `<img src="blob:…">` of admitted bytes                                | Workspace or https bytes, checked like inline ones — [Media from `src:`](#media-from-src)                |
| `video`          | the browser's native `<video controls>`                               | A workspace file as a `blob:`; an https URL directly, which `media-src https:` admits                    |
| `audio`          | the browser's native `<audio controls>`                               | As `video`                                                                                               |
| `pdf`            | a file row: workspace Open / Download of a minted `blob:`; https link | Measured: Chromium blocks its PDF viewer in a sandboxed frame, and the app policy refuses `blob:` frames |

### The `html` frame

An `html` block, once it is near the viewport, mounts `/fy-render-html.html` in an
`<iframe sandbox="allow-scripts">` (`fy-render-html-frame.tsx`). It is a **separate static shell**
from the library sandbox's, with a **separate policy**, because it exists to do the one thing the other
forbids: run code an agent wrote.

- **Its own document, because nothing else works.** A `blob:` or `srcdoc` frame inherits the parent's
  hash-pinned policy and could run nothing; a static same-origin document with its own policy is the
  only shape that runs author script without widening the app's. Its `public/_headers` rule is the
  library shell's — the `!` detachment line so `/*`'s `frame-ancestors 'none'` does not make it
  unframeable, and `sandbox allow-scripts` so a direct visit is opaque — and
  `scripts/validate/pages-config.sh` pins both.
- **Opaque origin and nothing else granted.** No `allow-same-origin`, so no storage, no cookies, no
  `parent.document`; no `allow-forms`, `allow-popups`, `allow-modals`, `allow-top-navigation` or
  `allow-downloads`. The parent trusts `event.source` identity only, as the library frame does.
- **Its policy**, in the generated document's `<meta>` and checked by the build:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`.
  No `'unsafe-eval'`, no `'self'`, no scheme source.
- **The page arrives as data.** The bootstrap — the only script in the shell — receives the authored
  page over the `MessagePort`, parses it with `DOMParser` (which runs nothing), strips `meta`, `base`,
  `link`, embedded frames and objects, moves the rest in, and only then re-creates its classic and
  module `<script>`s so they run in order; every other script `type`, speculation rules included, is
  dropped. It removes the `RTCPeerConnection` family of constructors before any author code runs, and
  forwards Escape from a capture listener installed first, so a page cannot swallow the one key that
  leaves fullscreen.
- **The page is interactive.** The frame takes the pointer and is a tab stop (`tabIndex={0}`, so the
  fullscreen focus trap counts it). Its height is the page's own report, clamped to 640px inline; past
  that the page scrolls inside its frame, and Fullscreen gives it the plane.
- **Frameless, in the column's own paint.** The parent reads the message column's computed
  background (the first painted ancestor's), text colour and font family and sends them with the page,
  and again on every theme switch over the live port — a repaint, never a remount. The shell sets
  them on its root with `style.setProperty`, which drops a value that does not parse; none of the
  three properties can name a URL, so a value is paint and nothing else (measured: a `url(…)` smuggled
  into each produces zero requests). Body margin is zero, so the page sits flush with the prose, and
  any author stylesheet overrides all of it. The frame stays invisible until its first draw, so no
  unpainted plane flashes.
- **Its height is the body's**, not the root's: a root's `scrollHeight` is never less than the
  frame's viewport, so a short page would otherwise keep a band of empty background under it.
- **A navigation tears it down.** Author content is moved in by script and fires no `load`; the
  parent counts `load` events from the moment it sets `src` (inserting a src-less iframe fires one for
  its initial `about:blank` — measured, and not a navigation). A second one means the page sent its
  frame somewhere else, and the block quietly falls back to the authored source.
- **Ten minutes of wall-clock life**, armed at mount and cleared by nothing the page says, then a
  neutral `lifetime` stop — one muted line and **Run again**. It bounds how long author code runs, never how hard.

**Measured in real Chromium** (`tests/integration/fy-render-html.security.test.ts`, the real generated
shell, a server-side request ledger): author script runs, reports its height and answers a real
click; `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `parent.document` and the
parent's globals yield nothing of the app, and no token the parent holds appears anywhere the frame can
read; `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, a remote image, a worker,
a nested frame and a form submission produce **zero** requests at the server; `eval` is refused; a
popup is `null`; an authored `<meta http-equiv="refresh">`, `<link rel="prerender">`, `<base>` and a
speculation-rules script cause no navigation and no request. And the residual, measured as a
residual: a page that sets `location.href` **does** reach the server, and the parent **does** see the
second `load` it tears the frame down on.

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
height (`min(60dvh, 720px)`), an `html` page is frameless and painted with the column's own
background, text colour and font, and a PDF is the same compact file row an attachment is.

**What changed is who starts the work, and nothing else.** Every security property of where author
bytes run is untouched: the `<img>` sink for `svg`, inline `image` and compiled Mermaid; the
opaque-origin library sandbox for `mermaid` and `lottie`; the opaque-origin `html` shell with its own
policy, no `allow-same-origin`, no storage, no reach into the app or the daemon; the media capability
that reads a workspace file as the reader and never holds a connection. The gesture gate in front of
all of them is gone. What replaced it bounds where and when work happens, and **not** how much:

- **Near the viewport.** A block renders the first time it comes within about one phone screen of the
  viewport (`IntersectionObserver`, `800px` vertical margin) and stays rendered. A block far down a
  long transcript decodes nothing, downloads no renderer, runs no page and reads no file until the
  reader scrolls toward it.
- **Settled bytes.** A block's first bytes render at once, so a finished message from history never
  waits; later bytes replace them only once they have stopped changing for 400 ms. A streaming
  assistant therefore does not re-decode a partial SVG, recompile a diagram or restart a page on
  every token. A change of type takes effect immediately.
- **On screen only, for the two things that should be.** A Lottie animation plays only while it is on
  screen (or fullscreen), and a diagram drawn for the other theme is redrawn only while it is on
  screen — so a theme switch with ten diagrams in a transcript redraws the ones in view, and the rest
  as they come back into view, never all at once.

**The residual this adds, stated rather than softened.** The gesture was the reader's chance to decline
work an agent asked their device to do. Without it:

1. **An `html` page runs as soon as it is near**, so gap 1's egress residual — self-navigation,
   prerender, WebRTC from the reader's device — is reachable without the reader choosing it. The frame
   is still opaque, holds no token and can read nothing of the app; what leaves is the reader's IP
   address and the fact that the message was scrolled to.
2. **An https `src:` is contacted as soon as it is near.** The reader's browser fetches an https
   `image` (credentials omitted, no referrer) or hands an https `video`/`audio` to the native player
   with `preload="metadata"`, so the host learns the reader's address without a press. An https `pdf`
   is still a link and contacts nothing until it is followed.
3. **Decode and compile cost is spent without asking.** A payload inside every cap can still be
   expensive to rasterise or compile, and it now is, once near. The caps bound the input; the 15 s,
   120 s and 10 min watchdogs bound wall-clock life; nothing bounds CPU or memory (gap 3).

These are accepted on the same terms gap 1 already gives: the author is the owner's own ferret, which
already runs on a host with network access; nothing in the app is reachable to put in a request; and
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

| Form                              | Source | Fullscreen | Play / Pause |
| --------------------------------- | :----: | :--------: | :----------: |
| `svg`, `image`, compiled Mermaid  |  yes   |    yes     |      —       |
| `lottie`                          |  yes   |    yes     |     yes      |
| `html`                            |  yes   |    yes     |      —       |
| `src:` `image` / `video`          |  yes   |    yes     | the player's |
| `src:` `audio`                    |   —    |     —      | the player's |
| `pdf` and every media refusal row |   —    |     —      |      —       |

An audio player gets no icons because its own controls fill that corner and there is nothing to see
in fullscreen; a file row has its own Open and Download actions.

- **Source** shows the whole fence body as an ordinary code block, escaped and truncated at 32,768
  characters, capped at `50dvh` inline and scrolling inside itself. It is a named `<section>` with
  `tabIndex={0}`, so a keyboard reader can pan a payload that is one enormous line. Its control
  carries `aria-expanded`, and `aria-controls` only while the panel exists.
- **Fullscreen** is an in-app overlay (`role="dialog"`, `aria-modal`), not the Fullscreen API, which
  iOS Safari lacks. It carries `kt-overlay`, the app's visible-viewport contract; Escape closes it —
  from inside an `html` page too, because the shell forwards Escape over the port from a capture
  listener installed before author code — Tab is trapped both ways, and focus returns to the icon
  that opened it. A failure closes it, so Exit never vanishes under a reader standing in it.
- **Play / Pause** is a command on the live capability port, never a remount. Under
  `prefers-reduced-motion: reduce` an animation starts paused, and **the icons stay visible while it
  is paused**, so Play is never behind a hover a reader may not have. Once the reader presses either,
  that choice wins until the animation's bytes change. An authored `svg` carrying SMIL or CSS
  animation is outside this, as before.

**The description is the picture's own.** With no caption, `alt` goes where a screen reader finds it:
the `<img>`'s `alt`, the `<video>`/`<audio>` `aria-label`, and the `html` frame's `title`. The
fullscreen dialog is named `Illustration: <alt>`.

**The library frame is deliberately unreachable by keyboard and pointer** (`tabIndex={-1}` plus
`pointer-events: none`): it holds no control, and focus resting in a separate document would swallow
the Escape that leaves fullscreen. The `html` frame is the opposite — its page is the interaction —
so it takes the pointer and a tab stop.

### Error fallback

**A failure falls back to the code block, quietly.** A payload the browser will not decode, a diagram
Mermaid will not parse, a compiled diagram the re-admission gate refuses, a sandbox that never
started, a renderer that did not load, a compile that ran out of time, and an `html` page that
navigated away all show the authored source as the ordinary fence it would have been without this
feature — `.md pre`, nothing else. No sentence in the app's voice says it failed. The class travels as
`data-fy-render-failure` and the raw library or gate wording as the element's `title`, for whoever is
debugging; a jison dump quoting the author's own source is never presented as the app speaking.

**A retry only where one can help.** `startup`, `library` and `deadline` are about the deployment —
a shell that did not answer, a bundle that did not load, a cold multi-megabyte download that used up
the 15 s bound — so they carry one muted **Try rendering again** link. Bytes the browser or the
library refused, and a page that navigated, would only do the same thing again, so they carry none.

**A designed stop is not a failure.** A Lottie frame reaching its 120 s life, or an `html` page its
ten minutes, keeps its place with one muted line — "This animation stopped." or "This interactive page
stopped after ten minutes." — and **Replay** / **Run again**. No code block, no error mark.

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

## Declared gaps

What this build knowingly does not do. Each of these is why row 65 is **not** ticked.

1. **`type: html` executes, and the egress residual a browser-only sandbox cannot close stays.** Three
   independent probes established it before this build, and `fy-render-html.security.test.ts` measures
   the first again against the shipped shell: in an opaque-origin `sandbox="allow-scripts"` frame,
   hostile script performed a real **self-navigation** that the server received;
   `<link rel="prerender">` produced a real connection under `default-src 'none'`; and
   `RTCPeerConnection` sent real STUN and TURN UDP under `connect-src 'none'`, with Chromium rejecting
   `webrtc 'block'` as unrecognised. The Navigation API is inert in that frame, so it cannot veto a
   navigation either.

   **What is mitigated.** The frame is opaque, so the app's storage, cookies, document, globals and
   daemon tokens are out of reach — measured. Every ordinary request (fetch, XHR, WebSocket,
   EventSource, beacon, image, worker, nested frame, form) is refused — measured against a ledger.
   Authored `meta` refresh, `base`, `link` (prerender/prefetch), embedded frames and speculation-rules
   scripts are stripped before the page runs, and the `RTCPeerConnection` family is deleted from the
   frame's global first. A navigation is detected by its second `load` and the frame torn down with a
   stated note, so the destination page does not stay on screen as if it were the explanation; the
   page lives at most ten minutes.

   **What is NOT closed, and is accepted.** Author script can still rebuild a prerender link or a
   speculation rule, reach WebRTC through any path the deletion missed, or navigate the frame — and
   each of those can carry a request **from the reader's device** to anywhere: the reader's IP address
   and the fact that they opened the block leave, and a navigated frame can show a convincing page
   for the instant before it is torn down (a phishing surface). The deletions are speed bumps and are
   described as such. **Accepted now** because the owner asked for interactive explanation; because
   the author is the owner's own ferret, which already runs on a host with network access and needs no
   reader's browser to make a request; because nothing in the app — no token, no storage, no daemon
   URL — is reachable to put in such a request; and because the owner chose inline rendering knowing
   this, which removed the press that used to stand in front of the page
   ([Inline by default](#inline-by-default--the-owners-decision), residual 1). A page now runs once it
   is near the viewport, and a navigation falls back to the authored source. Separately, no browser
   offers a per-frame CPU or memory quota, so "resource-bounded" has no browser-only implementation:
   row 65 stays open. Anyone who considers this residual unacceptable should restore `html` to
   source-only by mapping it to a non-executing presentation; nothing else depends on it.

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
   seconds for a Mermaid compile, 120 seconds for a Lottie frame, ten minutes for an `html` page — so they bound how long a payload
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

   **The `html` frame and the media stage are Chromium-only today.** The Safari job runs the library
   sandbox journey; it does not yet load `/fy-render-html.html` or play a `src:` block, so nothing about
   either may be described as Safari-measured.

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
13. **The `html` lifetime has no browser capture either.** Like gap 3's two watchdogs, the ten-minute
    bound is proven against a shortened deadline in `tests/unit/fy-render-html-frame.test.tsx`, not by
    waiting ten minutes in a browser.
14. **Rendering without a gesture is the owner's decision, with a residual.** An `html` page runs, an
    https `src:` is contacted, and decode or compile work is spent as soon as a block is near the
    viewport. [Inline by default](#inline-by-default--the-owners-decision) states each residual and the
    terms it is accepted on.
15. **"Near" and "settled" are unit-proven, not browser-measured.** The proximity gate is
    `IntersectionObserver` with an 800px margin and the settle window is 400 ms; both are proven in
    `tests/unit/fy-render-block.test.tsx` against a fake observer and a shortened window. No Chromium
    journey scrolls a long transcript to show a block far away doing nothing, so nothing may describe
    the gate as browser-measured.
16. **The long press is unmeasured on a real phone.** It is a 450 ms touch held still, driven in
    Chromium's touch emulation. A real iOS or Android browser may also open its own context menu for a
    long-pressed image; the corner tools still appear, but the overlap is unmeasured.

## Evidence

Every claim above is either a test in this repository or one of these probe records. They are session
artifacts outside the repository; cite them, do not assume they will outlive the session.

| Claim                                                                                                      | Record                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `<img>`-loaded SVG: zero egress, no script/handler execution, Chrome 150                                   | `svg-img-security-probe-report.md` with `svg-img-network-*`, `svg-img-same-origin-*` and `svg-img-script-*` ledgers   |
| Opaque-frame self-navigation, prerender and WebRTC egress; Navigation API inert                            | `self-navigation-result.md` with `nav-*.json` and `egress-output.json`                                                |
| Independent review concluding executable HTML is a release blocker                                         | `sandbox-security-verdict.md`                                                                                         |
| Slice plan, mechanism survey and cost sheet                                                                | `execution-boundary-plan.md`                                                                                          |
| Static-slice security review that found the unbounded-decode blocker                                       | `fy-render-static-security-review.md`                                                                                 |
| UI/accessibility review of the fullscreen presentation                                                     | `fy-render-static-ui-review.md`                                                                                       |
| Raster header reader agreeing with Chrome's decoder, 18 of 18                                              | `prototype/verify.ts` beside its `raster-header.ts`                                                                   |
| `html` frame: storage, parent, token, every ordinary request refused; self-navigation egresses and is seen | `packages/pwa/tests/integration/fy-render-html.security.test.ts` (in this repository, real Chromium + request ledger) |
