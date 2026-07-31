/**
 * The chrome around the remote browser display: lifecycle state, the daemon's
 * real page tabs, the address bar and the viewport controls.
 *
 * Everything here is a projection of one `BrowserStatus` snapshot plus an action
 * dispatcher. The chrome holds no transport and no daemon identity of its own,
 * so a parent that re-scopes to another daemon re-renders it with that daemon's
 * status and nothing from the previous one can survive in it.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ClipboardPaste,
  Expand,
  Globe2,
  Monitor,
  Plus,
  Power,
  PowerOff,
  RotateCw,
  Scan,
  UserRound,
  X,
} from 'lucide-react';
import type { BrowserAction, BrowserPageSummary, BrowserStatus } from '@ferretry/protocol';

import { remotePageLabel, type RemoteViewportMode } from '../../lib/remote-browser.ts';
import { Badge, Button } from '../../shell/primitives.tsx';

export type RemoteBrowserConnection = 'detached' | 'connecting' | 'connected' | 'disconnected';

/** A running browser that has committed a page; the other states carry none. */
export type RemoteBrowserPageStatus = Extract<BrowserStatus, { url: string }>;

/** The running page snapshot, or null while the daemon reports no live page. */
export const remoteBrowserPage = (status: BrowserStatus | null): RemoteBrowserPageStatus | null =>
  status !== null && status.state === 'running' && 'url' in status ? status : null;

export interface RemoteBrowserStatusBarProps {
  readonly status: BrowserStatus | null;
  readonly connection: RemoteBrowserConnection;
  readonly busy?: boolean;
}

/** Lifecycle, attribution and transport state in one non-interactive strip. */
export function RemoteBrowserStatusBar({ status, connection, busy = false }: RemoteBrowserStatusBarProps) {
  const lastActor = status?.lastActor;
  const page = remoteBrowserPage(status);
  const loading = page?.pageState === 'loading';
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-xs border-b border-border-soft px-2 py-2">
      <Badge tone={status?.state === 'running' ? 'ok' : status?.state === 'error' ? 'err' : 'pend'}>
        {status?.state ?? 'checking'}
      </Badge>
      <Badge tone={lastActor?.kind === 'human' ? 'accent' : 'pend'} className="inline-flex items-center gap-1">
        {lastActor?.kind === 'human' ? <UserRound size={13} /> : <Bot size={13} />}
        {lastActor ? `${lastActor.kind === 'human' ? 'You' : 'Agent'} · ${lastActor.action}` : 'No input yet'}
      </Badge>
      <span className="text-meta text-muted" aria-live="polite">
        {busy ? 'Working…' : loading ? 'Loading page…' : page?.pageState === 'error' ? 'Page failed' : ''}
      </span>
      <span className="ml-auto text-meta text-muted">
        {connection === 'connected' ? 'Live' : connection === 'connecting' ? 'Connecting…' : 'Display idle'}
      </span>
    </div>
  );
}

export interface RemoteBrowserPageTabsProps {
  readonly status: BrowserStatus | null;
  readonly busy?: boolean;
  readonly onAction: (action: BrowserAction) => void;
}

/**
 * Only the daemon's real pages are ever tabs. A daemon that reports none gets no
 * strip at all rather than an invented client-side tab.
 */
export function RemoteBrowserPageTabs({ status, busy = false, onAction }: RemoteBrowserPageTabsProps) {
  const page = remoteBrowserPage(status);
  const pages: readonly BrowserPageSummary[] = page?.pages ?? [];
  const agentPageId = status?.agentPage?.pageId;
  if (page === null) return null;
  return (
    <>
      {pages.length > 0 && (
        <div
          role="tablist"
          aria-label="Chrome pages"
          className="flex shrink-0 items-stretch overflow-x-auto overscroll-x-contain border-b border-border-soft bg-surface-2 scroll-thin"
        >
          {pages.map(tab => {
            const selected = tab.id === page.activePageId;
            const label = remotePageLabel(tab);
            return (
              <span
                key={tab.id}
                className="flex min-w-[132px] max-w-[220px] shrink-0 items-stretch border-r border-border-soft data-[active=true]:bg-surface"
                data-active={selected ? true : undefined}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  title={selected ? `${label} — active shared page` : label}
                  disabled={busy}
                  onClick={() => onAction({ action: 'activate-page', pageId: tab.id })}
                  className="inline-flex min-h-[44px] min-w-0 flex-1 items-center gap-1 border-l-2 border-transparent px-2 text-left text-meta text-muted hover:bg-accent-soft hover:text-fg data-[active=true]:border-accent data-[active=true]:font-semibold data-[active=true]:text-fg"
                  data-active={selected ? true : undefined}
                >
                  {tab.id === agentPageId && (
                    <span
                      className="inline-flex shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface px-1 py-0.5 text-muted"
                      title="Agent last used this tab."
                    >
                      <Bot size={11} aria-hidden="true" />
                      <span className="sr-only">Agent last used this tab.</span>
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAction({ action: 'close-page', pageId: tab.id })}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-muted hover:bg-err-bg hover:text-err"
                  aria-label={`Close ${label}`}
                  title={`Close ${label}`}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            );
          })}
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction({ action: 'new-page' })}
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-accent hover:bg-accent-soft"
            aria-label="New Chrome tab"
            title="New Chrome tab"
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {/* The daemon deliberately keeps agentPage after that page is closed. Say
          so plainly rather than dropping the marker or moving it onto another. */}
      {agentPageId !== undefined && !pages.some(tab => tab.id === agentPageId) && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border-soft bg-surface-2 px-2 py-1 text-meta text-muted">
          <Bot size={11} aria-hidden="true" className="shrink-0" />
          <span>Agent last used a closed tab.</span>
        </div>
      )}
    </>
  );
}

export interface RemoteBrowserNavigationProps {
  readonly status: BrowserStatus | null;
  readonly busy?: boolean;
  readonly onAction: (action: BrowserAction) => void;
  /** Reports a rejected address instead of silently dropping the submission. */
  readonly onInvalidAddress?: (message: string) => void;
}

const webUrl = (candidate: string): string | null => {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/**
 * Accepts a bare hostname the way an address bar is expected to, and refuses
 * everything that is not http(s).
 *
 * An input that already spells out a scheme is judged on that scheme alone. The
 * `https://` fallback is reserved for schemeless input: applying it to
 * `file:///etc/passwd` would otherwise smuggle it through as a web host.
 */
export const remoteBrowserAddressUrl = (input: string): string | null => {
  const source = input.trim();
  if (source === '') return null;
  const explicit = webUrl(source);
  if (explicit !== null) return explicit;
  return source.includes('://') ? null : webUrl(`https://${source}`);
};

export function RemoteBrowserNavigation({
  status,
  busy = false,
  onAction,
  onInvalidAddress,
}: RemoteBrowserNavigationProps) {
  const page = remoteBrowserPage(status);
  const running = status?.state === 'running';
  const editingRef = useRef(false);
  const [address, setAddress] = useState('');

  // Truthful, but never destructive: a remote navigation refills the address
  // only when the human is not editing it. Typed text is NOT cleared on blur —
  // that reset used to race a tapped Go and submit the previous URL.
  const url = page?.url;
  useEffect(() => {
    if (url === undefined || editingRef.current) return;
    setAddress(url);
  }, [url]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const target = remoteBrowserAddressUrl(address);
    if (target === null) {
      onInvalidAddress?.(`“${address.trim()}” is not an http or https address.`);
      return;
    }
    onAction({ action: 'navigate', url: target });
  };

  return (
    <form onSubmit={navigate} className="flex shrink-0 items-center gap-xs border-b border-border-soft px-2 py-2">
      <Button
        type="button"
        size="sm"
        disabled={!running || busy || page?.canGoBack !== true}
        onClick={() => onAction({ action: 'back' })}
        aria-label="Back"
      >
        <ArrowLeft size={14} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={!running || busy || page?.canGoForward !== true}
        onClick={() => onAction({ action: 'forward' })}
        aria-label="Forward"
      >
        <ArrowRight size={14} aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={!running || busy}
        onClick={() => onAction({ action: 'reload' })}
        aria-label="Reload"
      >
        <RotateCw size={14} aria-hidden="true" />
      </Button>
      <label className="flex min-w-0 flex-1 items-center gap-1 rounded-control border border-border bg-surface px-2">
        <Globe2 size={14} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="sr-only">Navigate remote browser</span>
        <input
          value={address}
          onChange={event => setAddress(event.target.value)}
          onFocus={() => {
            editingRef.current = true;
          }}
          onBlur={() => {
            editingRef.current = false;
          }}
          disabled={!running}
          placeholder="URL or hostname"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-muted"
        />
      </label>
      <Button type="submit" size="sm" disabled={!running || busy || address.trim() === ''}>
        Go
      </Button>
    </form>
  );
}

export interface RemoteBrowserControlsProps {
  readonly status: BrowserStatus | null;
  readonly connection: RemoteBrowserConnection;
  readonly busy?: boolean;
  readonly fit: boolean;
  readonly viewportMode: RemoteViewportMode;
  readonly onAction: (action: BrowserAction) => void;
  readonly onToggleFit: () => void;
  readonly onToggleViewportMode: () => void;
  readonly onPasteFromClipboard: () => void;
}

/** Lifecycle, clipboard and viewport controls; all touch targets are 44px. */
export function RemoteBrowserControls({
  status,
  connection,
  busy = false,
  fit,
  viewportMode,
  onAction,
  onToggleFit,
  onToggleViewportMode,
  onPasteFromClipboard,
}: RemoteBrowserControlsProps) {
  const running = status?.state === 'running';
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-xs border-b border-border-soft px-2 py-2">
      {running ? (
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() => onAction({ action: 'stop' })}
          className="min-h-[44px] gap-xs"
        >
          <PowerOff size={14} aria-hidden="true" /> Stop
        </Button>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={busy || status?.state === 'starting'}
          onClick={() => onAction({ action: 'start' })}
          className="min-h-[44px] gap-xs"
        >
          <Power size={14} aria-hidden="true" /> Start browser
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        disabled={!running || connection !== 'connected'}
        onClick={onPasteFromClipboard}
        className="min-h-[44px] gap-xs"
      >
        <ClipboardPaste size={14} aria-hidden="true" /> Paste
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={!running}
        onClick={onToggleFit}
        aria-pressed={fit}
        className="min-h-[44px] gap-xs"
      >
        <Expand size={14} aria-hidden="true" /> {fit ? 'Fit' : '1:1'}
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={!running}
        onClick={onToggleViewportMode}
        aria-pressed={viewportMode === 'desktop'}
        className="min-h-[44px] gap-xs"
        title="On a phone, desktop fit keeps a 1280×800 viewport and scales it to width"
      >
        {viewportMode === 'desktop' ? <Monitor size={14} aria-hidden="true" /> : <Scan size={14} aria-hidden="true" />}
        {viewportMode === 'desktop' ? 'Desktop fit' : 'Responsive'}
      </Button>
    </div>
  );
}

/** Governor facts: negotiated viewport, attached viewers and the idle stop. */
export function RemoteBrowserGovernor({ status }: { readonly status: BrowserStatus | null }) {
  return (
    <div className="shrink-0 border-t border-border-soft px-3 py-1.5 text-meta text-muted">
      {status
        ? `${status.viewport.width}×${status.viewport.height} · ${status.viewers} viewer${
            status.viewers === 1 ? '' : 's'
          } · ${Math.round(status.idleTimeoutSeconds / 60)}m idle stop`
        : 'Checking browser lifecycle…'}
    </div>
  );
}
