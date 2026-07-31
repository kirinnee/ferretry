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
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';

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
    <div className="flex min-h-dvh flex-col gap-panel p-panel">
      <header className="flex items-center gap-sm">
        <Label>Ferretry shell harness</Label>
        <Badge tone="ok">{phone ? 'phone' : 'desktop'}</Badge>
        <span className="text-2xs text-muted">
          {viewport.width}×{viewport.height}
        </span>
      </header>

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
  );
}

const host = document.getElementById('root');
if (host) createRoot(host).render(<Shell />);
