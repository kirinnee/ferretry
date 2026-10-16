/**
 * THE SESSION PAGE BODY: the agent's Chat and Console, the workspace's terminals, browsers and files,
 * and the "This folder" context — laid out for the screen it is on.
 *
 *   desktop       the split tree (`WorkspaceView`) beside a resizable context rail
 *   tablet-split  the split tree, with the context as a bottom sheet behind ◧ in the session bar
 *   phone         one tab at a time (`PhoneWorkspace`), the same sheet behind ◧
 *
 * WHAT THIS FILE OWNS is the mapping from a tab to the surface that already exists for it; it builds
 * no surface of its own. Chat is the page's own transcript and composer, handed in untouched. Console
 * is the agent's managed pane. A terminal tab is ONE shell from the existing co-controlled deck; a
 * browser tab is the existing remote browser under the session's page strip (`BrowserSurfaceList`),
 * and a browser tab whose key names a page — `%browser:app` — brings that page into the person's view
 * when it is opened; a file tab is the existing file view, and `file:.` is the existing Files picker. The layout itself is the page's (`useSessionWorkspace`), so a reference
 * chip and a tab click change the same remembered layout.
 */

import type { BrowserPageSummary, SessionView } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { FileInstanceSurface } from '../../components/file-instance-surface.tsx';
import type { FilesMarkdownContext } from '../../components/files-views.tsx';
import { FilesTab } from '../../components/files-tab.tsx';
import {
  SessionTerminalDeck,
  type TerminalDeckDependencies,
  type TerminalInputPort,
} from '../../components/session-terminal-deck.tsx';
import type { PaneSnapshotReader } from '../../components/terminal-snapshot.tsx';
import type { BrowserLoginSnapshot } from '../../lib/browser-login.ts';
import { displayCallsign } from '../../lib/callsign.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  activateWorkspaceTab,
  focusedWorkspaceTab,
  isAgentTabId,
  visibleTabsInOrder,
  type WorkspaceLayout,
  type WorkspaceTab,
  workspacePanes,
} from '../../lib/workspace-layout.ts';
import { sidePaneInstanceTabId } from '../../shell/side-pane-tab-model.ts';
import type { WorkspaceRailPreferenceStore } from '../../lib/workspace-rail-preferences.ts';
import { BrowserSurfaceList, browserPageLabel } from '../browser/browser-surface-list.tsx';
import { remoteBrowserPage } from '../browser/remote-browser-chrome.tsx';
import { rememberBrowserEngine } from '../browser/unified-browser-model.ts';
import { UnifiedBrowserSurface, type UnifiedBrowserDependencies } from '../browser/unified-browser-surface.tsx';
import { browserPageForKey, type SessionBrowser } from '../browser/use-session-browser.ts';
import { ContextRail } from '../context-rail/context-rail.tsx';
import { ContextRailBody, type ContextRailBodyProps } from '../context-rail/context-rail-body.tsx';
import type { ContextRailTab } from '../context-rail/context-rail-model.ts';
import { AgentControlMarker } from './agent-control-marker.tsx';
import { ConsoleSurface, type ConsoleTyper } from './console-surface.tsx';
import { ContextSheet, ContextSheetButton } from './phone/context-sheet.tsx';
import { PhoneWorkspace } from './phone/phone-workspace.tsx';
import type { PhoneTab, WorkspaceFormFactor } from './phone/phone-tab.ts';
import { RailDivider } from './split-divider.tsx';
import type { SessionWorkspaceController } from './use-session-workspace.ts';
import { WORKSPACE_FILES_PICKER_KEY } from './use-session-workspace.ts';
import type { SurfaceDriving } from './use-surface-driving.ts';
import type { WorkspaceNewTabKind } from './workspace-tab-strip.tsx';
import { WorkspaceView } from './workspace-view.tsx';

/** The context rail's data, as the page binds it; the shown sub-tab is this file's to keep. */
export type SessionContextRailProps = Omit<ContextRailBodyProps, 'tab' | 'onTabChange'>;

/** Where the "This folder" context stands: which sub-tab, and whether it is out. */
export interface SessionContextPlacement {
  readonly tab: ContextRailTab;
  readonly setTab: (tab: ContextRailTab) => void;
  /** Desktop: the rail is folded to its 40px strip. */
  readonly railCollapsed: boolean;
  readonly setRailCollapsed: (collapsed: boolean) => void;
  /** Phone and tablet: the bottom sheet is open. */
  readonly sheetOpen: boolean;
  readonly setSheetOpen: (open: boolean) => void;
  /** Brings `tab` into view wherever the context lives on this screen. */
  readonly reveal: (tab: ContextRailTab) => void;
}

/** One placement per page, so a `/skill` chip and the ◧ button move the same context. */
export function useContextPlacement(formFactor: WorkspaceFormFactor): SessionContextPlacement {
  const [tab, setTab] = useState<ContextRailTab>('signals');
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const reveal = useCallback(
    (next: ContextRailTab): void => {
      setTab(next);
      if (formFactor === 'desktop') setRailCollapsed(false);
      else setSheetOpen(true);
    },
    [formFactor],
  );
  return { tab, setTab, railCollapsed, setRailCollapsed, sheetOpen, setSheetOpen, reveal };
}

export interface SessionWorkspaceProps {
  readonly connection: DaemonConnection;
  readonly session: SessionView;
  readonly workspace: SessionWorkspaceController;
  readonly formFactor: WorkspaceFormFactor;
  /** The session bar. `contextButton` is the ◧ that opens the context sheet, or null beside a rail. */
  readonly renderHeader: (contextButton: ReactNode) => ReactNode;
  /** The page's transcript and composer, rendered as they are. */
  readonly chat: ReactNode;
  /** Proof and navigation for Markdown a file view renders: the transcript's own surface. */
  readonly references: FilesMarkdownContext;
  readonly driving: SurfaceDriving;
  readonly context: SessionContextPlacement;
  /** The rail's data. Absent: this host has no context to show, so neither rail nor ◧ appears. */
  readonly rail?: SessionContextRailProps;
  readonly rails: WorkspaceRailPreferenceStore;
  /** The co-controlled terminals. Absent: terminal tabs say so, and ＋ offers none. */
  readonly deck?: TerminalDeckDependencies;
  readonly readSnapshot?: PaneSnapshotReader;
  /** Typing into the Console; absent, it types through the daemon's own route. */
  readonly typeIntoConsole?: ConsoleTyper;
  readonly browser?: UnifiedBrowserDependencies;
  /** The session's browser pages, for the page strip over every browser tab. */
  readonly browserPages?: SessionBrowser;
  readonly onOpenLoginWindow?: () => Promise<BrowserLoginSnapshot>;
}

/**
 * Brings a page into the person's view when its tab is shown — once per showing, not on every poll:
 * two panes each showing a page would otherwise take the session's one view back and forth for ever.
 */
function BrowserPageFocus({
  active,
  pageId,
  activate,
}: {
  readonly active: boolean;
  readonly pageId: string | undefined;
  readonly activate: (pageId: string) => void;
}) {
  useEffect(() => {
    if (active && pageId !== undefined) activate(pageId);
  }, [active, pageId, activate]);
  return null;
}

/** Is this tab the one on screen in a shown pane? A parked or deselected tab is not. */
const isTabShown = (layout: WorkspaceLayout, tabId: string): boolean =>
  workspacePanes(layout.root).some(pane => pane.active === tabId);

const failure = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/** The next free `%browser:` key in this layout: `b1`, `b2`… — short, because a reader types it. */
const nextBrowserKey = (tabs: readonly WorkspaceTab[]): string => {
  const used = new Set(tabs.filter(tab => tab.kind === 'browser').map(tab => tab.key));
  let next = 1;
  while (used.has(`b${next}`)) next += 1;
  return `b${next}`;
};

export function SessionWorkspace({
  connection,
  session,
  workspace,
  formFactor,
  renderHeader,
  chat,
  references,
  driving,
  context,
  rail,
  rails,
  deck,
  readSnapshot,
  typeIntoConsole,
  browser,
  browserPages,
  onOpenLoginWindow,
}: SessionWorkspaceProps) {
  const titleId = useId();
  const { layout, setLayout, scope } = workspace;
  const ports = useRef(new Map<string, TerminalInputPort>());
  const [notice, setNotice] = useState<string | null>(null);
  const [railPreview, setRailPreview] = useState<number | null>(null);
  const railWidths = useSyncExternalStore(rails.subscribe, rails.snapshot, rails.snapshot);
  const tabs = visibleTabsInOrder(layout);
  // The agent's first name (#497 names every agent), for the Console's words and the agent tabs' titles.
  const agentName = displayCallsign(session.config.teammate);

  // A new tab lands in the focused workspace pane — the layout's own rule — and pressing a pane's ＋
  // focuses that pane first, so it lands where it was asked for.
  const newTab = (kind: WorkspaceNewTabKind): void => {
    setNotice(null);
    if (kind === 'file') {
      workspace.openFilePicker();
      return;
    }
    if (kind === 'browser') {
      workspace.openSurface('browser', nextBrowserKey(tabs), 'Browser');
      return;
    }
    if (deck === undefined) {
      setNotice('Terminals are not available on this page.');
      return;
    }
    deck
      .create(connection, scope)
      .then(terminal => workspace.openSurface('terminal', terminal.id, terminal.title))
      .catch((reason: unknown) => setNotice(`Could not open a terminal: ${failure(reason)}`));
  };

  // One registration per typeable tab — a terminal or the Console — for the phone key bar to write through.
  const registerPort =
    (tabId: string) =>
    (port: TerminalInputPort | null): void => {
      if (port === null) ports.current.delete(tabId);
      else ports.current.set(tabId, port);
    };

  const marker = (tab: WorkspaceTab, inline = false): ReactNode => (
    <AgentControlMarker
      driver={driving.driverFor(tab.id)}
      inline={inline}
      takenOver={driving.takenOver(tab.id)}
      onTakeOver={() => driving.takeOver(tab.id)}
      onHandBack={() => driving.handBack(tab.id)}
    />
  );
  /** A page's control facts, read the way its own tab reads them. */
  const pageTabId = (pageId: string): string => sidePaneInstanceTabId('browser', pageId);

  /** Opens a page's own tab: keyed by its name when it has one, as a `%browser:` reference is. */
  const openPage = (page: BrowserPageSummary): void =>
    workspace.openSurface('browser', page.name ?? page.id, browserPageLabel(page));
  const newPage = (pages: SessionBrowser): void => {
    setNotice(null);
    void pages.act({ action: 'new-page' }).then(status => {
      const opened =
        status === null ? undefined : browserPageForKey(status, remoteBrowserPage(status)?.activePageId ?? '');
      if (opened === undefined) setNotice('Could not open a new page in this session’s browser.');
      else openPage(opened);
    });
  };

  const renderBrowser = (tab: WorkspaceTab, active: boolean): ReactNode => {
    const status = browserPages?.status ?? null;
    const page = browserPageForKey(status, tab.key);
    // A page's tab shows that page in the session's real browser, never the preview reader.
    if (page !== undefined) rememberBrowserEngine(scope, 'remote');
    return (
      <div className="relative flex min-h-0 flex-1 flex-col" data-workspace-browser={tab.key}>
        {browserPages === undefined ? (
          marker(tab)
        ) : (
          <>
            <BrowserSurfaceList
              driverFor={candidate => driving.driverFor(pageTabId(candidate.id))}
              onClosePage={candidate => void browserPages.act({ action: 'close-page', pageId: candidate.id })}
              onNewPage={() => newPage(browserPages)}
              onOpenPage={openPage}
              sessionName={agentName}
              status={status}
              takenOver={candidate => driving.takenOver(pageTabId(candidate.id))}
              trailing={marker(tab, true)}
              {...(page === undefined ? {} : { selectedPageId: page.id })}
            />
            <BrowserPageFocus active={active} activate={browserPages.activatePage} pageId={page?.id} />
          </>
        )}
        <UnifiedBrowserSurface
          daemon={connection}
          isActive={active}
          key={page === undefined ? 'browser' : 'page'}
          onClose={() => undefined}
          presentation={formFactor === 'phone' ? 'sheet' : 'pane'}
          scope={scope}
          showPageTabs={browserPages === undefined}
          streamTicket={null}
          titleId={`${titleId}-${tab.key}`}
          {...(browser === undefined ? {} : { dependencies: browser })}
          {...(onOpenLoginWindow === undefined ? {} : { onOpenLoginWindow })}
        />
      </div>
    );
  };

  const renderBody = (
    tab: WorkspaceTab,
    options: { readonly active: boolean; readonly interceptInput?: (data: string) => string },
  ): ReactNode => {
    if (tab.kind === 'chat') return chat;
    // The Console polls the agent's pane while it is mounted, so it is mounted only while on screen:
    // a session page that never looks at its Console must not read the pane every few seconds.
    if (tab.kind === 'console' && !options.active) return null;
    if (tab.kind === 'console')
      return (
        <ConsoleSurface
          agentName={agentName}
          connection={connection}
          onInputPort={registerPort(tab.id)}
          scope={scope}
          {...(readSnapshot === undefined ? {} : { readSnapshot })}
          {...(typeIntoConsole === undefined ? {} : { typeInto: typeIntoConsole })}
          {...(options.interceptInput === undefined ? {} : { interceptInput: options.interceptInput })}
        />
      );
    if (tab.kind === 'terminal') {
      if (deck === undefined)
        return (
          <p className="m-3 text-ui text-muted" role="status">
            Terminals are not available on this page.
          </p>
        );
      return (
        <div className="relative flex min-h-0 flex-1 flex-col" data-workspace-terminal={tab.key}>
          {/* A strip of its own over the shell, never floating on it: a pill there would cover the
              deck's own header and the line it is writing. */}
          {driving.driverFor(tab.id) !== null || driving.takenOver(tab.id) ? (
            <div className="fy-ws-marker-row">{marker(tab, true)}</div>
          ) : null}
          <SessionTerminalDeck
            connection={connection}
            dependencies={deck}
            focusTerminalId={tab.key}
            onInputPort={registerPort(tab.id)}
            scope={scope}
            solo
            {...(options.interceptInput === undefined ? {} : { interceptInput: options.interceptInput })}
            {...(session.config.cwd === undefined ? {} : { cwd: session.config.cwd })}
          />
        </div>
      );
    }
    if (tab.kind === 'browser') return renderBrowser(tab, options.active);
    if (tab.key === WORKSPACE_FILES_PICKER_KEY)
      return (
        <FilesTab
          daemon={connection}
          markdown={references}
          onOpenFile={(path, selection) => workspace.openFile(path, selection)}
          scope={scope}
          {...(session.config.cwd === undefined ? {} : { cwd: session.config.cwd })}
        />
      );
    return (
      <FileInstanceSurface
        daemon={connection}
        instance={workspace.fileInstance(tab.key)}
        markdown={references}
        scope={scope}
      />
    );
  };

  // A refused Take over / Hand back is said where every other workspace failure is.
  const shownNotice = notice ?? driving.failure;
  const noticeLine =
    shownNotice === null ? null : (
      <p className="m-0 px-3 py-1 text-ui text-err" role="alert">
        {shownNotice}
      </p>
    );

  const sheet =
    rail === undefined || formFactor === 'desktop' ? null : (
      <ContextSheet
        onClose={() => context.setSheetOpen(false)}
        open={context.sheetOpen}
        renderBody={() => <ContextRailBody {...rail} onTabChange={context.setTab} tab={context.tab} />}
      />
    );
  const sheetButton =
    rail === undefined || formFactor === 'desktop' ? null : (
      <ContextSheetButton onOpen={() => context.setSheetOpen(true)} open={context.sheetOpen} />
    );

  if (formFactor === 'phone') {
    const phoneTabs: readonly PhoneTab[] = tabs
      .filter(tab => !isAgentTabId(tab.id))
      .map(tab => ({
        id: tab.id,
        kind: tab.kind,
        label: tab.label,
        driver: driving.driverFor(tab.id),
      }));
    const byId = new Map(tabs.map(tab => [tab.id, tab]));
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col" data-session-workspace="phone">
        <PhoneWorkspace
          activeId={focusedWorkspaceTab(layout)}
          header={
            <>
              {renderHeader(sheetButton)}
              {noticeLine}
            </>
          }
          onFocusTerminal={tabId => ports.current.get(tabId)?.focus()}
          onNewBrowser={() => newTab('browser')}
          onOpenFile={() => newTab('file')}
          onSelect={tabId => setLayout(activateWorkspaceTab(layout, tabId))}
          onTerminalInput={(tabId, data) => ports.current.get(tabId)?.write(data)}
          renderTab={(phoneTab, { active, interceptInput }) => {
            const tab = byId.get(phoneTab.id) as WorkspaceTab;
            return renderBody(tab, { active, interceptInput });
          }}
          tabs={phoneTabs}
          {...(deck === undefined ? {} : { onNewTerminal: () => newTab('terminal') })}
        />
        {sheet}
      </div>
    );
  }

  const view = (
    <WorkspaceView
      agentName={agentName}
      drivenTabIds={driving.drivenTabIds}
      layout={layout}
      onLayoutChange={setLayout}
      onNewTab={kind => newTab(kind)}
      renderTab={tab => renderBody(tab, { active: isTabShown(layout, tab.id) })}
      {...(deck === undefined
        ? {}
        : {
            // "End shell" from a terminal tab's close: the deck's own delete, so it ends exactly the
            // way the deck's trash control does.
            onEndTerminal: (tab: WorkspaceTab) => {
              setNotice(null);
              deck
                .close(connection, scope, tab.key)
                .catch((reason: unknown) => setNotice(`Could not end the shell: ${failure(reason)}`));
            },
          })}
    />
  );
  const railWidth = railPreview ?? railWidths.right;
  return (
    <div className="flex h-full min-h-0 min-w-0" data-session-workspace={formFactor}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {renderHeader(sheetButton)}
        {noticeLine}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{view}</div>
      </div>
      {rail === undefined || formFactor !== 'desktop' ? null : context.railCollapsed ? (
        <ContextRail {...rail} collapsed onCollapsedChange={context.setRailCollapsed} />
      ) : (
        <>
          <RailDivider
            onCommit={width => {
              setRailPreview(null);
              rails.setWidth('right', width);
            }}
            onPreview={setRailPreview}
            side="right"
            width={railWidth}
          />
          <div
            className="flex min-h-0 shrink-0 flex-col"
            data-context-rail-frame=""
            style={{ width: `${railWidth}px` }}
          >
            <ContextRail
              {...rail}
              collapsed={false}
              onCollapsedChange={context.setRailCollapsed}
              onTabChange={context.setTab}
              tab={context.tab}
            />
          </div>
        </>
      )}
      {sheet}
    </div>
  );
}
