/**
 * The parent half of an executing `type: html` block.
 *
 * THIS IS WHERE AUTHOR CODE RUNS, and the frame is the whole boundary. An
 * agent-authored page executes inside `/fy-render-html.html`, mounted as
 * `<iframe sandbox="allow-scripts">` — no `allow-same-origin`, so its origin is
 * opaque: no storage, no cookies, no reach into this document; no
 * `allow-forms`, `allow-popups`, `allow-modals`, `allow-top-navigation` or
 * `allow-downloads`, so it can do none of those. The shell is a STATIC document
 * on this origin with its own policy (`default-src 'none'`, `connect-src
 * 'none'`, `script-src 'unsafe-inline'`), because a `blob:` or `srcdoc` frame
 * inherits this page's hash-pinned policy and could run nothing at all.
 *
 * WHAT IT CANNOT CLOSE is stated in `docs/fy-render.md` gap 1 and not softened
 * here: script in an opaque frame can navigate the frame itself, prerender, and
 * open WebRTC, each measured egressing under a policy like this one. A second
 * `load` on the element is how a navigation shows itself to the parent, and it
 * tears the frame down, leaving the authored source — which bounds what the destination
 * page can then do, not the request that reached it.
 *
 * IT HOLDS NO CREDENTIAL. Its props are a parsed block, its paint, a fullscreen
 * flag and callbacks. No `DaemonConnection`, no session id, no daemon URL, no
 * fetcher — and unlike the library sandbox it fetches nothing at all, because
 * the shell carries its own bootstrap.
 *
 * TRUST IS `event.source`, NEVER `event.origin`, exactly as in
 * `fy-render-sandbox.tsx`: one global `shell-ready` from this frame's own
 * window buys a fresh `MessageChannel`, and the author's page is sent as DATA
 * over it. Every later global message is ignored. Author code shares the
 * shell's realm, so it could forge anything the SHELL could say — which is why
 * the only two things believed from the port are bounded, harmless facts: a
 * height (clamped here) and an Escape keypress.
 *
 * IT IS FOCUSABLE AND TAPPABLE, unlike the library frame, because the content
 * is the interaction. That reopens the problem the library frame avoided — a
 * keydown inside a separate document never reaches the app's Escape listener —
 * so the shell forwards Escape over the port from a capture listener installed
 * before any author code, and the parent closes fullscreen on it.
 *
 * THE WATCHDOG IS WALL-CLOCK LIFE ONLY, armed at mount and cleared by nothing
 * the frame says. It bounds how long author code may run, never how hard: no
 * browser offers a per-frame CPU or memory quota (gap 3).
 */
import { useEffect, useRef, useState } from 'react';
import { FY_RENDER_SANDBOX_LIMITS, type FyRenderBlock, parseFyRenderSandboxMessage } from '../lib/fy-render.ts';
import type { FyRenderSandboxFailure, FyRenderSandboxFailureKind } from './fy-render-sandbox.tsx';

/** Not exported, for the reason `fy-render-sandbox.tsx` gives for its own shell. */
const FY_RENDER_HTML_SHELL_URL = '/fy-render-html.html';

/**
 * WHAT THE PAGE IS PAINTED WITH BY DEFAULT, so a frameless page reads as part of
 * the message: the column's background, text colour and font, and the reader's
 * mode. Three computed CSS values the reader can already see — nothing else of
 * the app. Any author stylesheet overrides them like a user-agent default.
 */
export interface FyRenderHtmlPaint {
  readonly background: string;
  readonly color: string;
  readonly font: string;
  readonly scheme: 'dark' | 'light';
}

export interface FyRenderHtmlFrameProps {
  /** An `html` block. Nothing else reaches this frame. */
  readonly block: FyRenderBlock;
  /** Sent with the page, and again whenever it changes, so a theme switch repaints a running page. */
  readonly paint: FyRenderHtmlPaint;
  /** The page has drawn once; until then the frame is kept invisible so no unpainted plane flashes. */
  readonly ready: boolean;
  /** The frame's accessible name — the block's own description. */
  readonly title: string;
  /** In fullscreen the stylesheet owns the height and the reported one is ignored. */
  readonly fullscreen: boolean;
  /** The page is in: its scripts have run once and it reported its size. */
  readonly onRendered: () => void;
  readonly onFailed: (failure: FyRenderSandboxFailure) => void;
  /** Escape was pressed INSIDE the frame, where the app's own listener cannot hear it. */
  readonly onEscape: () => void;
  /** Shortened deadlines so the watchdog can be proven; the app never passes this. */
  readonly deadlines?: { readonly readyMs: number; readonly hardMs: number };
}

export function FyRenderHtmlFrame({
  block,
  paint,
  ready,
  title,
  fullscreen,
  onRendered,
  onFailed,
  onEscape,
  deadlines,
}: FyRenderHtmlFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** Inline height the page asked for, already clamped. Null until it says. */
  const [height, setHeight] = useState<number | null>(null);
  const done = useRef(false);
  /** Callbacks by ref, so a transcript repaint never rebuilds the bridge and reruns the page. */
  const latest = useRef({ onEscape, onFailed, onRendered, paint });
  useEffect(() => {
    latest.current = { onEscape, onFailed, onRendered, paint };
  });
  const portRef = useRef<MessagePort | null>(null);

  // A repaint is a message on the live port, never a remount — remounting would rerun the page.
  useEffect(() => {
    portRef.current?.postMessage({ kind: 'paint', paint });
  }, [paint]);

  const fail = (kind: FyRenderSandboxFailureKind, detail: string | null = null): void => {
    if (done.current) return;
    done.current = true;
    latest.current.onFailed({ detail, kind });
  };
  const failRef = useRef(fail);
  failRef.current = fail;

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    done.current = false;
    let port: MessagePort | null = null;

    const hardTimer = window.setTimeout(
      () => failRef.current('lifetime'),
      deadlines?.hardMs ?? FY_RENDER_SANDBOX_LIMITS.htmlLifetimeMs,
    );
    const readyTimer = window.setTimeout(
      () => failRef.current('startup'),
      deadlines?.readyMs ?? FY_RENDER_SANDBOX_LIMITS.readyDeadlineMs,
    );

    const onPortMessage = (event: MessageEvent): void => {
      const message = parseFyRenderSandboxMessage(event.data);
      if (message === null || done.current) return;
      if (message.kind === 'height') {
        setHeight(Math.min(message.height, FY_RENDER_SANDBOX_LIMITS.htmlInlineMaxHeightPx));
        return;
      }
      if (message.kind === 'rendered') {
        latest.current.onRendered();
        return;
      }
      if (message.kind === 'escape') {
        latest.current.onEscape();
        return;
      }
      if (message.kind === 'error') failRef.current(message.class, message.message);
    };

    const onGlobalMessage = (event: MessageEvent): void => {
      if (port !== null) return;
      if (event.source === null || event.source !== frame.contentWindow) return;
      if (parseFyRenderSandboxMessage(event.data)?.kind !== 'shell-ready') return;
      window.clearTimeout(readyTimer);
      window.removeEventListener('message', onGlobalMessage);
      const channel = new MessageChannel();
      channel.port1.onmessage = onPortMessage;
      port = channel.port1;
      portRef.current = port;
      frame.contentWindow?.postMessage({ kind: 'init' }, '*', [channel.port2]);
      port.postMessage({
        kind: 'render-html',
        paint: latest.current.paint,
        source: block.payload,
        theme: latest.current.paint.scheme,
      });
    };

    window.addEventListener('message', onGlobalMessage);
    /**
     * THE SECOND `load` AFTER `src` IS A NAVIGATION. The first is the shell
     * arriving; author content is moved in by script and fires none. Anything
     * after that is the frame having been sent somewhere else — `location`, a
     * meta refresh built by script, a link it followed for itself — and the page
     * on screen is no longer the one the reader consented to, so it goes.
     *
     * Counted from HERE, not from mount, and not through React's `onLoad`:
     * inserting a src-less iframe fires a synchronous `load` for its initial
     * `about:blank`, measured in Chromium, and counting that one would tear down
     * every healthy page the moment its shell arrived.
     */
    let loads = 0;
    const onLoad = (): void => {
      loads += 1;
      if (loads > 1) failRef.current('navigation');
    };
    frame.addEventListener('load', onLoad);
    // LAST, after the listener — the ordering `fy-render-sandbox.tsx` explains.
    frame.src = FY_RENDER_HTML_SHELL_URL;

    return () => {
      done.current = true;
      window.clearTimeout(hardTimer);
      window.clearTimeout(readyTimer);
      window.removeEventListener('message', onGlobalMessage);
      frame.removeEventListener('load', onLoad);
      port?.close();
      portRef.current = null;
    };
  }, [block.payload, deadlines]);

  return (
    <iframe
      className="fy-render-frame fy-render-frame--html"
      data-fy-render-frame="html"
      data-fy-render-ready={ready ? 'true' : 'false'}
      ref={frameRef}
      referrerPolicy="no-referrer"
      /** NO `allow-same-origin`, and nothing else either. See the header. */
      sandbox="allow-scripts"
      style={fullscreen || height === null ? undefined : { height: `${height}px` }}
      /**
       * AN EXPLICIT TAB STOP, unlike the library frame's `-1`: the page IS the
       * interaction. Explicit rather than native so `useDialogFocus`'s
       * `[tabindex]` arm counts it and fullscreen's trap can reach it.
       */
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the framed page is interactive content, see above
      tabIndex={0}
      title={title}
    />
  );
}
