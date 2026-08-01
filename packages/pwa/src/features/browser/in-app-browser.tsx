/**
 * IN-APP BROWSER — an honest, deliberately narrow reading surface. Ported from
 * `ui/src/components/InAppBrowser.tsx`.
 *
 * A normal tap on an HTTP(S) link opens a right-hand pane without navigating
 * the app, so desktop keeps the conversation visible and usable. Below the
 * 768px layout gate that pane becomes a sheet: a portrait phone cannot fit two
 * useful columns, but the transcript, its scroll position and a half-written
 * composer draft all stay mounted behind it.
 *
 * Most public sites refuse to be framed (X-Frame-Options, CSP
 * frame-ancestors), and the parent page cannot reliably detect that refusal.
 * The UI therefore makes NO loading or error claim: the current URL and an
 * external escape hatch are permanently visible, and a warning says outright
 * that a blank page is normal. Claiming "loaded" when the frame is empty would
 * be worse than saying nothing.
 *
 * NOTHING HERE IS DAEMON-SCOPED, and that is correct rather than an omission:
 * the surface reads a URL the reader tapped, through the browser's own iframe.
 * It holds no daemon data, issues no daemon request, and has no cache that
 * could serve one pairing's bytes to another. `browserDestination` classifies
 * against `document.baseURI` — the page origin — which is the same for every
 * pairing because the page is a static public bundle.
 */

import { ExternalLink, Globe2, ShieldAlert, Smartphone, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Button } from '../../shell/primitives.tsx';
import { browserDestination, shouldOpenInApp, type BrowserDestination } from './in-app-browser-model.ts';

export interface InAppBrowserFrameProps {
  destination: BrowserDestination;
}

/**
 * The iframe engine, without browser chrome. Kept as its own component so a
 * host that owns the address and navigation controls reuses this exact body:
 * the loopback guard and the sandbox attribute must not drift between two
 * copies.
 */
export const InAppBrowserFrame = ({ destination }: InAppBrowserFrameProps) => {
  if (destination.scope !== 'device-loopback')
    return (
      <div className="min-h-0 flex-1 bg-surface-2">
        <iframe
          src={destination.href}
          title={`Embedded view of ${destination.hostname}`}
          className="block h-full min-h-[240px] w-full border-0 bg-surface-2"
          loading="eager"
          referrerPolicy="no-referrer"
          sandbox="allow-downloads allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
        />
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-2 px-panel py-8 text-center">
      <div className="max-w-sm">
        <Smartphone size={30} aria-hidden="true" className="mx-auto text-accent" />
        <h2 className="mb-0 mt-3 font-display text-title font-semibold tracking-display text-fg">
          This address is on your phone
        </h2>
        <p className="mb-0 mt-2 text-ui leading-base text-muted">
          Through the app’s tunnel, localhost and loopback addresses point to this phone—not the agent’s machine. This
          preview cannot reach that dev server.
        </p>
      </div>
    </div>
  );
};

export interface InAppBrowserSurfaceProps {
  destination: BrowserDestination;
  onClose: () => void;
  presentation: 'pane' | 'sheet';
  titleId: string;
}

/**
 * Content only — the host owns the pane or sheet shell around it, so a unified
 * side-pane workspace can re-host this exact surface.
 *
 * The URL rail is `role="group"` on a div in the original. That is one of the
 * shapes biome rewrites into a `<fieldset>`, which is for form controls; the
 * rail is a labelled readout of the address, so it is `role="status"` here —
 * it keeps the accessible name and announces the address when it changes.
 */
export const InAppBrowserSurface = ({ destination, onClose, presentation, titleId }: InAppBrowserSurfaceProps) => {
  const frameAllowed = destination.scope !== 'device-loopback';
  const Heading = presentation === 'pane' ? 'h2' : 'h1';

  return (
    <>
      <header className="shrink-0 border-b border-border-soft px-panel pb-3">
        <div className="flex items-center gap-sm">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent"
            aria-hidden="true"
          >
            <Globe2 size={17} />
          </span>
          <div className="min-w-0">
            <span className="kt-label block">In-app reader</span>
            <Heading id={titleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
              Link preview
            </Heading>
          </div>
          {presentation === 'pane' && (
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="ml-auto min-h-[44px] min-w-[44px] justify-center p-0"
              aria-label="Close browser pane"
              title="Close browser pane"
            >
              <X size={17} aria-hidden="true" />
            </Button>
          )}
        </div>

        <div
          role="status"
          className="mt-2 flex min-h-[44px] items-center gap-sm rounded-control border border-strong bg-surface-2 px-3"
          aria-label="URL being viewed"
        >
          <span className="kt-label shrink-0 text-faint">URL</span>
          <span
            className="scroll-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2 font-mono text-meta text-fg-soft"
            dir="ltr"
            title={destination.href}
          >
            {destination.href}
          </span>
        </div>

        {frameAllowed && (
          <p className="mb-0 mt-2 flex items-start gap-sm text-meta leading-base text-muted">
            <ShieldAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />
            <span>Most public sites block embedded viewing. A blank or refusal page is normal; open externally.</span>
          </p>
        )}
      </header>

      <InAppBrowserFrame destination={destination} />

      <footer className="shrink-0 border-t border-border-soft bg-surface px-panel py-2">
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-sm">
          <a
            href={destination.href}
            target="_blank"
            rel="noreferrer"
            className="kt-btn min-h-[44px] min-w-0 justify-center gap-sm"
          >
            <ExternalLink size={16} aria-hidden="true" className="shrink-0" />
            <span>Open externally</span>
          </a>
          <Button
            type="button"
            variant="primary"
            onClick={onClose}
            className="min-h-[44px] min-w-0 justify-center gap-sm"
          >
            <X size={16} aria-hidden="true" className="shrink-0" />
            Done
          </Button>
        </div>
      </footer>
    </>
  );
};

export interface InAppBrowserSheetProps {
  destination: BrowserDestination;
  open: boolean;
  onClose: () => void;
}

export const InAppBrowserSheet = ({ destination, open, onClose }: InAppBrowserSheetProps) => {
  const instanceId = useId();
  const titleId = `in-app-browser-title-${instanceId}`;

  return (
    <BottomSheet
      id={`in-app-browser-${instanceId}`}
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel="Close in-app browser"
      panelClassName="h-full overflow-hidden bg-surface"
      maxHeight="calc(var(--app-h, 100dvh) - var(--gap-xs))"
      zIndexClass="z-[70]"
    >
      <InAppBrowserSurface destination={destination} onClose={onClose} presentation="sheet" titleId={titleId} />
    </BottomSheet>
  );
};

export interface InAppBrowserPaneProps {
  id: string;
  destination: BrowserDestination;
  onClose: () => void;
}

/** Desktop's non-modal half of the workspace: chat remains visible and usable. */
export const InAppBrowserPane = ({ id, destination, onClose }: InAppBrowserPaneProps) => {
  const instanceId = useId();
  const titleId = `in-app-browser-pane-title-${instanceId}`;
  return (
    <aside
      id={id}
      aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
      className="mb-2 flex min-h-0 shrink-0 flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel"
      style={{ width: 'clamp(320px, 44%, 680px)' }}
    >
      <InAppBrowserSurface destination={destination} onClose={onClose} presentation="pane" titleId={titleId} />
    </aside>
  );
};

export interface InAppBrowserHost {
  readonly paneId: string;
  readonly presentation: 'pane' | 'sheet';
  readonly openDestination: (destination: BrowserDestination, opener: HTMLElement) => void;
}

/**
 * Exported so a unified side-pane workspace can provide this context itself: a
 * transcript link tap then opens the browser SURFACE inside the shared host
 * instead of a browser-only pane. `InAppBrowserWorkspace` remains for callers
 * without the full host.
 */
export const InAppBrowserContext = createContext<InAppBrowserHost | null>(null);

export interface InAppBrowserWorkspaceProps {
  compact: boolean;
  children: ReactNode;
}

/**
 * Session-local browser host. Session panes are retained across app
 * navigation, so its selected URL is retained alongside that session's draft
 * and scroll position.
 */
export const InAppBrowserWorkspace = ({ compact, children }: InAppBrowserWorkspaceProps) => {
  const generatedId = useId();
  const paneId = `in-app-browser-pane-${generatedId}`;
  const openerRef = useRef<HTMLElement | null>(null);
  const [destination, setDestination] = useState<BrowserDestination | null>(null);
  const [open, setOpen] = useState(false);

  const openDestination = useCallback((next: BrowserDestination, opener: HTMLElement) => {
    openerRef.current = opener;
    setDestination(next);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && typeof window !== 'undefined' && document.contains(opener))
      window.requestAnimationFrame(() => opener.focus());
  }, []);

  // Stable while the preview opens and closes, so hundreds of transcript links
  // do not all re-render because the sibling browser surface changed URL.
  const host = useMemo<InAppBrowserHost>(
    () => ({ paneId, presentation: compact ? 'sheet' : 'pane', openDestination }),
    [compact, openDestination, paneId],
  );

  return (
    <InAppBrowserContext.Provider value={host}>
      <div className="flex h-full min-h-0 w-full min-w-0 gap-2">
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
        {!compact && open && destination && <InAppBrowserPane id={paneId} destination={destination} onClose={close} />}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {open && destination
          ? `${compact ? 'Opened link preview' : 'Opened link preview beside the conversation'}: ${destination.href}`
          : ''}
      </div>
      {compact && destination && <InAppBrowserSheet destination={destination} open={open} onClose={close} />}
    </InAppBrowserContext.Provider>
  );
};

export type InAppBrowserLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href?: string };

/** Markdown link renderer: only an explicit, unmodified primary tap opens the surface. */
export const InAppBrowserLink = ({ href, onClick, download, children, ...rest }: InAppBrowserLinkProps) => {
  const host = useContext(InAppBrowserContext);
  const baseHref = typeof document === 'undefined' ? undefined : document.baseURI;
  const renderDestination = browserDestination(href, baseHref);
  const [destination, setDestination] = useState<BrowserDestination | null>(null);
  const [open, setOpen] = useState(false);

  const activate = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    const next = browserDestination(href, event.currentTarget.ownerDocument.baseURI);
    if (!next || !shouldOpenInApp(event, next, download)) return;
    event.preventDefault();
    if (host) {
      host.openDestination(next, event.currentTarget);
      return;
    }
    setDestination(next);
    setOpen(true);
  };

  return (
    <>
      <a
        {...rest}
        href={href}
        download={download}
        target="_blank"
        rel="noreferrer"
        aria-haspopup={renderDestination && (!host || host.presentation === 'sheet') ? 'dialog' : rest['aria-haspopup']}
        aria-controls={renderDestination && host?.presentation === 'pane' ? host.paneId : rest['aria-controls']}
        onClick={activate}
      >
        {children}
      </a>
      {!host &&
        destination &&
        typeof document !== 'undefined' &&
        createPortal(
          <InAppBrowserSheet destination={destination} open={open} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
};
