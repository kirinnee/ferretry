/**
 * The sandbox shell's bootstrap — the only code in this document that talks to
 * the parent, and the first script the document runs.
 *
 * THERE IS NO PATH FROM AUTHOR BYTES TO CODE, and that is enforced by the
 * browser rather than by this comment. Author bytes arrive as DATA on a message
 * port and reach exactly two call sites — `mermaid.render(text)` and
 * `lottie.loadAnimation({ animationData })` — both trusted first-party
 * libraries. This file contains no `eval`, no `new Function`, no
 * `document.write`, no `innerHTML`, no `insertAdjacentHTML`, no `import()`, and
 * no `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon` of any kind.
 *
 * IT DOES CONTAIN ONE CODE-INSTALL PRIMITIVE, `install()` below, and pretending
 * otherwise would be dishonest. This document is denied every ordinary
 * SUBRESOURCE — which is narrower than "no network", since self-navigation,
 * prerender and WebRTC were all measured egressing from this frame shape and are
 * a declared residual — so it cannot fetch its own library; the parent fetches the bundle and
 * transfers the bytes over the capability port, and `install()` puts them in an
 * inline `<script>`. What makes that safe is the shell's `script-src`, which
 * lists nothing but the build-time SHA-256 of this bootstrap and of the two
 * library bundles. A real-Chromium probe measured the behaviour this rests on
 * inside the opaque frame: a dynamically created inline script whose text
 * matches a pinned hash runs, and the identical primitive with any other text
 * does not run. So `install()` is not dangerous-but-unused — it is
 * cryptographically incapable of running anything that was not fixed at build
 * time, author bytes very much included.
 *
 * THIS SCRIPT RUNS BEFORE ANY LIBRARY. It captures the messaging intrinsics it
 * needs while they are still the ones the platform supplied; a library that
 * later replaced `postMessage` or `addEventListener` would find this module
 * already holding the originals.
 *
 * THE HANDSHAKE IS ONE-TIME AND IDENTITY-CHECKED. `event.origin` inside an
 * opaque-origin frame is the literal string `"null"` and authenticates nothing,
 * so the only check that carries information is `event.source === parent`.
 * Exactly one global message is ever accepted — the one carrying a fresh
 * `MessagePort` — and the global listener is removed the moment it lands.
 * Everything after that is port-only traffic no other document can reach.
 */
import { FY_RENDER_LIMITS, FY_RENDER_SANDBOX_LIMITS } from '../../src/lib/fy-render.ts';

type Reply =
  | { kind: 'shell-ready' }
  | { kind: 'mermaid-svg'; svg: string }
  | { kind: 'rendered'; width: number; height: number }
  | { kind: 'playing'; playing: boolean }
  | { kind: 'error'; message: string };

interface LottieAnimation {
  play(): void;
  pause(): void;
  addEventListener(name: string, handler: () => void): void;
}

interface LottieLibrary {
  loadAnimation(options: {
    container: Element;
    renderer: 'svg';
    loop: boolean;
    autoplay: boolean;
    animationData: unknown;
  }): LottieAnimation;
}

interface MermaidLibrary {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

(() => {
  /**
   * INTRINSICS, captured before a single byte of library code has run, and
   * bound rather than merely referenced so a later `window.parent` reassignment
   * cannot redirect a reply.
   */
  const parentWindow: Window = window.parent;
  const postToParent = window.parent.postMessage.bind(window.parent);
  const listen = window.addEventListener.bind(window);
  const unlisten = window.removeEventListener.bind(window);
  const parseJson = JSON.parse;
  const isInteger = Number.isInteger;
  /**
   * Captured before any library runs, and used to measure the diagram in the
   * unit the cap is written in. `String.length` counts UTF-16 code units, so a
   * diagram full of non-ASCII labels can sit under the character count while
   * being well over the byte bound the parent and the docs both claim.
   */
  const encoder = new TextEncoder();
  const encodeUtf8 = encoder.encode.bind(encoder);
  const createElement = document.createElement.bind(document);
  const body = document.body;
  const stage = document.getElementById('fy-render-stage') as HTMLDivElement;

  /**
   * THE BOUND PORT SEND, captured at handshake time and never looked up again.
   *
   * `port.postMessage(...)` is a property lookup performed at call time, so it
   * resolves through `MessagePort.prototype` as it exists AT THAT MOMENT — after
   * a library has run. A library that replaced the prototype method could then
   * read, suppress or forge every reply this frame makes. Binding the method
   * when the port arrives — which is strictly before any `install()`, because
   * the install command can only arrive over the port itself — means every later
   * send goes through the function the platform supplied.
   */
  let sendOverPort: ((reply: Reply) => void) | null = null;
  let port: MessagePort | null = null;
  let animation: LottieAnimation | null = null;
  /** One render per frame. Reload is a fresh frame, never a second command. */
  let consumed = false;

  const send = (reply: Reply): void => {
    if (sendOverPort !== null) sendOverPort(reply);
  };

  /** Every string this frame puts on the wire is cut to a documented length. */
  const clip = (value: unknown): string => String(value).slice(0, FY_RENDER_SANDBOX_LIMITS.messageCharacters);

  const failWith = (reason: unknown): void => send({ kind: 'error', message: clip(reason) });

  const boundedDimension = (value: unknown): number => {
    if (typeof value !== 'number' || !isInteger(value) || value < 1) return 1;
    return value > FY_RENDER_LIMITS.maxDimension ? FY_RENDER_LIMITS.maxDimension : value;
  };

  /**
   * Installs build-pinned library bytes. Appending a script whose hash is not in
   * `script-src` does NOT throw — the browser simply never runs it — so the
   * caller proves the install by looking for the global the bundle defines,
   * never by the absence of an exception.
   */
  const install = (source: unknown): void => {
    if (typeof source !== 'string') return;
    const element = createElement('script');
    element.textContent = source;
    body.appendChild(element);
    element.remove();
  };

  const renderMermaid = (library: unknown, source: unknown, theme: unknown): void => {
    if (typeof source !== 'string') return failWith('The diagram source was not text.');
    install(library);
    const mermaid = (globalThis as unknown as { __fyRenderMermaid?: MermaidLibrary }).__fyRenderMermaid;
    if (mermaid === undefined) return failWith('The Mermaid library did not load.');
    try {
      /**
       * `securityLevel: 'strict'` is Mermaid's own hardening: it strips click
       * bindings and refuses the directives that let a diagram reach outside
       * itself.
       *
       * `htmlLabels: false` KEEPS LABELS IN SVG `<text>` RATHER THAN A
       * `<foreignObject>` FULL OF HTML — but say plainly what that is worth. It
       * is a DEFAULT, not a guarantee. Mermaid protects only a fixed list of
       * keys from an in-diagram `%%{init: …}%%` directive, and `htmlLabels` was
       * not on it, so a diagram opening with
       * `%%{init: {"htmlLabels": true}}%%` could set the very option this
       * paragraph used to call load-bearing. `secure` is extended below —
       * `secure` is itself a protected key, so widening it here cannot be
       * narrowed by a directive afterwards.
       *
       * `flowchart` is deliberately NOT added to that list even though
       * `flowchart.htmlLabels` remains reachable on paper: protecting it would
       * block every flowchart directive, including entirely benign ones like
       * `curve`. The property is instead held where it is actually enforceable —
       * the parent's `fyRenderMermaidSvg` refuses a `<foreignObject>` outright,
       * so a diagram that overrode the option would fail closed with a visible
       * reason and never reach the `<img>` sink.
       *
       * MEASURED, THAT REFUSAL IS UNTRIGGERED. Against this exact config in real
       * Chromium, `%%{init: {"flowchart": {"htmlLabels": true}}}%%`,
       * `%%{init: {"htmlLabels": true}}%%` and the plain equivalent diagram all
       * compiled to byte-identical SVG with no `<foreignObject>` — the directive
       * does not defeat the option here. So this config is doing the work today
       * and the parent's refusal is the fail-closed guard behind it, which is the
       * opposite order from what this comment used to claim. Keep both.
       */
      mermaid.initialize({
        deterministicIds: true,
        flowchart: { htmlLabels: false },
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        htmlLabels: false,
        secure: [
          'secure',
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'suppressErrorRendering',
          'maxEdges',
          'htmlLabels',
          'theme',
          'fontFamily',
          'deterministicIds',
        ],
        securityLevel: 'strict',
        startOnLoad: false,
        theme: theme === 'dark' ? 'dark' : 'default',
      });
      mermaid
        .render('fy-render-diagram', source)
        .then(result => {
          /**
           * BOUNDED BEFORE IT LEAVES, not after it arrives. A 20,000-character
           * diagram can compile to far more than 20,000 characters, and the cap
           * on the parent's side would only refuse it once it had already been
           * cloned across the port. Refusing here means the oversized string is
           * never transferred at all.
           */
          if (encodeUtf8(result.svg).byteLength > FY_RENDER_SANDBOX_LIMITS.mermaidSvgBytes)
            return failWith('The compiled diagram is too large to display.');
          send({ kind: 'mermaid-svg', svg: result.svg });
        })
        .catch((error: unknown) =>
          failWith(error instanceof Error ? error.message : 'The diagram could not be drawn.'),
        );
    } catch (error) {
      failWith(error instanceof Error ? error.message : 'The diagram could not be drawn.');
    }
  };

  const renderLottie = (library: unknown, source: unknown, playing: unknown): void => {
    if (typeof source !== 'string') return failWith('The animation source was not text.');
    install(library);
    const lottie = (globalThis as unknown as { __fyRenderLottie?: LottieLibrary }).__fyRenderLottie;
    if (lottie === undefined) return failWith('The Lottie library did not load.');
    let data: unknown;
    try {
      data = parseJson(source);
    } catch {
      return failWith('The animation was not valid JSON.');
    }
    if (data === null || typeof data !== 'object') return failWith('The animation was not an object.');
    try {
      animation = lottie.loadAnimation({
        animationData: data,
        autoplay: playing === true,
        container: stage,
        loop: true,
        renderer: 'svg',
      });
      const frame = data as { w?: unknown; h?: unknown };
      animation.addEventListener('DOMLoaded', () =>
        send({ height: boundedDimension(frame.h), kind: 'rendered', width: boundedDimension(frame.w) }),
      );
    } catch (error) {
      failWith(error instanceof Error ? error.message : 'The animation could not be played.');
    }
  };

  const setPlaying = (playing: unknown): void => {
    if (animation === null) return;
    const next = playing === true;
    try {
      if (next) animation.play();
      else animation.pause();
      send({ kind: 'playing', playing: next });
    } catch (error) {
      failWith(error instanceof Error ? error.message : 'The animation could not be controlled.');
    }
  };

  const onCommand = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (data === null || typeof data !== 'object') return;
    const command = data as {
      kind?: unknown;
      library?: unknown;
      source?: unknown;
      theme?: unknown;
      playing?: unknown;
    };
    if (command.kind === 'set-playing') return setPlaying(command.playing);
    if (consumed) return;
    if (command.kind === 'render-mermaid') {
      consumed = true;
      return renderMermaid(command.library, command.source, command.theme);
    }
    if (command.kind === 'render-lottie') {
      consumed = true;
      return renderLottie(command.library, command.source, command.playing);
    }
  };

  const onGlobalMessage = (event: MessageEvent): void => {
    // The port is transferred exactly once; everything after is port-only.
    if (port !== null) return;
    // `event.origin` is the string "null" here. Identity is the only real check.
    if (event.source !== parentWindow) return;
    const offered = event.ports.length > 0 ? event.ports[0] : undefined;
    if (offered === undefined) return;
    port = offered;
    // Bound BEFORE any library can run — see `sendOverPort` above.
    sendOverPort = offered.postMessage.bind(offered) as (reply: Reply) => void;
    const startPort = offered.start.bind(offered);
    unlisten('message', onGlobalMessage);
    offered.onmessage = onCommand;
    startPort();
  };

  listen('message', onGlobalMessage);
  postToParent({ kind: 'shell-ready' } satisfies Reply, '*');
})();
