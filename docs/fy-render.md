# `fy-render` — inline illustrations in a conversation

A fenced block an assistant can put in its own chat message so a diagram, a drawing or a screenshot
renders where the explanation is, instead of as a wall of markup the reader has to imagine.

**Read this first: nothing in this build executes an author's code.** Four of the five declared types
render. `svg` and `image` become an `<img>` directly. `mermaid` and `lottie` are handed as **data** to
a trusted library running inside an opaque-origin sandbox frame — which is a different claim from
"author code is sandboxed", and the difference is the whole point: a library interpreting data is not
a payload running code. `html` is parsed, bounded, and shown as its own escaped source with the
limitation printed on screen.

That last one is a deliberate, evidenced decision, not an unfinished one —
[Declared gaps](#declared-gaps) says exactly what is missing and why, and
[handover.md](../handover.md) row 65 stays open because of it. **Row 65 is not closed by this build**:
it asks for arbitrary author JavaScript executing under an enforceable CPU and memory bound, and that
is not what ships.

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

| Key    | Required                       | Value                                                       |
| ------ | ------------------------------ | ----------------------------------------------------------- |
| `type` | yes, **and on the FIRST line** | one of `html`, `svg`, `lottie`, `mermaid`, `image`          |
| `alt`  | yes                            | ≤ 200 characters, one line, no control characters           |
| `mime` | if and only if `type: image`   | one of `image/png`, `image/jpeg`, `image/gif`, `image/webp` |

`type` is positional, not merely present, so a block is identifiable from its opening line alone — by
a reader scrolling and by a grep. `alt` is required rather than optional so an author cannot ship an
inaccessible block by omission; leaving it out is a parse error, not a quieter render. Any other key
is a parse error, and so is a repeated one.

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
decoder's job and it happens after the gesture, so read "admitted" as "passed these checks", never as
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

| Type      | Renders as                                 | Why                                                                                                 |
| --------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `svg`     | `<img src="data:image/svg+xml,…">`         | The measured boundary — see below                                                                   |
| `image`   | `<img src="data:{mime};base64,…">`         | No script surface exists in a raster decode                                                         |
| `html`    | escaped source, with the limitation stated | Executing it needs a boundary this build does not have ([gap 1](#declared-gaps))                    |
| `mermaid` | `<img src="data:image/svg+xml,…">`         | Compiled to SVG in the sandbox frame, then re-admitted through the same gate an authored SVG passes |
| `lottie`  | live player inside the sandbox frame       | An animation has to keep running to animate, so this one stays live                                 |

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
  fails if a bump reintroduces a direct `Function`/`eval`/constructor call. Mermaid is a weaker claim
  and is kept separate on purpose: its bundle carries four `Function("return this")` global-lookup
  fallbacks inherited from lodash, which never evaluate because `self` is defined in a browser and
  the `||` chain short-circuits, and which CSP would refuse anyway because `'unsafe-eval'` is absent.
  Short-circuit plus policy is not the same as absence, and the two must not be merged.
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

`packages/pwa/tests/unit/fy-render-block.test.tsx` asserts the absence of `iframe`, `object`,
`embed`, `script` and `canvas` in the rendered tree, so a future refactor that moves these bytes to a
consumer outside the measured one fails review even if the grammar is untouched.

### The grammar is a bound, not a sanitiser

The per-type checks reject a few obviously unsupported constructs and cap how much work a parser can
be made to do. They are plain string scans, they are bypassable, and **they are not what makes a
payload safe**.

This is measured too: 15 of the 25 hostile payloads above passed `parseFyRender` unchanged —
including external image, font, stylesheet and paint references, `xml-stylesheet`, SMIL external
`href`, `onload`/`onerror` attributes, HTTP anchors and `javascript:` anchors. Every one was harmless
because of the `<img>` sink, not because validation removed anything. They render inert or
incomplete, and the grammar does not promise otherwise.

So: read a refusal as "this will not do what you think", never as "this would otherwise have been
unsafe". Read an acceptance as "this is within the caps", never as "this will render".

---

## Controls

| Control             |  `svg` / `image`   |           `mermaid` / `lottie`           |        `html`         |
| ------------------- | :----------------: | :--------------------------------------: | :-------------------: |
| Render illustration |        yes         |                   yes                    |      **hidden**       |
| Source              |        yes         |                   yes                    | yes (open by default) |
| Fullscreen          |        yes         |            yes, once started             |          yes          |
| Caption             |        yes         |                   yes                    |          yes          |
| Reload              | yes, once rendered |            yes, once started             |      **hidden**       |
| Pause / Play        |     **hidden**     | `lottie` only — **hidden** for `mermaid` |      **hidden**       |

**"Once started", not "once rendered", and the difference is up to fifteen seconds.** For a sandbox
type the reader's consent is what reveals Fullscreen and Reload, and the frame behind them may still
be fetching a multi-megabyte renderer. That is deliberate — both controls can act on a frame that has
not drawn yet, Reload most of all — but the earlier wording claimed the stricter thing the rule
underneath this table states, and it was not true for these two types.

**Pause is hidden, never shown disabled**, and only `lottie` has it. A Mermaid diagram is static and
has nothing to pause, so it gets no control rather than a dead one — the same rule Reload and
Fullscreen already follow.

**`prefers-reduced-motion: reduce` covers `lottie` and nothing else.** It starts an animation paused
and never removes Play. The preference is read at the moment the reader presses Render, not when the
transcript row mounted: a row can sit unread for an hour, and the setting that matters is the one in
force when somebody actually asks. Once the reader has pressed Play or Pause, that choice wins and a
Reload will not undo it — but it is a choice about THOSE bytes, so a rewritten message starts the
decision over.

**An authored `svg` carrying SMIL or CSS animation is outside that**, and there is no Pause control
for it: the preference gates Lottie autoplay, and nothing in this build claims declarative SVG
animation is inert. Reading the paragraph above as blanket reduced-motion support would be reading it
as covering a type it does not reach.

**A consented sandbox render says so while it is happening.** One sandbox-only `role="status"` region
carries `Preparing the Mermaid renderer…`, then the ready outcome, then a failure — visible and spoken
(WCAG 4.1.3), because the frame is transparent until its library has been fetched, installed and run.
The streamed `svg`/`image` decode path is deliberately NOT in a live region: those bytes may still be
arriving, so a half-written payload fails for real and an announcement would report an error that is
not one yet.

**A failure is one fixed sentence per class, with the machine's wording folded away.** The five
classes are startup, library, render, deadline and lifetime; a Mermaid or Lottie library message and
the compiled-SVG gate's own refusal go inside a collapsed `Why` fold rather than into the sentence a
reader is shown, because a jison parse dump quoting the author's own source is not the app's voice. A
Lottie `lifetime` stop is not presented as a failure at all — no error tone, no source panel — because
nothing went wrong: a healthy animation reached its permitted life.

**A compiled Mermaid diagram belongs to the theme that compiled it.** Mermaid cannot see the page, so
it is told which way it is painted and bakes that into the SVG, which then lives on as an `<img>`.
Switching between a dark and a light theme therefore drops the diagram and recompiles it; consent is
untouched, because the reader approved those bytes and a repaint does not change that. Switching
between two themes of the same mode keeps the diagram.

**The frame is deliberately unreachable by keyboard and pointer** (`tabIndex={-1}` plus
`pointer-events: none`), which is why `useDialogFocus`'s focusable-element list has no `iframe` entry.
It holds no reader control — Play/Pause is a parent button that speaks over the capability port — and
it is a separate document, so a keydown inside it never reaches the parent where the app's Escape
listener lives. Focus resting there used to kill Escape for the one fullscreen state that has a frame
in it. The fullscreen host is itself focusable while open, so a control removed under the reader — the
Lottie watchdog takes Pause away with no action of theirs — hands focus back to the overlay instead of
to `<body>` outside it.

**No renderer-library fetch is initiated and no sandbox frame is created before consent.** Both live
in the frame's mount effect, and the frame is not mounted until the reader presses Render — asserted
by `should create no frame and fetch nothing until a reader asks`, which counts the requests this
component made. So a transcript full of unopened `mermaid` blocks costs no renderer download and no
renderer work. That is a statement about what this component initiates, not about the page it sits in.

A control that cannot act is hidden, not shown disabled — a disabled Reload on a block that is only
ever text is a promise the build does not keep.

### No browser decoder runs until the reader asks

**No browser decoder mounts automatically.** A payload's size is bounded; the work of drawing it is
not, and a transcript is written by an assistant rather than by the reader. So the stage states the
resource risk in one sentence — rendering starts only when the reader chooses, and may use
substantial browser resources — and one control starts the render. For `svg` and `image` that
control's accessible name carries the type and the bounded payload size, _Render illustration
(SVG, 4 KB)_, because there the source bytes ARE the whole cost.

**For `mermaid` and `lottie` it deliberately carries the type alone**, _Render illustration
(Mermaid)_. The source figure would be the wrong number: pressing Render on a 20 KB diagram may also
download a multi-megabyte renderer, so quoting the source would understate the action by two orders
of magnitude, while quoting the renderer would overstate every block after the first, since the
bundle revalidates to a 304. A figure meaning one thing for two types and something else for the
other two is worse than no figure, so the renderer download is named in the consent sentence — "may
download the … renderer on first use — cached bytes are revalidated" — where it can be stated
conditionally instead of pretending to a precision it does not have. The visible
label stays the short _Render illustration_ so the control row still fits one line at 390px. Neither
the note nor the name predicts what drawing will actually cost; that is not knowable before the
decode, which is the whole reason the decision belongs to the reader.

- **Approval belongs to the exact `block.source`** and is discarded the moment those bytes change, so
  a streamed message cannot inherit consent granted to an earlier draft of itself. That is the whole
  guarantee, and it is narrower than "nothing partial ever decodes" —
  [Streaming](#streaming-which-is-the-ordinary-case) states the exact truth.
- **There is no always-render setting**, deliberately: it would put the automatic path back.
- **Render becomes Reload in the same DOM slot**, so the control the reader just pressed is still
  under the focus ring afterwards.
- Not rendering costs a screen-reader user nothing: the required description is the visible caption,
  which is also the figure's accessible name.

### The rest

- **Source** prints the whole fence body as authored, escaped, truncated at 32,768 characters. For a
  source-only type it starts open, because the source is the only content there is. Inline it is
  capped at `50dvh` and scrolls inside itself, so one long block cannot push the rest of the message
  off screen. Its label is stable and its state is carried by `aria-expanded` plus `aria-controls`,
  rather than by a label and an attribute that could disagree.
- **Reload** starts the whole render again from the authored bytes. For `svg`/`image` it discards the
  `<img>` and decodes again; for `mermaid`/`lottie` it discards the compiled diagram or the running
  player and mounts a **fresh frame** under a new key, because removing the element from the DOM is
  the only reliable way to stop a frame's scripts — there is no `iframe.terminate()`. It is the
  recovery path from a decode failure, a compile failure and a stopped animation alike, and it is
  hidden for `html`, which never renders.
- **Fullscreen** is an in-app overlay (`role="dialog"`, `aria-modal`), not the Fullscreen API:
  `Element.requestFullscreen` is unavailable on iOS Safari, a first-class target for this PWA, and an
  overlay keeps Escape and the focus trap in the app's single `useDialogFocus` stack rather than
  split between the app and the browser. Escape closes it, Tab is trapped in both directions, and
  focus stays on — and returns to — the control that opened it. It carries `kt-overlay`, the app's
  visible-viewport contract, so it follows the shell's box and pays the bottom safe-area inset rather
  than running under a notch or behind a software keyboard. The illustration fits the plane in both
  axes; a stage whose content is a note does not shrink, so a long source panel cannot squeeze the
  sentence explaining the block down to a sliver.
- **The caption** carries the required description once. The `<img>` is `alt=""` on purpose: the
  caption already names the figure and the fullscreen dialog, so repeating it would make a screen
  reader say the same sentence three times, four in fullscreen.
- **Pause / Play** exists for `lottie` and nothing else, because `lottie` is the only thing in this
  build that animates under the app's control. It is a command on the live capability port, not a
  remount, so pausing does not restart the animation. A Mermaid diagram is static and gets no control
  rather than a dead one. An animated PNG, GIF or WebP is still refused outright, because the `<img>`
  sink has no pause and a loop nobody can stop is worse than a refusal.
- **A frame that has run out of time** stops and says so, and Reload starts it again. A Lottie frame
  is torn down after 120 seconds of wall-clock life whatever it is doing, because that bound cannot
  be cleared by anything the frame reports — see [gap 3](#declared-gaps) for what it does and does
  not bound.

### Error fallback

A payload the browser refuses to decode fires the `<img>` `error` event, and the block replaces the
picture with a note naming the type (`[data-fy-render-error]`) and opens the source panel. This is
where a malformed SVG is caught: the grammar deliberately does not parse XML, so the browser's own
parser is the well-formedness check, and it is a far better one than a hand-written scan.

**The sandbox types reach a sentence by more routes, and one of them is not a failure.** A Mermaid
source Mermaid itself refuses, a compiled diagram the re-admission gate rejects (a `<script>`, an
over-cap element or filter count, or a `<foreignObject>` a future Mermaid release started emitting —
measured, no directive produces one today), a Lottie payload the player cannot load, a library
response that is missing or over its cap, a shell that never announced itself within its readiness
deadline, and a frame that ran out of wall-clock life. The first five are the classes `startup`,
`library` and `render`: one fixed sentence in the sandbox status region, error-toned, the library or
gate wording folded under `Why`, and the source panel opened as scaffolding. The last two are
`deadline` and `lifetime`, and `lifetime` — a healthy Lottie frame reaching its permitted life — is
**not** presented as a failure: neutral tone, no fold, no source panel, because nothing went wrong.
**There is no partial-render state**: a block either shows its illustration or shows its source with
the reason said out loud, and
a failed one is visually indistinguishable from an ordinary fence with a note above it.

That last route is worth stating plainly because it will be seen in the field and misdiagnosed: if
the shell and the library bundles are ever served from two different deploys, the CSP hash will not
match, the library will not run, and every sandbox block returns to source with "The Mermaid library
did not load." That is the design failing closed, not a bug.

**That note is deliberately not a live region** — not `role="alert"`, not `role="status"`, not
`aria-live`. A transcript row re-renders while the assistant is still emitting it, and the grammar
admits an SVG by prefix, so a half-written document genuinely reaches the `<img>` and genuinely fails
to decode. An assertive live region would interrupt a screen-reader user, repeatedly, to announce an
error that is not one yet and that the component cannot distinguish from a real one, because nothing
tells it the message has stopped growing; a polite one would make the same false announcement more
quietly. So the failure is ordinary visible text, met when the reader reaches the block, exactly like
the "this build does not run…" note beside it. The cost is stated rather than hidden: a reader
already inside a block is not interrupted when its decode fails.

### Streaming, which is the ordinary case

A transcript row re-renders while the assistant is still emitting it, so this block sees a
half-written payload before it sees the whole one. Four rules follow, and they are all one fact —
**consent and state belong to the exact bytes**:

- **No decoder ever mounts on its own**, and consent applies only to the exact source it was given
  for; any later growth withdraws it. Be precise about what that does and does not promise: nothing
  tells this block that a message has stopped growing, so a reader who presses Render while an `svg`
  is still arriving **will** decode a partial — lexically admitted, within every cap, and their own
  deliberate choice. A partial **raster** cannot mount at all, but for a different reason: the
  container's terminal-shape and ordering checks refuse an unfinished file, so a partial raster does
  not parse at all.
- **A new payload clears an old failure, and returns to the offer.** The completed SVG arriving a
  moment after the partial one does _not_ render on its own: withdrawing approval is what clears the
  failure, so the block goes back to **Render illustration** and waits for a fresh press. There is no
  Reload to press — that control only exists once something has been rendered.
- **A stale error cannot fail a live image.** The `<img>` is keyed by source generation, and the
  `error` handler carries the generation it was created for, so an event queued for bytes that have
  already been replaced is ignored rather than applied to their successor.
- **The source panel remembers who opened it.** A panel a failure opened closes when that failure
  clears; a panel the reader opened stays open. Recovering from a transient decode error must not
  leave an unsolicited wall of markup under a picture that is now fine, and must not close a panel
  the reader asked for. A panel is re-derived only when the KIND of block changes — source-only opens,
  visual closes — because re-deriving on every byte would undo the reader's own decision.
- **Fullscreen closes with the approval that was holding it open.** An unrendered visual has nothing
  to enlarge, so its Fullscreen control is hidden; leaving an open overlay behind when new bytes
  withdraw approval would remove Exit — the only dismiss affordance on touch — out from under a
  reader standing in it.

The two types stream differently, and the difference is visible. An `svg` payload is admitted by
prefix, so the block persists and updates as it grows. A raster is not: the selected container checks
require a terminal shape and the selected record ordering, so a partially-received one fails them, does not
parse, and the fence stays an ordinary escaped code fence until the last byte arrives — the block
appears once, rather than being
repeatedly mounted and discarded. In neither case does a browser image decoder run without a press.

---

## Accepted risk

**This build renders a bounded payload, on a gesture, with no resource isolation.** The caps bound
what goes in; nothing bounds what rasterising it costs. A 16-megapixel image within every limit, or a
100 KiB SVG with a handful of filter primitives, can still be expensive to draw, and there is no
timeout, no watchdog and no memory ceiling anywhere in this build.

That residual is **explicitly accepted** for this independently shippable partial slice, on these
terms and no others:

1. It is **bounded-input**: magic bytes must match the declared type, declared dimensions are read
   before any decoder is handed the bytes, animation is refused, and a container that fails the
   selected admission checks fails closed. Those checks are a signature, record ordering, a terminal
   shape and the declared dimensions — **not** CRCs and not compressed content, which stay the
   browser decoder's business.
2. It is **user-triggered**: no decoder and no sandbox frame mounts without a gesture, and the
   control that starts one names the type — plus, for the two static types, the bounded payload
   size — in its accessible name.
3. It is **recorded prominently**, here and in the authoring skill, rather than left implicit.

**This is not resource isolation.** It does not satisfy row #65's executable, resource-bounded
clause, and **row #65 stays open**. Anyone who considers even this residual unacceptable should ship
the source-only subset, which is a coherent product: set `enableFyRender` nowhere and every block
renders as an ordinary escaped fence.

---

## Declared gaps

What this build knowingly does not do. Each of these is why row 65 is **not** ticked.

1. **`type: html` does not execute.** Row 65's clause "an HTML payload may include full HTML, CSS,
   and JavaScript for interactive explanations… in an isolated, resource-bounded sandbox" is **not
   met**, and this is the honest consequence of measurement rather than a schedule slip. Three
   independent probes established that a browser-only boundary does not exist: in the required
   opaque-origin `sandbox="allow-scripts"` frame, hostile script performed a real self-navigation
   that an external beacon server received; `<link rel="prerender">` produced a real TCP connection
   and HTTP GET under `default-src 'none'`; and `RTCPeerConnection` sent real STUN and TURN UDP under
   `connect-src 'none'`, with Chromium 150 rejecting the proposed `webrtc 'block'` directive as
   unrecognised. The Navigation API, the candidate mitigation, is present but **inert** in that
   frame (`currentEntry: null`, no `navigate` event), so feature detection lies; making it work needs
   `allow-same-origin`, which would destroy the boundary it was meant to protect. Separately, no
   browser offers any per-frame CPU or memory quota, so "resource-bounded" has no browser-only
   implementation at all. An external OS-enforced boundary (a pinned, network-less container) does
   close the security half, but it does not close the product half: the relay cannot carry a pixel
   stream, so the block would render on a laptop and not on the phone beside it, and a streamed
   render has no accessible tree — it would spend an entire container runtime to arrive back at the
   `alt` string this build already provides for free.
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
   seconds for a Mermaid compile, 120 seconds for a Lottie frame — so they bound how long a payload
   may compute and say nothing about how hard. Browsers offer no per-frame CPU or memory quota at
   all. A payload inside every limit and still expensive to rasterise is bounded in neither what the
   machine spends nor, for the non-sandbox types, how long the reader waits. Do not describe the caps
   as bounding compute, do not describe the watchdogs as a quota, and do not describe the trust gate
   as isolation — it decides WHO starts the work and WHEN, not how much of it there can be. See
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

## Evidence

Every claim above is either a test in this repository or one of these probe records. They are session
artifacts outside the repository; cite them, do not assume they will outlive the session.

| Claim                                                                           | Record                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `<img>`-loaded SVG: zero egress, no script/handler execution, Chrome 150        | `svg-img-security-probe-report.md` with `svg-img-network-*`, `svg-img-same-origin-*` and `svg-img-script-*` ledgers |
| Opaque-frame self-navigation, prerender and WebRTC egress; Navigation API inert | `self-navigation-result.md` with `nav-*.json` and `egress-output.json`                                              |
| Independent review concluding executable HTML is a release blocker              | `sandbox-security-verdict.md`                                                                                       |
| Slice plan, mechanism survey and cost sheet                                     | `execution-boundary-plan.md`                                                                                        |
| Static-slice security review that found the unbounded-decode blocker            | `fy-render-static-security-review.md`                                                                               |
| UI/accessibility review of the fullscreen presentation                          | `fy-render-static-ui-review.md`                                                                                     |
| Raster header reader agreeing with Chrome's decoder, 18 of 18                   | `prototype/verify.ts` beside its `raster-header.ts`                                                                 |
