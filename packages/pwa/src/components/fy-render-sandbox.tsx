/**
 * The parent half of the `fy-render` trusted-data sandbox.
 *
 * WHAT THIS BUYS AND WHAT IT DOES NOT. A trusted library — Mermaid or Lottie —
 * interprets bounded, untrusted DATA inside an opaque-origin frame. No
 * author-supplied code runs anywhere, in this component or in the frame. That
 * is a genuinely different claim from "author JavaScript is sandboxed", which
 * this build does not do and `docs/fy-render.md` records as an open gap.
 *
 * IT HOLDS NO CREDENTIAL. Its props are a parsed block, a play flag, a theme and
 * two callbacks. No `DaemonConnection`, no session id, no daemon URL, no
 * fetcher. The type proves no such field is present today (soundness); it cannot
 * prove a careless future prop addition impossible (completeness), which is why
 * this paragraph is here — the same stance `rich-file-preview.tsx` takes.
 *
 * THE FRAME FETCHES NOTHING FOR ITSELF, and that is a narrower claim than "the
 * frame has no network" — which would be false. It carries no `<script src>`,
 * and its `default-src 'none'` denies every ordinary subresource — XHR,
 * websocket, worker, nested frame, font, remote image. It does NOT deny
 * everything: self-navigation, `<link rel=prerender>` and WebRTC STUN/TURN were
 * all measured egressing from this exact frame shape under this exact policy,
 * and Chromium does not recognise `webrtc 'block'`. Those need trusted-library
 * code to reach, since no author code runs here, but they are a declared
 * residual and not a closed door — `docs/fy-render.md` gap 2.
 *
 * The library bytes are fetched HERE instead, with `credentials: 'omit'` so no
 * cookie or token can ride along, `redirect: 'error'` because the path is fixed,
 * and a per-library cap applied before they are allocated. What stops those
 * bytes being anything other than the build-pinned bundle is the shell's
 * `script-src`, which lists only build-time hashes — measured in real Chromium,
 * not assumed.
 *
 * THE SRC IS SET AFTER THE LISTENER, and that ordering is a fix, not a style.
 * An `<iframe src=…>` written in markup begins loading the moment React inserts
 * it, and the shell announces itself during its first script — which can beat a
 * listener attached in the effect that follows. Measured: the handshake was lost
 * every time. So the element renders with no `src` and the effect attaches the
 * listener first.
 *
 * TRUST IS `event.source`, NEVER `event.origin`. The frame's origin is the
 * literal string `"null"` and authenticates nothing. Exactly one global message
 * is accepted — `shell-ready` from this frame's own `contentWindow` — and it
 * buys a fresh `MessageChannel`; every later global message is ignored and all
 * real traffic goes over the port.
 *
 * THE FRAME IS DELIBERATELY NOT REACHABLE, and that is an accessibility fix
 * rather than a hardening one. It holds no reader control — Play/Pause is a
 * parent button that speaks over the port — so `tabIndex={-1}` takes it out of
 * sequential focus and a `pointer-events: none` rule in `fy-render.css` stops a
 * tap putting focus inside it. Both are needed for one reason: the frame is a
 * separate document, so a keydown delivered inside it never reaches the parent,
 * and the app's Escape listener lives on the PARENT document. One tap on a live
 * animation in fullscreen used to kill Escape until the reader found Exit. The
 * cleaner repair is a shell-side keydown forwarder over the port; that is a
 * protocol addition, and refusing focus to an element with nothing focusable in
 * it costs the reader nothing. It is also why `useDialogFocus`'s `FOCUSABLE`
 * list has no `iframe` entry — a stated decision now, not a selector oversight.
 *
 * ITS ACCESSIBLE NAME SAYS WHAT IT IS, NEVER WHAT IT SHOWS. An iframe cannot
 * carry an empty name (WCAG 4.1.2), and `block.alt` is already the visible
 * `figcaption`, the figure's name and the fullscreen dialog's name — a fourth
 * copy here made a screen reader say the same sentence four times in fullscreen.
 * So the frame is named for the mechanism it is.
 */
import { useEffect, useRef } from 'react';
import {
  FY_RENDER_SANDBOX_LIBRARIES,
  FY_RENDER_SANDBOX_LIMITS,
  fyRenderReadBoundedText,
  type FyRenderBlock as ParsedBlock,
  parseFyRenderSandboxMessage,
} from '../lib/fy-render.ts';

/**
 * The static shell, served from this origin by the Pages deployment.
 *
 * NOT exported: nothing outside this component may point a frame at it, and an
 * exported constant is an invitation to mount a second one somewhere the threat
 * model has not been read. `pages-config.sh` pins the deployed path; that is
 * where the two ends agree, not here.
 */
const FY_RENDER_SHELL_URL = '/fy-render-sandbox.html';

/**
 * WHY THIS IS A CLOSED SET AND NOT A STRING, and the difference is load-bearing
 * for the reader rather than for the type checker.
 *
 * The five cases mean genuinely different things, and two of them are not
 * failures of the payload at all. `lifetime` is the DESIGNED bound on a healthy
 * animation the reader chose to watch: presenting it in an error tone under a
 * wall of authored JSON tells somebody their animation is broken when what
 * actually happened is that two minutes elapsed. Telling those apart used to
 * require matching on the sentence, and a copy edit would then silently change
 * behaviour.
 *
 *   `startup`   the shell never announced itself — a 404, a CSP misdeploy, an
 *               engine that refuses the frame. Nothing about the payload.
 *   `library`   the trusted bundle could not be fetched or was refused by its
 *               own size cap, before any author byte was involved.
 *   `render`    the library, or the parent's re-admission gate, refused the
 *               DATA. This is the only class the authored bytes cause.
 *   `deadline`  Mermaid did not finish inside its bound and was stopped.
 *   `lifetime`  a Lottie frame reached its total permitted life. Not an error.
 *
 * `detail` IS NOT READER COPY. It carries the raw library or gate wording —
 * a jison parse dump complete with a slice of the author's own source, or the
 * exact refusal from `fyRenderMermaidSvg`. `FyRenderBlock` writes its own fixed
 * sentence per class and folds this away underneath it, because author-derived
 * text wearing the app's error styling reads as the app talking.
 */
export type FyRenderSandboxFailureKind = 'startup' | 'library' | 'render' | 'deadline' | 'lifetime';

export interface FyRenderSandboxFailure {
  readonly kind: FyRenderSandboxFailureKind;
  /** Raw diagnostic wording, already clipped by the shell. Never shown as copy. */
  readonly detail: string | null;
}

export interface FyRenderSandboxProps {
  /** A `mermaid` or `lottie` block. Other types never reach a frame. */
  readonly block: ParsedBlock;
  /** Lottie only. Mermaid is static and ignores it. */
  readonly playing: boolean;
  readonly theme: 'dark' | 'light';
  /** Mermaid handed back a compiled diagram. The caller owns validating it. */
  readonly onCompiled: (svg: string) => void;
  /**
   * THE FIRST SUCCESS ACKNOWLEDGEMENT, and it exists so the reader is told.
   *
   * A consented render used to move straight to a transparent frame and stay
   * there — up to 15 s for Mermaid and 120 s for Lottie — with nothing on screen
   * and nothing announced. The shell already sends `rendered` when Lottie has
   * drawn its first frame and it was being discarded here. Mermaid's equivalent
   * is `onCompiled`, so this seam is Lottie's half of the same fact.
   */
  readonly onRendered: () => void;
  /** Any failure at all, classified. The caller owns the reader's sentence. */
  readonly onFailed: (failure: FyRenderSandboxFailure) => void;
  /**
   * Present so the watchdog can be PROVEN rather than asserted by grep.
   *
   * The interesting property — that no message clears the hard timer — is a
   * claim about behaviour, and the only honest way to test it is to send a
   * `rendered` message and watch the timer fire anyway. Doing that against a
   * fifteen-second constant is not a test anybody runs. The application never
   * passes this; the defaults below are the shipped values.
   */
  readonly deadlines?: { readonly readyMs: number; readonly hardMs: number };
}

export function FyRenderSandbox({
  block,
  playing,
  theme,
  onCompiled,
  onFailed,
  onRendered,
  deadlines,
}: FyRenderSandboxProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  /**
   * The callbacks and the play flag travel by ref so that a parent re-render
   * cannot restart the bridge. Re-running the effect would remount the frame,
   * which for Lottie means restarting the animation every time the transcript
   * repaints.
   */
  const latest = useRef({ onCompiled, onFailed, onRendered, playing, theme });
  useEffect(() => {
    latest.current = { onCompiled, onFailed, onRendered, playing, theme };
  });

  // Lottie play/pause is a command on the live port, never a remount.
  useEffect(() => {
    if (block.type !== 'lottie') return;
    portRef.current?.postMessage({ kind: 'set-playing', playing });
  }, [block.type, playing]);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    let done = false;

    const fail = (kind: FyRenderSandboxFailureKind, detail: string | null = null): void => {
      if (done) return;
      done = true;
      latest.current.onFailed({ detail, kind });
    };

    /**
     * THE HARD WATCHDOG. Armed at mount and cleared by exactly one thing: this
     * effect's own teardown. No branch below clears it, which is the point —
     * `sandbox-security-verdict.md` names a watchdog cleared by a `rendered`
     * message as the defect, because reporting success is the first thing a
     * runaway payload would do.
     *
     * The two types bound different things, honestly. Mermaid is a one-shot
     * compile whose frame is destroyed the moment it yields a diagram, so this
     * bounds its whole life. Lottie has to stay alive to keep playing, so this
     * is a total lifetime: it bounds how LONG a payload may compute and says
     * nothing about how hard, which is the declared gap.
     */
    const hardDeadline =
      deadlines?.hardMs ??
      (block.type === 'mermaid'
        ? FY_RENDER_SANDBOX_LIMITS.mermaidDeadlineMs
        : FY_RENDER_SANDBOX_LIMITS.lottieLifetimeMs);
    const hardTimer = window.setTimeout(() => {
      /**
       * TWO CLASSES, NOT ONE MESSAGE. What this timer bounds for Mermaid is a
       * failure — fetch, handshake, install and compile did not all finish — and
       * what it bounds for Lottie is a healthy animation reaching its permitted
       * life. The caller needs to be able to present those differently, and a
       * sentence it would have to match on cannot carry that.
       */
      fail(block.type === 'mermaid' ? 'deadline' : 'lifetime');
    }, hardDeadline);

    /**
     * A DIFFERENT KIND OF TIMER, and the difference is deliberate. This one
     * bounds a handshake rather than a payload, so completing the handshake is
     * allowed to stand it down. It is what turns a missing shell — a 404, a CSP
     * misdeploy, an engine that refuses the frame — into the ordinary source
     * fallback instead of a spinner that never resolves.
     */
    const readyTimer = window.setTimeout(
      () => fail('startup'),
      deadlines?.readyMs ?? FY_RENDER_SANDBOX_LIMITS.readyDeadlineMs,
    );

    const descriptor =
      block.type === 'mermaid' ? FY_RENDER_SANDBOX_LIBRARIES.mermaid : FY_RENDER_SANDBOX_LIBRARIES.lottie;

    /**
     * Started immediately rather than after the handshake: the fetch and the
     * frame load are independent, and serialising them would add a round trip to
     * every illustration for no gain.
     */
    /**
     * The fetch outlives nothing. Without this, replacing the source bytes,
     * withdrawing consent, a frame failure or simply scrolling the row away left
     * a request still streaming and still allocating toward the library cap for
     * a consumer that no longer exists.
     */
    const inflight = new AbortController();

    const library: Promise<string | null> = (async () => {
      try {
        /**
         * `credentials: 'omit'` so no cookie or token rides along to an asset
         * that needs none. `redirect: 'error'` because this descriptor names a
         * FIXED local path: a redirect means the deployment is misconfigured,
         * and following one silently would let a same-origin request end up
         * fetching bytes from somewhere else entirely. `cache: 'no-cache'`
         * revalidates, so a stale bundle cannot be pinned behind a hash change.
         */
        const response = await fetch(descriptor.url, {
          cache: 'no-cache',
          credentials: 'omit',
          redirect: 'error',
          signal: inflight.signal,
        });
        if (!response.ok) return null;
        const read = await fyRenderReadBoundedText(response, descriptor.maxBytes);
        return read.ok ? read.text : null;
      } catch {
        return null;
      }
    })();

    const onPortMessage = (event: MessageEvent): void => {
      const message = parseFyRenderSandboxMessage(event.data);
      // An unparseable message is dropped in silence: it is not from our shell,
      // and answering it would be answering whoever sent it.
      if (message === null) return;
      if (message.kind === 'error') {
        /**
         * `render` because the library, or the parent's re-admission gate, was
         * handed data it refused. The shell's own wording travels as `detail`
         * and is never the reader's sentence: a Mermaid parse error is a
         * multi-line jison dump containing a slice of the author's own source.
         */
        fail('render', message.message);
        return;
      }
      if (message.kind === 'mermaid-svg') {
        if (done) return;
        done = true;
        latest.current.onCompiled(message.svg);
        return;
      }
      if (message.kind === 'rendered') {
        // THE FIRST SUCCESS, and the only one Lottie ever reports. Nothing about
        // the frame's size is read from it — the stylesheet owns that — but the
        // reader is owed the fact that the wait is over. `done` guards it so a
        // frame the watchdog has already stopped cannot report readiness after
        // its failure has been shown.
        if (done) return;
        latest.current.onRendered();
        return;
      }
      // `playing` is an acknowledgement of a command the parent already made,
      // so its arrival tells the reader nothing they did not just do.
    };

    const onGlobalMessage = (event: MessageEvent): void => {
      if (portRef.current !== null) return;
      // Identity, never origin — the origin here is the string "null".
      if (event.source === null || event.source !== frame.contentWindow) return;
      const message = parseFyRenderSandboxMessage(event.data);
      if (message === null || message.kind !== 'shell-ready') return;

      window.clearTimeout(readyTimer);
      window.removeEventListener('message', onGlobalMessage);

      const channel = new MessageChannel();
      channel.port1.onmessage = onPortMessage;
      portRef.current = channel.port1;
      frame.contentWindow?.postMessage({ kind: 'init' }, '*', [channel.port2]);

      void library.then(text => {
        if (done || portRef.current === null) return;
        if (text === null) return fail('library');
        portRef.current.postMessage(
          block.type === 'mermaid'
            ? { kind: 'render-mermaid', library: text, source: block.payload, theme: latest.current.theme }
            : { kind: 'render-lottie', library: text, playing: latest.current.playing, source: block.payload },
        );
      });
    };

    window.addEventListener('message', onGlobalMessage);
    // LAST. See the header note — the listener must exist first.
    frame.src = FY_RENDER_SHELL_URL;

    return () => {
      done = true;
      // Stops the read AND the allocation, not just the callbacks. `done` alone
      // would only stop us acting on the bytes, which is not the same as not
      // reading them.
      inflight.abort();
      window.clearTimeout(hardTimer);
      window.clearTimeout(readyTimer);
      window.removeEventListener('message', onGlobalMessage);
      portRef.current?.close();
      portRef.current = null;
    };
    // The bridge is built once per mounted frame. Reload is a new `key` from the
    // caller, which is the only reliable way to stop a frame's scripts.
  }, [block.payload, block.type, deadlines]);

  return (
    <iframe
      className="fy-render-frame"
      data-fy-render-frame={block.type}
      /**
       * NO `allow-same-origin`, ever. Adding it would give the frame this
       * origin's storage and a reachable parent document, and would make
       * `event.source` checks meaningless. `allow-scripts` alone is what keeps
       * the origin opaque.
       */
      sandbox="allow-scripts"
      // Deliberately NO `src` — the effect sets it after attaching the listener.
      ref={frameRef}
      /**
       * The shell is a static asset that needs no idea which conversation the
       * reader is in. The app's URLs carry session and daemon routes, so the
       * default same-origin referrer would hand the frame's request a piece of
       * context it has no use for.
       */
      referrerPolicy="no-referrer"
      /**
       * OUT OF THE TAB ORDER, and paired with `pointer-events: none` in
       * `fy-render.css` so a tap cannot put focus here either. See the header:
       * this frame has no reader control in it, and focus resting in a separate
       * document is what stopped Escape closing the fullscreen overlay.
       */
      tabIndex={-1}
      /**
       * THE MECHANISM, NEVER THE DESCRIPTION. `block.alt` is already the
       * `figcaption`, the figure's name and the dialog's name; a fourth copy here
       * made a screen reader say one sentence four times in fullscreen. An iframe
       * cannot be nameless, so it is named for what it is.
       */
      title={block.type === 'mermaid' ? 'Mermaid diagram renderer' : 'Lottie animation player'}
    />
  );
}
