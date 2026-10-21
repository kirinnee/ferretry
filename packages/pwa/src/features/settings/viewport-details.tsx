/**
 * Settings › This device › About this device › VIEWPORT DETAILS.
 *
 * A diagnostics readout, closed by default: what this browser reports about its screen (display mode,
 * innerHeight, the visual viewport, 100vh/dvh/svh/lvh, the safe-area insets) and where the app's shell,
 * bottom bar, composer and "Jump to latest" actually landed, with the findings `lib/viewport-diagnostics.ts`
 * draws from them. It exists so an iPhone that still shows a gap can be SCREENSHOTTED: the desktop
 * browsers this app is tested in cannot reproduce an installed iOS app's viewport.
 *
 * The composer and the pill live on the chat screen, not here, so "Show over the app" pins the same
 * readout over every screen until it is closed. It never leaves this page in any other way: nothing is
 * stored or sent.
 */

import { X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  type DisplayMode,
  type ViewportReading,
  type ViewportRect,
  viewportFindings,
  viewportRows,
} from '../../lib/viewport-diagnostics.ts';
import { Button } from '../../shell/primitives.tsx';

/** Something that announces resizes: the window, and the visual viewport where there is one. */
interface Announcer {
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** The browser globals one reading needs: the real window and document in the app, a fixture in tests. */
export interface ViewportEnvironment {
  readonly window: Announcer & {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly screen: { readonly width: number; readonly height: number };
    readonly visualViewport?: (Announcer & { readonly height: number; readonly offsetTop: number }) | null;
    /** iOS adds a `standalone` flag; everywhere else it is a plain navigator. */
    readonly navigator: object;
    matchMedia?(query: string): { readonly matches: boolean };
  };
  readonly document: Document;
}

const DISPLAY_MODES: readonly Exclude<DisplayMode, 'browser'>[] = ['fullscreen', 'standalone', 'minimal-ui'];

const toRect = (element: Element | null | undefined): ViewportRect | null => {
  if (element === null || element === undefined) return null;
  const box = element.getBoundingClientRect();
  return { top: box.top, bottom: box.bottom, height: box.height };
};

/** The first match that is on screen: a bar in a `hidden` tab panel is in the DOM but not in view. */
const shown = (document: Document, selector: string): Element | undefined =>
  Array.from(document.querySelectorAll(selector)).find(element => element.closest('[hidden]') === null);

/** One CSS length, measured by an invisible fixed box of that height. */
const measure = (document: Document, length: string): number => {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.setAttribute('data-viewport-probe', '');
  probe.style.cssText = `position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:${length}`;
  document.body.append(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
};

export function readViewport({ window, document }: ViewportEnvironment): ViewportReading {
  const visual = window.visualViewport ?? null;
  const root = document.documentElement;
  const standalone = (window.navigator as { readonly standalone?: unknown }).standalone;
  const mode = DISPLAY_MODES.find(candidate => window.matchMedia?.(`(display-mode: ${candidate})`).matches === true);
  return {
    displayMode: mode ?? 'browser',
    iosStandalone: typeof standalone === 'boolean' ? standalone : null,
    screen: { width: window.screen.width, height: window.screen.height },
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientHeight: root.clientHeight,
    visual: visual === null ? null : { height: visual.height, offsetTop: visual.offsetTop },
    units: {
      vh: measure(document, '100vh'),
      dvh: measure(document, '100dvh'),
      svh: measure(document, '100svh'),
      lvh: measure(document, '100lvh'),
    },
    // The stylesheet's one read of each inset (styles/index.css, "THE PLATFORM'S INSETS").
    insets: {
      top: measure(document, 'var(--inset-top, 0px)'),
      right: measure(document, 'env(safe-area-inset-right, 0px)'),
      bottom: measure(document, 'var(--inset-bottom, 0px)'),
      left: measure(document, 'env(safe-area-inset-left, 0px)'),
    },
    safeBottom: measure(document, 'var(--safe-bottom, 0px)'),
    keyboardOpen: root.getAttribute('data-keyboard') === 'open',
    appHeight: root.style.getPropertyValue('--app-h') || null,
    shell: toRect(shown(document, '.kt-shell')),
    bottomBar: toRect(shown(document, '[data-safe-bottom]')),
    composer: toRect(shown(document, '.fy-chat-input .fy-composer')),
    jumpPill: toRect(shown(document, '.fy-jump-latest')),
  };
}

const browserEnvironment = (): ViewportEnvironment => ({ window, document });

/** How often an open readout re-reads: often enough to follow a keyboard or a pill appearing, cheap enough to leave open. */
const VIEWPORT_REFRESH_MS = 500;

/** A fresh reading while `active`, on every viewport event and on a short tick; null while inactive. */
function useViewportReading(
  active: boolean,
  environment: () => ViewportEnvironment = browserEnvironment,
): ViewportReading | null {
  const [reading, setReading] = useState<ViewportReading | null>(null);
  useEffect(() => {
    if (!active) {
      setReading(null);
      return;
    }
    const env = environment();
    const refresh = () => setReading(readViewport(env));
    refresh();
    const sources: readonly [Announcer | null | undefined, string][] = [
      [env.window, 'resize'],
      [env.window, 'orientationchange'],
      [env.window.visualViewport, 'resize'],
      [env.window.visualViewport, 'scroll'],
    ];
    for (const [source, type] of sources) source?.addEventListener?.(type, refresh);
    const tick = setInterval(refresh, VIEWPORT_REFRESH_MS);
    return () => {
      clearInterval(tick);
      for (const [source, type] of sources) source?.removeEventListener?.(type, refresh);
    };
  }, [active, environment]);
  return reading;
}

/** The readout pinned over every screen: one switch, held in memory only, so a reload always clears it. */
const overlayListeners = new Set<() => void>();
let overlayShown = false;
export const viewportOverlay = {
  shown: (): boolean => overlayShown,
  set(next: boolean): void {
    if (next === overlayShown) return;
    overlayShown = next;
    for (const listener of overlayListeners) listener();
  },
  subscribe(listener: () => void): () => void {
    overlayListeners.add(listener);
    return () => overlayListeners.delete(listener);
  },
};

function Readout({ reading, dense = false }: { readonly reading: ViewportReading; readonly dense?: boolean }) {
  const findings = viewportFindings(reading);
  return (
    <div className="flex flex-col gap-2" data-viewport-readout="">
      {findings.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Findings">
          {findings.map(finding => (
            <li
              key={finding.text}
              className={finding.tone === 'off' ? 'text-warn' : 'text-fg-soft'}
              data-viewport-finding={finding.tone}
            >
              {finding.tone === 'off' ? '✕ ' : '✓ '}
              {finding.text}
            </li>
          ))}
        </ul>
      )}
      <dl className={`m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 ${dense ? 'gap-y-0' : 'gap-y-1'}`}>
        {viewportRows(reading).map(row => (
          <div key={row.label} className="contents">
            <dt className="text-muted">{row.label}</dt>
            <dd className="m-0 min-w-0 break-words font-mono text-fg">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export interface ViewportDetailsProps {
  /** The browser by default; a fixture in tests. */
  readonly environment?: () => ViewportEnvironment;
}

/** Settings › This device › About this device. */
export function ViewportDetails({ environment = browserEnvironment }: ViewportDetailsProps) {
  const [open, setOpen] = useState(false);
  const overlay = useSyncExternalStore(viewportOverlay.subscribe, viewportOverlay.shown);
  const reading = useViewportReading(open, environment);
  return (
    <details
      className="text-ui leading-base"
      data-viewport-details=""
      onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-fg">Viewport details</summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="m-0 text-meta text-muted">
          How this screen measures itself, for a screenshot when something at its edges looks out of place. Nothing here
          is stored or sent.
        </p>
        {reading === null ? null : <Readout reading={reading} />}
        <div>
          <Button data-viewport-overlay-toggle="" onClick={() => viewportOverlay.set(!overlay)} size="sm">
            {overlay ? 'Stop showing over the app' : 'Show over the app'}
          </Button>
        </div>
      </div>
    </details>
  );
}

/** Mounted once beside the app: the readout over every screen while the switch above is on. */
export function ViewportOverlay({ environment = browserEnvironment }: ViewportDetailsProps) {
  const overlay = useSyncExternalStore(viewportOverlay.subscribe, viewportOverlay.shown);
  const reading = useViewportReading(overlay, environment);
  if (!overlay || reading === null) return null;
  return (
    <aside
      aria-label="Viewport details"
      className="pointer-events-none fixed inset-x-2 top-[calc(var(--inset-top,0px)+4px)] z-[80] flex justify-center"
      data-viewport-overlay=""
    >
      <div className="pointer-events-auto max-h-[45dvh] w-full max-w-[30rem] overflow-y-auto rounded-md border border-border-strong bg-surface p-2 text-[11px] leading-tight shadow-popover">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-semibold text-fg">Viewport details</span>
          <Button
            aria-label="Close viewport details"
            onClick={() => viewportOverlay.set(false)}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <Readout dense reading={reading} />
      </div>
    </aside>
  );
}
