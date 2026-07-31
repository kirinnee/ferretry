/**
 * The visual harness page. NOT part of the shipped bundle — it exists so a
 * human (and `harness/screenshot.ts`) can look at the ported shell in a real
 * browser, at a phone width and a desktop width, with the real design-system
 * stylesheet applied.
 *
 * It renders the shell chrome only. Feature screens belong to a sibling unit.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { BottomSheet } from '../src/shell/bottom-sheet.tsx';
import { ActionGroup, Badge, Button, Card, Label, PanelBody, PanelHeader, Textarea } from '../src/shell/primitives.tsx';
import {
  getSidePaneTabDefinitions,
  openSidePaneFileTab,
  openSidePaneTab,
  readSidePaneTabsState,
  resolveSidePaneTab,
  type SidePaneTabDefinition,
} from '../src/shell/side-pane-tab-model.ts';
import { SidePaneTabs } from '../src/shell/side-pane-tabs.tsx';
import { ViewTabs } from '../src/shell/view-tabs.tsx';
import { AppBar } from '../src/shell/app-bar.tsx';
import { SheetTabs } from '../src/shell/sheet-tabs.tsx';
import { SidePaneResizeHandle } from '../src/shell/side-pane-resize-handle.tsx';
import { SidePaneSearch } from '../src/shell/side-pane-search.tsx';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';
import { SIDE_PANE_DEFAULT_WIDTH } from '../src/lib/side-pane-preferences.ts';
import { DETAILS_TAB_ORDER, type DetailsTab } from '../src/hooks/use-details-tab.ts';

const daemon = daemonConnection({
  daemonId: 'harness-daemon',
  baseUrl: 'https://daemon.invalid/',
  deviceToken: 'harness-token',
});
const scope = daemonSessionScope(daemon, 'harness-session');

openSidePaneTab(scope, 'pins');
openSidePaneFileTab(scope, 'packages/p../src/shell/side-pane-tabs.tsx');
openSidePaneFileTab(scope, 'README.md');

/** Phone below this width, exactly as the app decides its presentation. */
const PHONE_MAX = 768;

function Shell() {
  const [version, bump] = useState(0);
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('identity');
  const [paneWidth, setPaneWidth] = useState(SIDE_PANE_DEFAULT_WIDTH);
  const [query, setQuery] = useState('');
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const state = readSidePaneTabsState(scope);
  const phone = viewport.width <= PHONE_MAX;

  // The headless browser sizes its window after the first paint, so a viewport
  // read once at mount would report the wrong width in the screenshot.
  useEffect(() => {
    const sync = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  const tabs = state.open
    .map(id => resolveSidePaneTab(scope, id))
    .filter((def): def is SidePaneTabDefinition => def !== undefined);

  const rerender = () => bump(version + 1);

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar
        crumbs={[{ href: '/d/harness-daemon', label: 'Sessions' }, { label: 'Fix flaky test' }]}
        daemon={daemon.daemonId}
        onOpenPalette={() => {}}
        onOpenSidebar={() => {}}
        sessionCount={7}
        connectionStatus="reconnecting"
        // Desktop only, and deliberately: at 390 the chip and the destination
        // selector together squeeze the centred palette entry out of the bar.
        // That is the original's own layout, inherited rather than introduced —
        // showing the chip here would only hide the palette in every phone
        // screenshot. The chip's own behaviour is covered at desktop width and
        // in the unit tests.
        updateReady={phone ? null : 'update'}
        active="warden"
        themeToggle={<Button size="sm">Theme</Button>}
      />

      <div className="flex min-h-0 flex-col gap-panel p-panel">
        <header className="flex items-center gap-sm">
          <Label>Ferretry shell harness</Label>
          <Badge tone="ok">{phone ? 'phone' : 'desktop'}</Badge>
          <span className="text-2xs text-muted">
            {viewport.width}×{viewport.height}
          </span>
        </header>

        {/* The desktop workspace: chat on the left, the pane on the right, and
            the separator between them. The handle measures its own parent and
            grandparent, so the nesting here is the nesting the app uses. */}
        {/* On a phone the pane is a full-width surface stacked under the
            conversation — there is no room for a second column, and so no
            separator to drag. */}
        <div className={`relative flex min-h-[160px] gap-2 ${phone ? 'flex-col' : 'flex-row'}`}>
          <Card className="min-w-0 flex-1 p-panel text-ui text-muted">The conversation column.</Card>
          <div className="relative min-w-0 shrink-0" style={phone ? undefined : { width: `${paneWidth}px` }}>
            {!phone && <SidePaneResizeHandle width={paneWidth} onPreview={setPaneWidth} onCommit={setPaneWidth} />}
            <Card className="flex h-full flex-col gap-sm p-panel">
              <SidePaneSearch
                value={query}
                onChange={setQuery}
                ariaLabel="Filter the side pane"
                placeholder="Search this pane"
              />
              <SheetTabs
                sheetId="harness-sheet-tabs"
                tabs={DETAILS_TAB_ORDER.map(key => ({ key, label: key[0]?.toUpperCase() + key.slice(1) }))}
                current={detailsTab}
                order={DETAILS_TAB_ORDER}
                onChange={setDetailsTab}
              />
              <div className="text-ui text-muted">The {detailsTab} section renders here.</div>
            </Card>
          </div>
        </div>

        <Card className="flex min-h-0 flex-col overflow-hidden">
          <SidePaneTabs
            paneId="harness-pane"
            presentation={phone ? 'sheet' : 'pane'}
            tabs={tabs}
            all={getSidePaneTabDefinitions()}
            current={state.active ?? tabs[0]?.id ?? ''}
            onSelect={id => {
              openSidePaneTab(scope, id);
              rerender();
            }}
            onAdd={id => {
              openSidePaneTab(scope, id);
              rerender();
            }}
            onRemove={() => rerender()}
          />
          <PanelBody className="min-h-[180px] text-ui text-muted">
            The active surface body renders here. Feature surfaces are a sibling unit.
          </PanelBody>
        </Card>

        <Card>
          <PanelHeader className="flex items-center justify-between">
            <Label>Primitives</Label>
            <ActionGroup>
              <Button size="sm">Outline</Button>
              <Button size="sm" variant="primary">
                Primary
              </Button>
              <Button size="sm" variant="ghost">
                Ghost
              </Button>
              <Button size="sm" variant="danger">
                Danger
              </Button>
            </ActionGroup>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-sm">
            <ActionGroup>
              <Badge tone="ok">ok</Badge>
              <Badge tone="warn">warn</Badge>
              <Badge tone="err">err</Badge>
              <Badge tone="pend">pend</Badge>
              <Badge tone="accent">accent</Badge>
            </ActionGroup>
            <ViewTabs
              tabs={[
                { id: 'chat', label: 'Chat' },
                { id: 'terminal', label: 'Terminal' },
              ]}
              current={view}
              onChange={setView}
            />
            <Textarea rows={2} defaultValue="A composer draft." />
            <div>
              <Button onClick={() => setSheetOpen(true)}>Open the bottom sheet</Button>
            </div>
          </PanelBody>
        </Card>

        <BottomSheet
          id="harness-sheet"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          ariaLabel="Harness sheet"
          closeLabel="Close the sheet"
        >
          <div className="p-panel text-ui">The shared modal shell, swipe handle and all.</div>
        </BottomSheet>
      </div>
    </div>
  );
}

const host = document.getElementById('root');
if (host) createRoot(host).render(<Shell />);
