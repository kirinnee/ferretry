import { beforeEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { SidePanePreferenceStore } from '../../src/lib/side-pane-preferences.ts';
import {
  SidePaneShell,
  type SidePaneSurfaceProps,
  SidePaneWorkspace,
  useSidePane,
} from '../../src/shell/side-pane.tsx';
import {
  openSidePaneBrowserTab,
  openSidePaneTab,
  readSidePaneTabsState,
  resetSidePaneTabsStates,
} from '../../src/shell/side-pane-tab-model.ts';
import { interact, mount, pressKey } from '../support/dom.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'a-token' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b-token' });
const scopeA = daemonSessionScope(daemonA, 'same-session');
const scopeB = daemonSessionScope(daemonB, 'same-session');

const surface = ({ scope, tab, titleId, onClose, isActive }: SidePaneSurfaceProps) => (
  <section aria-label={`${scope.daemonId} ${tab.label}`} data-tab={tab.id}>
    <h2 id={titleId}>{tab.label}</h2>
    <span data-active={isActive}>daemon: {scope.daemonId}</span>
    <button type="button" onClick={onClose}>
      Close surface
    </button>
  </section>
);

const workspace = (
  scope = scopeA,
  presentation: 'pane' | 'sheet' = 'pane',
  preferences = new SidePanePreferenceStore(),
  actions?: ReactNode,
) => (
  <SidePaneWorkspace scope={scope} presentation={presentation} preferences={preferences} renderSurface={surface}>
    <main>
      Conversation remains available
      {actions}
    </main>
  </SidePaneWorkspace>
);

function PaneActions() {
  const pane = useSidePane();
  if (!pane) return null;
  return (
    <div>
      <button type="button" onClick={event => pane.open('files', event.currentTarget)}>
        Open files
      </button>
      <button type="button" onClick={() => pane.openNewInstance('browser')}>
        New browser
      </button>
      <button type="button" onClick={() => pane.openNewInstance('file')}>
        New file
      </button>
      <button type="button" onClick={() => pane.openNewInstance('terminal')}>
        New terminal
      </button>
    </div>
  );
}

beforeEach(() => resetSidePaneTabsStates());

describe('SidePaneShell', () => {
  it('is a complementary desktop pane and lets Escape close only from inside it', async () => {
    let closes = 0;
    const view = await mount(
      <SidePaneShell id="pane" titleId="pane-title" onClose={() => (closes += 1)}>
        <h2 id="pane-title">Files</h2>
      </SidePaneShell>,
    );
    const pane = view.container.querySelector('aside') as HTMLElement;

    expect(pane.getAttribute('aria-labelledby')).toBe('pane-title');
    await interact(() => pressKey(pane, 'Escape'));
    expect(closes).toBe(1);
    await view.unmount();
  });
});

describe('SidePaneWorkspace', () => {
  it('renders a resizable desktop pane without making the conversation modal', async () => {
    openSidePaneTab(scopeA, 'files');
    const view = await mount(workspace());

    expect(view.container.querySelector('aside')).not.toBeNull();
    expect(view.container.querySelector('[role="separator"]')?.getAttribute('aria-label')).toBe(
      'Resize session side pane',
    );
    expect(view.container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="daemon-a Files"]')?.textContent).toContain('daemon-a');
    expect(view.container.querySelector('main')?.textContent).toContain('Conversation remains available');
    await view.unmount();
  });

  it('keeps matching session ids isolated by daemon in the live shell', async () => {
    openSidePaneTab(scopeA, 'files');
    const view = await mount(
      <>
        {workspace(scopeA)}
        {workspace(scopeB)}
      </>,
    );

    expect(view.container.querySelectorAll('aside')).toHaveLength(1);
    expect(view.container.querySelector('[aria-label="daemon-b Files"]')).toBeNull();
    await view.unmount();
  });

  it('uses the bottom-sheet tab switcher on a phone, never a desktop tab strip', async () => {
    openSidePaneTab(scopeA, 'files');
    const view = await mount(workspace(scopeA, 'sheet'));

    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="Switch tab — Files is showing"]')).not.toBeNull();
    await view.unmount();
  });

  it('closes through the rendered surface and restores the conversation-only layout', async () => {
    const frame = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => {
      callback(0);
      return 0;
    };
    const view = await mount(workspace(scopeA, 'pane', new SidePanePreferenceStore(), <PaneActions />));

    const opener = view.container.querySelector('main button') as HTMLButtonElement;
    await interact(() => opener.click());
    await interact(() =>
      (view.container.querySelector('[aria-label="daemon-a Files"] button') as HTMLButtonElement).click(),
    );
    expect(view.container.querySelector('aside')).toBeNull();
    expect(view.container.querySelector('main')?.textContent).toContain('Conversation remains available');
    expect(document.activeElement).toBe(opener);
    window.requestAnimationFrame = frame;
    await view.unmount();
  });

  it('routes each new-instance action through its owning surface and persists keyboard width commits', async () => {
    const preferences = new SidePanePreferenceStore();
    const view = await mount(workspace(scopeA, 'pane', preferences, <PaneActions />));
    const actions = [...view.container.querySelectorAll('main button')] as HTMLButtonElement[];

    await interact(() => actions[1]?.click());
    await interact(() => actions[2]?.click());
    await interact(() => actions[3]?.click());
    const open = readSidePaneTabsState(scopeA).open;
    expect(open.some(tab => tab.startsWith('browser:'))).toBe(true);
    expect(open).toContain('files');
    expect(open).toContain('terminals');

    const resize = view.container.querySelector('[role="separator"]') as HTMLElement;
    await interact(() => pressKey(resize, 'ArrowLeft'));
    // happy-dom has no layout width, so the resize handle commits its honest
    // minimum bound rather than a synthetic desktop geometry.
    expect(preferences.snapshot().width).toBe(320);
    await view.unmount();
  });

  it('retains a browser instance on desktop while a different tab is active', async () => {
    openSidePaneBrowserTab(scopeA, null, { forceNew: true });
    const view = await mount(workspace());

    await interact(() => openSidePaneTab(scopeA, 'files'));
    expect(view.container.querySelector('[data-tab^="browser:"] [data-active="false"]')).not.toBeNull();
    expect(view.container.querySelector('[data-tab="files"] [data-active="true"]')).not.toBeNull();
    await view.unmount();
  });
});
