import { afterEach, describe, expect, test } from 'bun:test';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const DAEMON = 'alpha' as DaemonId;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const menu of document.querySelectorAll('[role="menu"]')) menu.remove();
});

const bar = (updates: { readonly alpha?: boolean; readonly beta?: boolean }) => (
  <SessionsBar
    active={null}
    activeSessionId={null}
    daemonId={DAEMON}
    machineName="work-mac"
    machines={[
      {
        daemonId: DAEMON,
        name: 'work-mac',
        ...(updates.alpha === undefined ? {} : { updateAvailable: updates.alpha }),
      },
      {
        daemonId: 'beta' as DaemonId,
        name: 'kirin-box',
        ...(updates.beta === undefined ? {} : { updateAvailable: updates.beta }),
      },
    ]}
    onAddMachine={() => undefined}
    onNavigate={() => undefined}
    onOpenPalette={() => undefined}
    presentation="column"
    projects={[]}
    sessions={[]}
  />
);

const openMenu = async (container: HTMLElement): Promise<readonly HTMLElement[]> => {
  const trigger = must(container.querySelector<HTMLButtonElement>('[data-sbar-machine]'), 'the machine switcher');
  await interact(() => trigger.click());
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
};

describe('the machine menu’s update dot', () => {
  test('marks the switcher and the machine with an update, in words as well as a dot', async () => {
    view = await mount(bar({ beta: true }));
    const trigger = must(view.container.querySelector('[data-sbar-machine]'), 'the switcher');
    expect(trigger.getAttribute('aria-label')).toBe('Machine: work-mac. Switch machine. An update is available');
    expect(trigger.querySelector('[data-sbar-machine-update]')).not.toBeNull();
    const items = await openMenu(view.container);
    expect(items.map(item => item.textContent)).toEqual([
      'work-macthis one',
      'kirin-boxupdate available',
      'Add a machine…',
    ]);
    expect(items[1]?.querySelector('[data-machine-menu-update]')).not.toBeNull();
    expect(items[0]?.querySelector('[data-machine-menu-update]')).toBeNull();
  });

  test('joins "this one" and "update available" for the machine on screen', async () => {
    view = await mount(bar({ alpha: true, beta: false }));
    const items = await openMenu(view.container);
    expect(items[0]?.textContent).toBe('work-macthis one · update available');
    expect(items[1]?.textContent).toBe('kirin-box');
  });

  test('shows nothing when no machine has an update', async () => {
    view = await mount(bar({}));
    const trigger = must(view.container.querySelector('[data-sbar-machine]'), 'the switcher');
    expect(trigger.getAttribute('aria-label')).toBe('Machine: work-mac. Switch machine');
    expect(trigger.querySelector('[data-sbar-machine-update]')).toBeNull();
  });
});
