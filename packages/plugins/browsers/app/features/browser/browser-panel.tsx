/**
 * THE BROWSER PANEL beside a ferret (the `ferret.side` slot): the ferret's own Chrome pages, one bar, and the live
 * display.
 *
 * It composes what the half owns and nothing else: the session's pages (`useSessionBrowser`), who is driving or holds
 * each (`useBrowserControl`), and `UnifiedBrowserSurface` — the bar, the preview reader and the real browser. Every
 * request rides the daemon's own client; a remote device drives the page only as far as the daemon lets its
 * credential (`browser.use`), and a secret typed into a page never reaches this panel: the display carries pixels the
 * daemon already masked, and an input request is raised through the Vault, not here.
 */

import { useFullscreen, usePanelIntent } from '@ferretry/app';
import type { PanelIntent } from '@ferretry/kernel/manifest';
import { useCallback, useId, useMemo } from 'react';
import { useBrowserControl } from '../../hooks/use-browser-control.ts';
import { browserPageForKey, useSessionBrowser } from './use-session-browser.ts';
import { type BrowserDaemon, browserSessionScope } from '../../lib/scope.ts';
import { BrowserSurfaceList, browserPageLabel } from './browser-surface-list.tsx';
import { remoteBrowserPage } from './remote-browser-chrome.tsx';
import {
  type UnifiedBrowserDependencies,
  UnifiedBrowserSurface,
  type UnifiedBrowserSurfaceProps,
} from './unified-browser-surface.tsx';
import './browser.css';

export interface BrowserPanelProps {
  readonly daemon: BrowserDaemon;
  /** The ferret whose browser this is. */
  readonly sessionId: string;
  /** The two engines, as injectable dependencies (a test substitutes them). */
  readonly dependencies?: UnifiedBrowserDependencies;
  readonly onOpenLoginWindow?: UnifiedBrowserSurfaceProps['onOpenLoginWindow'];
  /** What the host just asked of this panel: "new-page" opens a page (the phone's "+ New browser"). */
  readonly intent?: PanelIntent;
}

/** The panel for one ferret. Without a ferret there is no browser to show. */
export function BrowserPanel({ daemon, sessionId, dependencies, onOpenLoginWindow, intent }: BrowserPanelProps) {
  const scope = useMemo(() => browserSessionScope(daemon, sessionId), [daemon, sessionId]);
  const titleId = useId();
  const pages = useSessionBrowser(scope, daemon);
  const control = useBrowserControl(scope, daemon);
  const fullscreen = useFullscreen<HTMLDivElement>();
  const status = pages.status;
  const activeId = remoteBrowserPage(status)?.activePageId;
  const page = activeId === undefined ? undefined : browserPageForKey(status, activeId);
  const key = page === undefined ? undefined : (page.name ?? page.id);

  const newPage = useCallback((): void => void pages.act({ action: 'new-page' }), [pages]);
  usePanelIntent(intent, 'new-page', newPage);

  return (
    <div
      className="fy-ws-frame relative flex min-h-0 flex-1 flex-col"
      data-fullscreen={fullscreen.active ? '' : undefined}
      data-browser-panel={sessionId}
      ref={fullscreen.ref}
    >
      <UnifiedBrowserSurface
        daemon={daemon}
        scope={scope}
        presentation="pane"
        titleId={`${titleId}-browser`}
        onClose={() => undefined}
        host={{
          name: page === undefined ? 'Browser' : browserPageLabel(page),
          fullscreen: { active: fullscreen.active, toggle: fullscreen.toggle },
          control: {
            driver: key === undefined ? null : control.driverFor(key),
            ask: key === undefined ? null : control.askFor(key),
            takenOver: key === undefined ? false : control.takenOver(key),
            onTakeOver: () => key !== undefined && control.takeOver(key),
            onHandBack: () => key !== undefined && control.handBack(key),
            onDismissAsk: () => key !== undefined && control.dismissAsk(key),
          },
          pages: (
            <BrowserSurfaceList
              driverFor={candidate => control.driverFor(candidate.name ?? candidate.id)}
              onClosePage={candidate => void pages.act({ action: 'close-page', pageId: candidate.id })}
              onNewPage={newPage}
              onOpenPage={candidate => pages.activatePage(candidate.id)}
              status={status}
              takenOver={candidate => control.takenOver(candidate.name ?? candidate.id)}
              {...(page === undefined ? {} : { selectedPageId: page.id })}
            />
          ),
        }}
        {...(dependencies === undefined ? {} : { dependencies })}
        {...(onOpenLoginWindow === undefined ? {} : { onOpenLoginWindow })}
      />
      {control.failure === null ? null : (
        <p role="status" className="m-0 px-panel py-1 text-meta text-err" data-browser-control-failure="">
          {control.failure}
        </p>
      )}
    </div>
  );
}
