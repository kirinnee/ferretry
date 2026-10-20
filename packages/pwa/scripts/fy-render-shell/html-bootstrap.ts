/**
 * The `html` shell's bootstrap — the first script `fy-render-html.html` runs,
 * and the only one that talks to the parent.
 *
 * THIS SHELL EXISTS TO RUN AUTHOR CODE, which makes it the opposite of the
 * Mermaid/Lottie shell and is why it is a SEPARATE document with a separate
 * policy. That shell's `script-src` lists build-time hashes and nothing else; a
 * page an agent wrote cannot be hashed at build time, so this one carries
 * `script-src 'unsafe-inline'`. What keeps that tolerable is everything else the
 * frame is: an opaque origin (`sandbox="allow-scripts"` and nothing more), so no
 * storage, no cookies, no reach into the app document; `default-src 'none'` and
 * `connect-src 'none'`, so no fetch, XHR, WebSocket, EventSource, worker, nested
 * frame or remote subresource; no forms, popups, modals, downloads or top
 * navigation, because the sandbox grants none of them.
 *
 * WHAT IT DOES NOT CLOSE, stated rather than implied: an opaque frame that runs
 * script can still navigate ITSELF, can still prerender, and can still open a
 * WebRTC connection — all three measured egressing under exactly this kind of
 * policy (`docs/fy-render.md` gap 1). The parent tears the frame down on a
 * second `load`, which bounds a navigation's consequences and not its request.
 * The steps below that strip `meta`/`link`/`base` and speculation rules, and
 * delete the RTC constructors, remove the EASY spellings of those channels from
 * author markup; author script can rebuild the first two, and a speed bump is
 * all they are claimed to be.
 *
 * AUTHOR BYTES ARRIVE AS DATA, over a `MessagePort`, after the parent has
 * proved this document's identity by `event.source`. They are parsed by
 * `DOMParser`, which runs nothing, moved into this document, and only then are
 * their scripts re-created so the page behaves as it was written.
 *
 * INTRINSICS ARE CAPTURED FIRST, while they are still the platform's. Author
 * code runs in this same realm, so anything this file looks up after the page
 * has run is something the page could have replaced. The port send in
 * particular is bound before any author byte arrives.
 */
import { FY_RENDER_LIMITS, FY_RENDER_SANDBOX_LIMITS } from '../../src/lib/fy-render-bounds.ts';

type Reply =
  | { kind: 'shell-ready' }
  | { kind: 'rendered'; width: number; height: number }
  | { kind: 'height'; height: number }
  | { kind: 'escape' }
  | { kind: 'beat' }
  | { kind: 'error'; message: string; class: 'library' | 'render' };

(() => {
  const parentWindow: Window = window.parent;
  const postToParent = window.parent.postMessage.bind(window.parent);
  const listen = window.addEventListener.bind(window);
  const unlisten = window.removeEventListener.bind(window);
  const Parser = DOMParser;
  const Observer = typeof ResizeObserver === 'function' ? ResizeObserver : null;
  const createElement = document.createElement.bind(document);
  const importNode = document.importNode.bind(document);
  const dispatchOnDocument = document.dispatchEvent.bind(document);
  const dispatchOnWindow = window.dispatchEvent.bind(window);
  const root = document.documentElement;
  const head = document.head;
  const body = document.body;
  const ceil = Math.ceil;
  const every = setInterval.bind(window);
  const isInteger = Number.isInteger;

  let sendOverPort: ((reply: Reply) => void) | null = null;
  let port: MessagePort | null = null;
  let readyAnnouncement: ReturnType<typeof setInterval> | null = null;
  let readyAnnouncements = 0;
  /** One page per frame. Reload is a fresh frame, never a second command. */
  let consumed = false;

  const send = (reply: Reply): void => {
    if (sendOverPort !== null) sendOverPort(reply);
  };

  const stopReadyAnnouncements = (): void => {
    if (readyAnnouncement === null) return;
    clearInterval(readyAnnouncement);
    readyAnnouncement = null;
  };

  const bounded = (value: number): number => {
    const whole = ceil(value);
    if (!isInteger(whole) || whole < 1) return 1;
    return whole > FY_RENDER_LIMITS.maxDimension ? FY_RENDER_LIMITS.maxDimension : whole;
  };

  /**
   * Elements whose MARKUP form is an egress or a navigation and which no
   * illustration needs: a `meta` refresh navigates, a `base` retargets every
   * relative URL, a `link` can prerender or prefetch, and an embedded document
   * is a second browsing context this frame's policy already refuses.
   */
  const STRIPPED = 'meta, base, link, iframe, frame, frameset, object, embed, portal';

  /**
   * Only classic and module scripts are re-created. Every other `type` —
   * speculation rules above all, which prerender — is dropped, and a JSON or
   * template block an author left in a `type` the browser would not run anyway
   * loses nothing by staying inert.
   */
  const runnable = (type: string | null): boolean => {
    const value = (type ?? '').trim().toLowerCase();
    return value === '' || value === 'module' || value === 'text/javascript' || value === 'application/javascript';
  };

  /**
   * `DOMParser` marks every script it creates as already started, and an
   * imported clone keeps the mark, so a script moved into this document would
   * never run. A fresh element with the same attributes and text does, in
   * document order, exactly as if the page had been loaded.
   */
  const revive = (container: ParentNode): void => {
    for (const old of Array.from(container.querySelectorAll('script'))) {
      if (!runnable(old.getAttribute('type'))) {
        old.remove();
        continue;
      }
      const fresh = createElement('script');
      for (const attribute of Array.from(old.attributes)) fresh.setAttribute(attribute.name, attribute.value);
      fresh.textContent = old.textContent;
      old.replaceWith(fresh);
    }
  };

  const styleOf = getComputedStyle;
  /**
   * THE PAGE'S OWN HEIGHT, measured from the body rather than the root. A root's
   * `scrollHeight` is never less than the frame's viewport, so a page shorter
   * than the frame's first size would be reported at that size forever and sit
   * on a band of empty background.
   */
  const pageHeight = (): number => {
    const rect = body.getBoundingClientRect();
    const margin = Number.parseFloat(styleOf(body).marginBottom) || 0;
    const measured = rect.bottom + margin;
    return measured > body.scrollHeight ? measured : body.scrollHeight;
  };
  const reportHeight = (): void => send({ height: bounded(pageHeight()), kind: 'height' });

  /**
   * THE APP'S PAINT AS THE PAGE'S DEFAULT, so a frameless page reads as part of
   * the message: background, text colour and font, set on the root where any
   * author stylesheet overrides them. Each is a short string handed to
   * `setProperty`, which ignores a value that does not parse — and none of the
   * three properties can name a URL, so a value is paint and nothing else.
   */
  const applyPaint = (paint: unknown): void => {
    if (paint === null || typeof paint !== 'object') return;
    const value = paint as { background?: unknown; color?: unknown; font?: unknown; scheme?: unknown };
    const set = (property: string, text: unknown): void => {
      if (typeof text === 'string' && text.length > 0 && text.length <= 300) root.style.setProperty(property, text);
    };
    if (value.scheme === 'dark' || value.scheme === 'light') root.style.colorScheme = value.scheme;
    set('background-color', value.background);
    set('color', value.color);
    set('font-family', value.font);
  };

  const renderHtml = (source: unknown, theme: unknown, paint: unknown): void => {
    if (typeof source !== 'string') return send({ class: 'render', kind: 'error', message: 'The page was not text.' });
    // The reader's mode, as the page's DEFAULT — `Canvas`/`CanvasText` follow it,
    // and an author stylesheet overrides it like any other user-agent default.
    root.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
    applyPaint(paint);

    // Escape is forwarded from a CAPTURE listener registered before any author
    // code exists, so a page cannot swallow the one key that leaves fullscreen.
    listen(
      'keydown',
      (event: KeyboardEvent) => {
        if (event.key === 'Escape') send({ kind: 'escape' });
      },
      true,
    );

    const parsed = new Parser().parseFromString(source, 'text/html');
    for (const element of Array.from(parsed.querySelectorAll(STRIPPED))) element.remove();

    for (const attribute of Array.from(parsed.body.attributes)) body.setAttribute(attribute.name, attribute.value);
    for (const node of Array.from(parsed.head.childNodes)) head.appendChild(importNode(node, true));
    const content = document.createDocumentFragment();
    for (const node of Array.from(parsed.body.childNodes)) content.appendChild(importNode(node, true));
    body.replaceChildren(content);

    revive(head);
    revive(body);

    // The page was written expecting a load; give it the two events it would
    // have seen. They are synthetic, and the parent's iframe `load` — the thing
    // that detects a real navigation — is not one of them.
    dispatchOnDocument(new Event('DOMContentLoaded', { bubbles: true }));
    dispatchOnWindow(new Event('load'));

    if (Observer !== null) {
      const observer = new Observer(reportHeight);
      observer.observe(root);
      observer.observe(body);
    }
    reportHeight();
    send({ height: bounded(pageHeight()), kind: 'rendered', width: bounded(root.scrollWidth) });
    // The heartbeat the parent's stall guard listens for: a page that holds the thread stops it.
    every(() => send({ kind: 'beat' }), 1_000);
  };

  const onCommand = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (data === null || typeof data !== 'object') return;
    const command = data as { kind?: unknown; source?: unknown; theme?: unknown; paint?: unknown };
    // A repaint follows the reader's theme for as long as the page runs.
    if (command.kind === 'paint') return applyPaint(command.paint);
    if (command.kind !== 'render-html' || consumed) return;
    consumed = true;
    renderHtml(command.source, command.theme, command.paint);
  };

  const onGlobalMessage = (event: MessageEvent): void => {
    if (port !== null) return;
    if (event.source !== parentWindow) return;
    const offered = event.ports.length > 0 ? event.ports[0] : undefined;
    if (offered === undefined) return;
    port = offered;
    stopReadyAnnouncements();
    sendOverPort = offered.postMessage.bind(offered) as (reply: Reply) => void;
    const startPort = offered.start.bind(offered);
    unlisten('message', onGlobalMessage);
    offered.onmessage = onCommand;
    startPort();
  };

  // A speed bump, not a boundary: the constructors that open WebRTC are removed
  // before author code runs. The residual is declared in `docs/fy-render.md`.
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate']) {
    try {
      Reflect.deleteProperty(window, name);
    } catch {
      // A non-configurable global stays; the policy and the gap say what that means.
    }
  }

  listen('message', onGlobalMessage);
  listen('pagehide', stopReadyAnnouncements);
  postToParent({ kind: 'shell-ready' } satisfies Reply, '*');
  readyAnnouncement = setInterval(() => {
    readyAnnouncements += 1;
    if (readyAnnouncements * 100 >= FY_RENDER_SANDBOX_LIMITS.readyDeadlineMs) {
      stopReadyAnnouncements();
      return;
    }
    postToParent({ kind: 'shell-ready' } satisfies Reply, '*');
  }, 100);
})();
