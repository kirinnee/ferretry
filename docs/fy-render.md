# `fy-render` — inline illustrations in a conversation

A fenced block an assistant can put in its own chat message so a diagram, a drawing or a screenshot
renders where the explanation is, instead of as a wall of markup the reader has to imagine.

**Read this first: nothing in this build executes an author's code.** Two of the five declared types
render as pictures. The other three are parsed, bounded, and then shown as their own escaped source
with the limitation printed on screen. That is a deliberate, evidenced decision, not an unfinished
one — [Declared gaps](#declared-gaps) says exactly what is missing and why, and
[handover.md](../handover.md) row 65 stays open because of it.

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
| `lottie`  | 1 MiB                            | invalid JSON; a non-object root; any `"x"` expression key at any depth; more than 500 layers; deeper than 64 levels                                                                                                                                                                        |
| `image`   | 2 MiB decoded (≈ 2.7 MiB base64) | anything that is not canonical base64; bytes that disagree with the declared MIME; a declared size over 8192 per axis or 16,777,216 pixels; animation; a malformed, truncated or trailing-byte container                                                                                   |

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

| Type      | Renders as                                 | Why                                                                              |
| --------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `svg`     | `<img src="data:image/svg+xml,…">`         | The measured boundary — see below                                                |
| `image`   | `<img src="data:{mime};base64,…">`         | No script surface exists in a raster decode                                      |
| `html`    | escaped source, with the limitation stated | Executing it needs a boundary this build does not have ([gap 1](#declared-gaps)) |
| `mermaid` | escaped source, with the limitation stated | Needs a renderer library not in this build ([gap 2](#declared-gaps))             |
| `lottie`  | escaped source, with the limitation stated | Needs a player library not in this build ([gap 2](#declared-gaps))               |

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

| Control             |  `svg` / `image`   | `html` / `mermaid` / `lottie` |
| ------------------- | :----------------: | :---------------------------: |
| Render illustration |        yes         |          **hidden**           |
| Source              |        yes         |     yes (open by default)     |
| Fullscreen          |        yes         |              yes              |
| Caption             |        yes         |              yes              |
| Reload              | yes, once rendered |          **hidden**           |
| Pause / Play        |     **absent**     |          **absent**           |

A control that cannot act is hidden, not shown disabled — a disabled Reload on a block that is only
ever text is a promise the build does not keep.

### Nothing decodes until the reader asks

**No browser decoder mounts automatically.** A payload's size is bounded; the work of drawing it is
not, and a transcript is written by an assistant rather than by the reader. So the stage says what
rendering would cost and one control starts it, with an accessible name that carries the type and the
bounded payload size — _Render illustration (SVG, 4 KB)_ — because a consent nobody can price is not
one.

- **Approval belongs to the exact `block.source`** and is discarded the moment those bytes change. A
  streamed message therefore cannot inherit consent granted to an earlier draft of itself, and no
  partially-received payload ever reaches a decoder.
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
- **Reload** discards the `<img>` and decodes the payload again. It is the recovery path from a
  decode failure, and it is meaningless for a type that never reaches an `<img>`.
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
- **Pause** is absent because nothing in this build animates under the app's control — which is also
  why an animated PNG, GIF or WebP is refused outright rather than shown as a loop nobody can stop.
  Both return with the runtime types ([gap 2](#declared-gaps)).

### Error fallback

A payload the browser refuses to decode fires the `<img>` `error` event, and the block replaces the
picture with a note naming the type (`[data-fy-render-error]`) and opens the source panel. This is
where a malformed SVG is caught: the grammar deliberately does not parse XML, so the browser's own
parser is the well-formedness check, and it is a far better one than a hand-written scan.

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
  container checks demand a structurally complete file, so an unfinished one does not parse.
- **A new payload clears an old failure.** The completed SVG arriving a moment after the partial one
  renders normally, with no Reload press.
- **A stale error cannot fail a live image.** The `<img>` is keyed by source generation, and the
  `error` handler carries the generation it was created for, so an event queued for bytes that have
  already been replaced is ignored rather than applied to their successor.
- **The source panel remembers who opened it.** A panel a failure opened closes when that failure
  clears; a panel the reader opened stays open. Recovering from a transient decode error must not
  leave an unsolicited wall of markup under a picture that is now fine, and must not close a panel
  the reader asked for.

The two types stream differently, and the difference is visible: an `svg` payload is admitted by
prefix, so the block persists and updates as it grows, while a base64 `image` payload is only
canonical on four-character boundaries — so while a raster streams the surface alternates between an
ordinary escaped fence and the block, and each change discards panel and fullscreen state. In neither
case does anything decode without a press.

---

## Accepted risk

**This build renders a bounded payload, on a gesture, with no resource isolation.** The caps bound
what goes in; nothing bounds what rasterising it costs. A 16-megapixel image within every limit, or a
100 KiB SVG with a handful of filter primitives, can still be expensive to draw, and there is no
timeout, no watchdog and no memory ceiling anywhere in this build.

That residual is **explicitly accepted** for this independently shippable partial slice, on these
terms and no others:

1. It is **bounded-input**: magic bytes must match the declared type, declared dimensions are read
   before any decoder is handed the bytes, animation is refused, and malformed or truncated
   containers fail closed.
2. It is **user-triggered**: no decoder mounts without a gesture, and the gesture is priced.
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
2. **`type: mermaid` and `type: lottie` do not render.** Both need a trusted library executing
   against untrusted data, which needs the shell of gap 1. Their grammar, caps and the `"x"`
   expression-key rejection ship now so a later build inherits a bounded corpus rather than an
   accepted one.
3. **No CPU or memory bound on anything, in any form.** The caps bound **input size and declared
   dimensions, and nothing else**. There is no decode timeout, no watchdog and no compute quota
   anywhere in this build, so a payload that is inside every limit and still expensive to rasterise
   is bounded neither in what the machine spends nor in how long the reader waits. Do not describe
   the caps as bounding either, and do not describe the trust gate as isolation — it decides WHO
   starts the work and WHEN, not how much of it there can be. See [Accepted risk](#accepted-risk).
4. **Cross-browser coverage is one engine.** The `<img>` result is Chrome 150, headless, on Linux.
   Firefox and WebKit were not installed and are unmeasured; Safari — the more consequential one for
   a PWA — has had no run at all. This is a release-evidence gap, not a known failure.
5. **SVG admission is prefix-only, a deliberate deviation from the approved plan.** The plan asked
   for a structural "exactly one well-formed `<svg>` root". The grammar checks that a payload
   _begins_ with an `<svg>` element and does not parse the document, because the alternative is a
   `DOMParser` in `src/lib` — the domain tier, where no other module in this package touches the DOM.
   The browser's decode is the well-formedness check instead, and its failure is visible through the
   error fallback above. Nothing in this repository may describe that scan as validating a
   well-formed or single root.
6. **`<use>` is rejected outright rather than cycle-checked.** A real answer is a reference-cycle
   detector and is not worth building for a chat illustration. The probe showed the `<img>` sink
   neutralises `<use>` anyway, so this is authoring policy, not defence.
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
