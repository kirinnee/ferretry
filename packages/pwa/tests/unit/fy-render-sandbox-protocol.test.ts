/**
 * The wire between the parent and the sandbox frame, and the two gates either
 * side of it.
 *
 * WHY THIS IS TESTED AS A PARSER RATHER THAN A TYPE. Everything arriving from an
 * opaque-origin frame is untrusted input even though the code inside it is ours,
 * so the interesting cases are all the ones a well-behaved shell would never
 * send: extra keys, absent keys, over-cap strings, non-integer dimensions. A
 * `satisfies` proves soundness and would catch none of them.
 */
import { describe, test } from 'bun:test';
import should from 'should';
import {
  FY_RENDER_LIMITS,
  FY_RENDER_SANDBOX_LIBRARIES,
  FY_RENDER_SANDBOX_LIMITS,
  fyRenderMermaidSvg,
  fyRenderReadBoundedText,
  parseFyRender,
  parseFyRenderSandboxMessage,
} from '../../src/lib/fy-render.ts';

/**
 * Takes the discriminated union rather than a widened `{ ok: boolean }`, so the
 * narrowing is proven by the compiler instead of asserted with a cast.
 */
const reasonOf = (result: { readonly ok: true } | { readonly ok: false; readonly reason: string }): string =>
  result.ok ? '<accepted>' : result.reason;

describe('fy-render sandbox message parsing', () => {
  test('should accept each message the shell is allowed to send', () => {
    // Assert — the closed set, spelled out. A sixth shape has to be added here
    // before it can reach the renderer.
    should(parseFyRenderSandboxMessage({ kind: 'shell-ready' })).eql({ kind: 'shell-ready' });
    should(parseFyRenderSandboxMessage({ kind: 'mermaid-svg', svg: '<svg/>' })).eql({
      kind: 'mermaid-svg',
      svg: '<svg/>',
    });
    should(parseFyRenderSandboxMessage({ height: 200, kind: 'rendered', width: 320 })).eql({
      height: 200,
      kind: 'rendered',
      width: 320,
    });
    should(parseFyRenderSandboxMessage({ kind: 'playing', playing: false })).eql({
      kind: 'playing',
      playing: false,
    });
    should(parseFyRenderSandboxMessage({ kind: 'error', message: 'nope' })).eql({
      kind: 'error',
      message: 'nope',
    });
  });

  test('should refuse a message carrying a key its shape does not name', () => {
    // Assert — exact-key, not merely "has the fields I read". An extra field is
    // a sender that is not the shell we shipped, and answering it at all would
    // be answering whoever that is. Without this, a `shell-ready` could smuggle
    // arbitrary payload past the handshake.
    should(parseFyRenderSandboxMessage({ kind: 'shell-ready', source: 'x' })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'mermaid-svg', library: 'x', svg: '<svg/>' })).be.null();
    should(parseFyRenderSandboxMessage({ extra: 1, height: 2, kind: 'rendered', width: 2 })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'playing', playing: true, speed: 2 })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'error', message: 'a', stack: 'b' })).be.null();
  });

  test('should refuse a message missing a key its shape requires', () => {
    // Assert
    should(parseFyRenderSandboxMessage({ kind: 'mermaid-svg' })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'rendered', width: 10 })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'playing' })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'error' })).be.null();
  });

  test('should refuse a field of the wrong type', () => {
    // Assert
    should(parseFyRenderSandboxMessage({ kind: 'mermaid-svg', svg: 42 })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'playing', playing: 'yes' })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'error', message: { toString: () => 'x' } })).be.null();
  });

  test('should REFUSE an over-cap error string rather than truncate it', () => {
    // Arrange — one character past the documented cap.
    const overCap = 'e'.repeat(FY_RENDER_SANDBOX_LIMITS.messageCharacters + 1);
    const atCap = 'e'.repeat(FY_RENDER_SANDBOX_LIMITS.messageCharacters);

    // Assert — clamping would look defensive and is the opposite: it turns a
    // message the shell could not have built into one that passes, so the bound
    // stops being evidence of anything. The shell clips its own strings, so an
    // over-cap arrival means the sender is not the shell.
    should(parseFyRenderSandboxMessage({ kind: 'error', message: overCap })).be.null();
    should(parseFyRenderSandboxMessage({ kind: 'error', message: atCap })).eql({
      kind: 'error',
      message: atCap,
    });
  });

  test('should refuse a diagram over the byte cap', () => {
    // Arrange
    const oversized = 'x'.repeat(FY_RENDER_SANDBOX_LIMITS.mermaidSvgBytes + 1);

    // Assert — the shell caps this before it leaves the port, so reaching here
    // over-cap means the cap on the far side did not run.
    should(parseFyRenderSandboxMessage({ kind: 'mermaid-svg', svg: oversized })).be.null();
  });

  test('should refuse dimensions that are not whole numbers inside the canvas bound', () => {
    // Assert — a frame reporting its own size is untrusted, and the numbers are
    // used for nothing; refusing them here keeps it that way.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, FY_RENDER_LIMITS.maxDimension + 1, '10'])
      should(parseFyRenderSandboxMessage({ height: 10, kind: 'rendered', width: bad })).be.null();
    should(parseFyRenderSandboxMessage({ height: 10, kind: 'rendered', width: FY_RENDER_LIMITS.maxDimension })).be.ok();
  });

  test('should refuse anything that is not a plain message object', () => {
    // Assert — an array has `kind` undefined but is still an object, so it needs
    // its own refusal rather than falling through the `typeof` check.
    for (const bad of [null, undefined, 'shell-ready', 7, [], [{ kind: 'shell-ready' }], { kind: 'nope' }, {}])
      should(parseFyRenderSandboxMessage(bad)).be.null();
  });
});

describe('fy-render compiled diagram admission', () => {
  // A bounded `viewBox` because the canvas check applies here too: a diagram
  // that declares no extent at all is refused, generated or not.
  const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

  test('should admit an ordinary compiled diagram', () => {
    // Assert — the shape Mermaid was measured to emit: styled, no foreignObject.
    should(fyRenderMermaidSvg(svg('<style>.a{fill:red}</style><g><path d="M0 0"/></g>'))).eql({
      ok: true,
      svg: svg('<style>.a{fill:red}</style><g><path d="M0 0"/></g>'),
    });
  });

  test('should refuse the constructs a generator should never emit', () => {
    // Assert — fail-closed. Measured Mermaid output contains none of these, so
    // refusing them costs nothing real; what it buys is that the day a Mermaid
    // release starts emitting one, this says so instead of quietly widening
    // what reaches the `<img>` sink.
    should(reasonOf(fyRenderMermaidSvg(svg('<script>alert(1)</script>')))).match(/<script>/);
    should(reasonOf(fyRenderMermaidSvg(svg('<foreignObject><b>hi</b></foreignObject>')))).match(/<foreignObject>/);
    should(reasonOf(fyRenderMermaidSvg(svg('<use href="#a"/>')))).match(/<use>/);
    should(reasonOf(fyRenderMermaidSvg('<!DOCTYPE svg><svg/>'))).match(/document type or entity/);
    should(reasonOf(fyRenderMermaidSvg('<!ENTITY a "b"><svg/>'))).match(/document type or entity/);
  });

  test('should refuse a diagram that is not an svg element at all', () => {
    // Assert — the sink builds a `data:image/svg+xml` URL, so a non-SVG document
    // would simply fail to decode and show an empty frame instead of a reason.
    should(reasonOf(fyRenderMermaidSvg('<div>not a diagram</div>'))).match(/not an <svg> element/);
  });

  test('should refuse an unpaired surrogate before the renderer encodes it', () => {
    // Assert — `encodeURIComponent` THROWS on one, and a throw inside a
    // transcript row takes the row with it. This is the never-throws contract
    // being kept at the boundary rather than in the renderer.
    should(reasonOf(fyRenderMermaidSvg(`<svg>${String.fromCharCode(0xd800)}</svg>`))).match(/unpaired UTF-16/);
  });

  test('should refuse a diagram over its size and element caps', () => {
    // Arrange
    const huge = svg('x'.repeat(FY_RENDER_SANDBOX_LIMITS.mermaidSvgBytes));
    const busy = svg('<g/>'.repeat(FY_RENDER_SANDBOX_SVG_ELEMENT_OVERFLOW));

    // Assert
    should(reasonOf(fyRenderMermaidSvg(huge))).match(/too large/);
    should(reasonOf(fyRenderMermaidSvg(busy))).match(/exceeds .* elements/);
  });

  test('should keep the resource checks the authored path applies, not only the structural ones', () => {
    // Arrange — the two that a "generated output is trusted" argument would
    // most easily talk itself out of. Trusting the producer here would be
    // trusting it about the one thing it cannot know: how much work the
    // READER's browser is about to do.
    const overCanvas = '<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="99999"><g/></svg>';
    const filters = `<filter>${'<feTurbulence/>'.repeat(FY_RENDER_SANDBOX_LIMITS.mermaidSvgFilterPrimitives + 1)}</filter>`;
    const overFilters = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${filters}</svg>`;

    // Assert
    should(fyRenderMermaidSvg(overCanvas).ok).be.false();
    should(reasonOf(fyRenderMermaidSvg(overFilters))).match(/filter primitives/);
  });

  test('should admit the exact root-element shape Mermaid was measured to emit', () => {
    // Assert — a percentage width against a real viewBox with the height
    // omitted. Applying the canvas bound would be worthless if it rejected the
    // only output this feature actually produces, so the measured shape is
    // pinned here rather than assumed to pass.
    const measured = '<svg id="d" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 76 214"><g/></svg>';
    should(fyRenderMermaidSvg(measured).ok).be.true();
  });

  test('should refuse a diagram with an unterminated tag', () => {
    // Assert — an unterminated tag means the element scan could not finish, so
    // the element cap was never actually applied to the whole document.
    should(reasonOf(fyRenderMermaidSvg('<svg><g'))).match(/unterminated tag/);
  });
});

/** One past the element cap, kept next to its only use. */
const FY_RENDER_SANDBOX_SVG_ELEMENT_OVERFLOW = FY_RENDER_SANDBOX_LIMITS.mermaidSvgElements + 1;

describe('fy-render bounded library reading', () => {
  const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

  test('should read a library that is inside its cap', async () => {
    // Act
    const result = await fyRenderReadBoundedText(new Response('globalThis.x = 1;'), 1_000);

    // Assert
    should(result).eql({ ok: true, text: 'globalThis.x = 1;' });
  });

  test('should refuse a declared length over the cap without reading a byte', async () => {
    // Arrange — the cheap check. A response that ANNOUNCES it is too big is
    // refused before its body is touched at all.
    const response = new Response('short', { headers: { 'content-length': '999999' } });

    // Act
    const result = await fyRenderReadBoundedText(response, 10);

    // Assert
    should(reasonOf(result)).match(/too large/);
  });

  test('should refuse a body that outgrows the cap despite a missing or lying length', async () => {
    // Arrange — the honest check. A chunked response declares no length, so the
    // running total is the only thing standing between us and the allocation.
    const chunk = new Uint8Array(8).fill(65);
    const response = new Response(streamOf([chunk, chunk, chunk]));

    // Act
    const result = await fyRenderReadBoundedText(response, 16);

    // Assert — stopped at the chunk that crossed the line, not after the body.
    should(reasonOf(result)).match(/too large/);
  });

  test('should refuse a response with no body', async () => {
    // Act
    const result = await fyRenderReadBoundedText(new Response(null, { status: 204 }), 100);

    // Assert
    should(reasonOf(result)).match(/empty/);
  });

  test('should refuse a stream that fails mid-read', async () => {
    // Arrange — a connection dropped halfway is not a library.
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error('connection reset'));
      },
    });

    // Act
    const result = await fyRenderReadBoundedText(new Response(failing), 100);

    // Assert
    should(reasonOf(result)).match(/could not be read/);
  });

  test('should give each library its own cap, sized to what it actually builds to', async () => {
    // Assert — Mermaid builds to ~3.4 MiB and Lottie light to ~168 KiB, so one
    // shared cap would either strangle Mermaid or let a wrong Lottie response be
    // read twenty times over before anything noticed.
    should(FY_RENDER_SANDBOX_LIBRARIES.mermaid.maxBytes).be.above(3.4 * 1024 * 1024);
    should(FY_RENDER_SANDBOX_LIBRARIES.lottie.maxBytes).be.below(FY_RENDER_SANDBOX_LIBRARIES.mermaid.maxBytes);
    should(FY_RENDER_SANDBOX_LIBRARIES.lottie.maxBytes).be.above(168 * 1024);
  });
});

describe('fy-render lottie expression refusal', () => {
  const lottie = (body: unknown) => parseFyRender(`type: lottie\nalt: An animation\n---\n${JSON.stringify(body)}`);

  test('should refuse an expression wherever it is hiding', () => {
    // Assert — an expression is always SOURCE TEXT, so a string-valued `x` is
    // the shape being refused, at any depth and at any array index.
    should(reasonOf(lottie({ layers: [{ ks: { p: { x: '$bm_rt = [0,0];' } } }] }))).match(/expression keys/);
    should(reasonOf(lottie({ a: { b: { c: { x: 'thisComp.width' } } } }))).match(/expression keys/);
    // Buried at index 2 rather than index 0: checking only the first member
    // would let this through, and it is still an expression.
    should(reasonOf(lottie({ layers: [{ x: [0.1, 0.2, 'transform.position'] }] }))).match(/expression keys/);
  });

  test('should ADMIT the non-code meanings the format overloads onto the same key', () => {
    // Assert — Slice A refused `x` outright, which was free while no player
    // existed. Measured against a real animation once one did, it rejected a
    // plain two-keyframe ease: bezier handles are written `{"x":[0.833]}` and
    // appear in essentially every eased animation. Refusing them would have
    // shipped a Lottie type that refuses most real Lottie.
    should(lottie({ layers: [{ ks: { p: { k: [{ i: { x: [0.833], y: [0.833] }, s: [0], t: 0 }] } } }] }).ok).be.true();
    // A separated-dimension position carries a whole animated property object
    // under `x`. Also not source text, also admitted.
    should(lottie({ layers: [{ ks: { p: { s: true, x: { a: 0, k: 50 }, y: { a: 0, k: 20 } } } }] }).ok).be.true();
    should(lottie({ layers: [{ x: 12 }] }).ok).be.true();
  });
});
