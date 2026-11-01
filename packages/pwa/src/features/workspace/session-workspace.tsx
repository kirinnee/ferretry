/**
 * THE SESSION PAGE BODY: the agent's Chat and Console, the workspace's terminals, browsers and files,
 * and Info about the ferret — laid out for the screen it is on.
 *
 *   desktop       the split tree (`WorkspaceView`) beside Info, a resizable right panel when it is open
 *   tablet-split  the split tree, with Info as a bottom sheet (half or full height)
 *   phone         one tab at a time (`PhoneWorkspace`), Info in the same sheet
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
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { FileInstanceSurface } from '../../components/file-instance-surface.tsx';
import { FilesTab } from '../../components/files-tab.tsx';
import type { FilesMarkdownContext } from '../../components/files-views.tsx';
import {
  SessionTerminalDeck,
  type TerminalDeckDependencies,
  type TerminalInputPort,
} from '../../components/session-terminal-deck.tsx';
import type { PaneSnapshotReader } from '../../components/terminal-snapshot.tsx';
import type { BrowserLoginSnapshot } from '../../lib/browser-login.ts';
import { displayCallsign } from '../../lib/callsign.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { liveProcessCount } from '../../lib/session-processes.ts';
import {
  activateWorkspaceTab,
  closeWorkspaceTab,
  focusedWorkspaceTab,
  isAgentTabId,
  visibleTabsInOrder,
  WORKSPACE_PROCESSES_TAB_ID,
  type WorkspaceLayout,
  type WorkspaceTab,
  workspacePanes,
} from '../../lib/workspace-layout.ts';
import type { WorkspaceRailPreferenceStore } from '../../lib/workspace-rail-preferences.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { sidePaneInstanceTabId } from '../../shell/side-pane-tab-model.ts';
import { BrowserSurfaceList, browserPageLabel } from '../browser/browser-surface-list.tsx';
import { remoteBrowserPage } from '../browser/remote-browser-chrome.tsx';
import { rememberBrowserEngine } from '../browser/unified-browser-model.ts';
import { type UnifiedBrowserDependencies, UnifiedBrowserSurface } from '../browser/unified-browser-surface.tsx';
import { browserPageForKey, type SessionBrowser } from '../browser/use-session-browser.ts';
import { AgentControlMarker } from './agent-control-marker.tsx';
import { SurfaceFrame } from './surface-frame.tsx';
import { ConsoleSurface, type ConsoleTyper } from './console-surface.tsx';
import type { PhoneTab, WorkspaceFormFactor } from './phone/phone-tab.ts';
import { PhoneWorkspace } from './phone/phone-workspace.tsx';
import { ProcessesSurface } from './processes-surface.tsx';
import { RailDivider } from './split-divider.tsx';
import { type AgentSurfaceTabs, NO_AGENT_SURFACE_TABS } from './use-agent-surface-tabs.ts';
import { processListOf, useSessionProcesses } from './use-session-processes.ts';
import type { SessionWorkspaceController } from './use-session-workspace.ts';
import { WORKSPACE_FILES_PICKER_KEY } from './use-session-workspace.ts';
import type { SurfaceDriving } from './use-surface-driving.ts';
import type { WorkspaceNewTabKind } from './workspace-tab-strip.tsx';
import { WorkspaceView } from './workspace-view.tsx';

/**
 * Info, as the page binds it: whether it is open, the phone sheet's height, and the panel itself. The
 * frame is this file's — a resizable right panel on a desktop, a half/full bottom sheet elsewhere — and
 * the content is the page's, so the two can never disagree about what Info shows.
 */
export interface SessionInfoSlot {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly sheetSize: 'half' | 'full';
  /** The panel, told whether it is drawn as a desktop panel or in a sheet. */
  readonly render: (presentation: 'panel' | 'sheet', titleId: string) => ReactNode;
}

/** The narrowest Info panel: six tabs and a label column beside a value. */
const INFO_MIN_WIDTH = 360;

/** The sheet's two heights: half the screen, or all of it but a strip to see the page is still there. */
const INFO_SHEET_HEIGHT: Readonly<Record<SessionInfoSlot['sheetSize'], string>> = {
  half: 'min(56dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))',
  full: 'calc(var(--app-h, 100dvh) - 28px)',
};

export interface SessionWorkspaceProps {
  readonly connection: DaemonConnection;
  readonly session: SessionView;
  readonly workspace: SessionWorkspaceController;
  readonly formFactor: WorkspaceFormFactor;
  /** The session bar. */
  readonly renderHeader: () => ReactNode;
  /** The page's transcript and composer, rendered as they are. */
  readonly chat: ReactNode;
  /** Proof and navigation for Markdown a file view renders: the transcript's own surface. */
  readonly references: FilesMarkdownContext;
  readonly driving: SurfaceDriving;
  /** Tabs agents opened, surfaces they handed over: absent, nothing is announced. */
  readonly agentSurfaces?: AgentSurfaceTabs;
  /** Info. Absent: this host has none to show. */
  readonly info?: SessionInfoSlot;
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
  agentSurfaces = NO_AGENT_SURFACE_TABS,
  info,
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
  // The Processes tab's count must stay true while another tab is on screen, so the list is read here —
  // quickly while the tab is shown, slowly otherwise.
  const processesShown =
    formFactor === 'phone'
      ? focusedWorkspaceTab(layout) === WORKSPACE_PROCESSES_TAB_ID
      : isTabShown(layout, WORKSPACE_PROCESSES_TAB_ID);
  const [openProcessId, setOpenProcessId] = useState<string | null>(null);
  const processes = useSessionProcesses({ connection, scope, visible: processesShown });
  const liveProcesses = liveProcessCount(processListOf(processes.state));
  const processesLabel = liveProcesses > 0 ? `Processes · ${String(liveProcesses)}` : 'Processes';

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

  const marker = (tab: WorkspaceTab): ReactNode => (
    <AgentControlMarker
      driver={driving.driverFor(tab.id)}
      ask={agentSurfaces.askFor(tab.id)}
      onDismissAsk={() => agentSurfaces.dismissAsk(tab.id)}
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
      <SurfaceFrame dataBrowser={tab.key}>
        {fullscreen => (
          <>
            {browserPages !== undefined && (
              <BrowserPageFocus active={active} activate={browserPages.activatePage} pageId={page?.id} />
            )}
            <UnifiedBrowserSurface
              daemon={connection}
              isActive={active}
              key={page === undefined ? 'browser' : 'page'}
              onClose={() => undefined}
              presentation={formFactor === 'phone' ? 'sheet' : 'pane'}
              scope={scope}
              titleId={`${titleId}-${tab.key}`}
              host={{
                name: page === undefined ? 'Browser' : browserPageLabel(page),
                fullscreen,
                control: {
                  driver: driving.driverFor(tab.id),
                  ask: agentSurfaces.askFor(tab.id),
                  takenOver: driving.takenOver(tab.id),
                  onTakeOver: () => driving.takeOver(tab.id),
                  onHandBack: () => driving.handBack(tab.id),
                  onDismissAsk: () => agentSurfaces.dismissAsk(tab.id),
                },
                ...(browserPages === undefined
                  ? {}
                  : {
                      pages: (
                        <BrowserSurfaceList
                          driverFor={candidate => driving.driverFor(pageTabId(candidate.id))}
                          onClosePage={candidate =>
                            void browserPages.act({ action: 'close-page', pageId: candidate.id })
                          }
                          onNewPage={() => newPage(browserPages)}
                          onOpenPage={openPage}
                          sessionName={agentName}
                          status={status}
                          takenOver={candidate => driving.takenOver(pageTabId(candidate.id))}
                          {...(page === undefined ? {} : { selectedPageId: page.id })}
                        />
                      ),
                    }),
              }}
              {...(browser === undefined ? {} : { dependencies: browser })}
              {...(onOpenLoginWindow === undefined ? {} : { onOpenLoginWindow })}
            />
          </>
        )}
      </SurfaceFrame>
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
    // Mounted only while on screen, like the Console: an open row follows its output, and a tab nobody
    // is looking at must not. The open row is the page's, so it is still open when the tab comes back.
    if (tab.kind === 'processes' && !options.active) return null;
    if (tab.kind === 'processes')
      return (
        <ProcessesSurface
          compact={formFactor === 'phone'}
          connection={connection}
          onOpenChange={setOpenProcessId}
          onRefresh={processes.refresh}
          openId={openProcessId}
          onShowConsole={() => workspace.showAgentTab('console')}
          scope={scope}
          state={processes.state}
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
          <SessionTerminalDeck
            active={options.active}
            connection={connection}
            dependencies={deck}
            focusTerminalId={tab.key}
            onInputPort={registerPort(tab.id)}
            scope={scope}
            solo
            surfaceStatus={marker(tab)}
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

  // Closing a tab closes its VIEW. A browser tab showing one of the session's pages closes that page
  // too, as closing a browser's own tab does; a file tab is only ever a view, and a terminal's shell
  // ends only when "End shell" is chosen.
  const disposeTab = (tab: WorkspaceTab): void => {
    if (tab.kind !== 'browser' || browserPages === undefined) return;
    const page = browserPageForKey(browserPages.status, tab.key);
    if (page !== undefined) void browserPages.act({ action: 'close-page', pageId: page.id });
  };
  // "End shell" from a terminal tab's close: the deck's own delete, so it ends exactly the way the
  // deck's trash control does.
  const endTerminal =
    deck === undefined
      ? undefined
      : (tab: WorkspaceTab): void => {
          setNotice(null);
          deck
            .close(connection, scope, tab.key)
            .catch((reason: unknown) => setNotice(`Could not end the shell: ${failure(reason)}`));
        };

  // A refused Take over / Hand back is said where every other workspace failure is.
  const shownNotice = notice ?? driving.failure;
  const opened = agentSurfaces.notice;
  const openedLine =
    opened === null ? null : (
      <p className="fy-ws-opened" role="status">
        <span aria-hidden="true" className="fy-ws-new-dot" />
        <span className="fy-ws-opened-text">{opened.text}</span>
        <button type="button" className="fy-ws-marker-action" onClick={agentSurfaces.showNotice}>
          Show
        </button>
        <button
          type="button"
          className="fy-ws-opened-dismiss"
          aria-label="Dismiss"
          onClick={agentSurfaces.dismissNotice}
        >
          ×
        </button>
      </p>
    );
  const noticeLine =
    shownNotice === null ? null : (
      <p className="m-0 px-3 py-1 text-ui text-err" role="alert">
        {shownNotice}
      </p>
    );

  const sheet =
    info === undefined || formFactor === 'desktop' ? null : (
      <BottomSheet
        closeLabel="Close Info"
        height={INFO_SHEET_HEIGHT[info.sheetSize]}
        id={`${titleId}-info`}
        labelledBy={`${titleId}-info-title`}
        maxHeight="calc(var(--app-h, 100dvh) - 28px)"
        onClose={info.onClose}
        open={info.open}
        panelClassName="bg-surface"
      >
        {info.open ? info.render('sheet', `${titleId}-info-title`) : null}
      </BottomSheet>
    );

  if (formFactor === 'phone') {
    const phoneTabs: readonly PhoneTab[] = tabs
      .filter(tab => !isAgentTabId(tab.id))
      .map(tab => ({
        id: tab.id,
        kind: tab.kind,
        label: tab.label,
        driver: driving.driverFor(tab.id),
        fresh: agentSurfaces.unseenTabIds.has(tab.id),
        asked: agentSurfaces.askedTabIds.has(tab.id),
        closable: true,
      }));
    const byId = new Map(tabs.map(tab => [tab.id, tab]));
    const closeTabs = (ids: readonly string[]): void => {
      const next = ids.reduce(closeWorkspaceTab, layout);
      if (next === layout) return;
      setLayout(next);
      for (const id of ids) disposeTab(byId.get(id) as WorkspaceTab);
    };
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col" data-session-workspace="phone">
        <PhoneWorkspace
          activeId={focusedWorkspaceTab(layout)}
          header={
            <>
              {renderHeader()}
              {noticeLine}
              {openedLine}
            </>
          }
          onCloseOthers={tabId => closeTabs(phoneTabs.filter(tab => tab.id !== tabId).map(tab => tab.id))}
          onCloseTab={tabId => closeTabs([tabId])}
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
          processesTab={{ id: WORKSPACE_PROCESSES_TAB_ID, kind: 'processes', label: processesLabel }}
          reopen={agentSurfaces.reopenable.map(surface => ({
            key: `reopen-${surface.tabId}`,
            label: `Reopen ${surface.kind === 'terminal' ? 'terminal' : 'page'} ${surface.label}`,
            onSelect: () => agentSurfaces.reopen(surface.tabId),
          }))}
          {...(deck === undefined ? {} : { onNewTerminal: () => newTab('terminal') })}
          {...(endTerminal === undefined
            ? {}
            : {
                onEndTerminal: (tabId: string) => {
                  closeTabs([tabId]);
                  endTerminal(byId.get(tabId) as WorkspaceTab);
                },
              })}
        />
        {sheet}
      </div>
    );
  }

  const view = (
    <WorkspaceView
      agentName={agentName}
      agentSurfaces={agentSurfaces}
      drivenTabIds={driving.drivenTabIds}
      layout={layout}
      onLayoutChange={setLayout}
      onNewTab={kind => newTab(kind)}
      onTabClosed={disposeTab}
      renderTab={tab => renderBody(tab, { active: isTabShown(layout, tab.id) })}
      tabLabels={new Map([[WORKSPACE_PROCESSES_TAB_ID, processesLabel]])}
      {...(endTerminal === undefined ? {} : { onEndTerminal: endTerminal })}
    />
  );
  // Info needs room for its six tabs: it never draws narrower than INFO_MIN_WIDTH, whatever the rail was.
  const railWidth = Math.max(railPreview ?? railWidths.right, INFO_MIN_WIDTH);
  return (
    <div className="flex h-full min-h-0 min-w-0" data-session-workspace={formFactor}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {renderHeader()}
        {noticeLine}
        {openedLine}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{view}</div>
      </div>
      {info === undefined || formFactor !== 'desktop' || !info.open ? null : (
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
          <aside
            aria-labelledby={`${titleId}-info-title`}
            className="flex min-h-0 shrink-0 flex-col border-l border-border-soft bg-surface"
            data-info-frame=""
            style={{ width: `${railWidth}px` }}
          >
            {info.render('panel', `${titleId}-info-title`)}
          </aside>
        </>
      )}
      {sheet}
    </div>
  );
}
