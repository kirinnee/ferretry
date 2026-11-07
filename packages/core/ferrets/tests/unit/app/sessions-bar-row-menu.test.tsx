import { afterEach, describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import type { MachineSource } from '../../src/lib/all-machines.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { LONG_PRESS_MS } from '../../src/shell/agent-sidebar-model.ts';
import type { SessionMenuState } from '../../src/shell/session-menu-context.ts';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const DAEMON = 'alpha' as DaemonId;
const BETA = 'beta' as DaemonId;
const recent = '2026-10-16T11:59:00.000Z';

const LEAD = sessionView('lead', {
  config: { teammate: 'hadi', label: 'Lead', cwd: '/work/pack' },
  state: { lastActivityAt: recent },
});
const KID = sessionView('kid-1', {
  config: { teammate: undefined as never, label: 'One', cwd: '/work/pack', parent: 'lead' },
  state: { lastActivityAt: recent },
});
const SESSIONS = [LEAD, KID];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

type BarProps = ComponentProps<typeof SessionsBar>;

interface Seen {
  readonly menus: SessionMenuState[];
  readonly closes: boolean[];
  close?: (restoreFocus: boolean) => void;
}

const mountBar = async (props: Partial<BarProps> = {}, withMenu = true): Promise<Seen> => {
  const seen: Seen = { menus: [], closes: [] };
  view = await mount(
    <SessionsBar
      active={null}
      activeSessionId={null}
      daemonId={DAEMON}
      initialMode="all"
      machineName="work-mac"
      machines={[{ daemonId: DAEMON, name: 'work-mac' }]}
      onAddMachine={() => undefined}
      onCollapse={() => undefined}
      onNavigate={() => undefined}
      onOpenPalette={() => undefined}
      presentation="column"
      projects={[]}
      sessions={SESSIONS}
      {...(withMenu
        ? {
            renderSessionMenu: (menu: SessionMenuState, close: (restoreFocus: boolean) => void) => {
              seen.menus.push(menu);
              seen.close = close;
              return <div data-row-menu={`${menu.daemonId}:${menu.view.config.id}:${menu.open}`} />;
            },
          }
        : {})}
      {...props}
    />,
  );
  return seen;
};

const row = (id: string): HTMLElement =>
  must(view?.container.querySelector<HTMLElement>(`[data-sbar-session="${id}"]`), `row ${id}`);

const fire = (target: EventTarget, type: string, fields: Record<string, unknown> = {}): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 0, clientY: 0, button: 2, ...fields });
  target.dispatchEvent(event);
  return event;
};
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('the sessions bar row menu', () => {
  test('right-click opens the menu for that ferret at the pointer, and the browser’s own stays away', async () => {
    const seen = await mountBar();
    expect(row('lead').getAttribute('aria-haspopup')).toBe('menu');
    await interact(() => {
      expect(fire(row('lead'), 'contextmenu', { clientX: 140, clientY: 210 }).defaultPrevented).toBe(true);
    });
    expect(seen.menus.at(-1)).toMatchObject({ daemonId: DAEMON, x: 140, y: 210, touch: false, open: true });
    expect(seen.menus.at(-1)?.view.config.id).toBe('lead');
    expect(view?.container.querySelector('[data-row-menu="alpha:lead:true"]')).not.toBeNull();
  });

  test('a sub-ferret row has the same menu', async () => {
    const seen = await mountBar();
    await interact(() => fire(row('kid-1'), 'contextmenu', { clientX: 5, clientY: 6 }));
    expect(seen.menus.at(-1)?.view.config.id).toBe('kid-1');
  });

  test('rows have no menu, and the browser’s own is left alone, when the host draws none', async () => {
    await mountBar({}, false);
    expect(row('lead').hasAttribute('aria-haspopup')).toBe(false);
    expect(fire(row('lead'), 'contextmenu').defaultPrevented).toBe(false);
  });

  test('on the all-machines list the menu belongs to the row’s own machine', async () => {
    const source = (daemonId: DaemonId, name: string, sessions: MachineSource['slice']['sessions']): MachineSource => ({
      daemonId,
      name,
      reach: 'online',
      projects: [],
      slice: { sessions, byId: new Map(), status: 'ready', error: null },
    });
    const seen = await mountBar({
      machineSources: [source(DAEMON, 'work-mac', [LEAD]), source(BETA, 'kirin-box', [KID])],
      machines: [
        { daemonId: DAEMON, name: 'work-mac' },
        { daemonId: BETA, name: 'kirin-box' },
      ],
      now: Date.parse(recent),
    });
    await interact(() => fire(row('kid-1'), 'contextmenu'));
    expect(seen.menus.at(-1)).toMatchObject({ daemonId: BETA });
    expect(seen.menus.at(-1)?.view.config.id).toBe('kid-1');
  });

  test('the Menu key opens it at the row, as a desktop menu', async () => {
    const seen = await mountBar();
    await interact(() => {
      fire(document.body, 'keydown', { key: 'a' });
      fire(row('lead'), 'keydown', { key: 'ContextMenu', shiftKey: false });
    });
    expect(seen.menus.at(-1)).toMatchObject({ touch: false, open: true });
  });

  test('a press that follows a touch is a sheet; one that follows a mouse, or a pen’s lift to a mouse, is not', async () => {
    const seen = await mountBar();
    await interact(() => {
      fire(document.body, 'pointerdown', { pointerType: 'touch' });
      fire(row('lead'), 'contextmenu');
    });
    expect(seen.menus.at(-1)?.touch).toBe(true);
    await interact(() => {
      fire(document.body, 'pointerdown', { pointerType: 'pen' });
      fire(row('lead'), 'contextmenu');
    });
    expect(seen.menus.at(-1)?.touch).toBe(true);
    await interact(() => {
      fire(document.body, 'pointerdown', { pointerType: 'mouse' });
      fire(row('lead'), 'contextmenu');
    });
    expect(seen.menus.at(-1)?.touch).toBe(false);
  });

  test('a held finger shows the hold on the row, then opens the sheet', async () => {
    const seen = await mountBar();
    await interact(() => fire(row('lead'), 'pointerdown', { pointerType: 'touch', clientX: 20, clientY: 30 }));
    expect(row('lead').hasAttribute('data-sbar-pressing')).toBe(true);
    await interact(() => sleep(LONG_PRESS_MS + 60));
    expect(row('lead').hasAttribute('data-sbar-pressing')).toBe(false);
    expect(seen.menus.at(-1)).toMatchObject({ touch: true, open: true, x: 20, y: 30 });
  });

  test('closing keeps the host mounted but not open, and can hand focus back to the row', async () => {
    const seen = await mountBar();
    await interact(() => fire(row('lead'), 'contextmenu'));
    await interact(() => seen.close?.(true));
    expect(document.activeElement).toBe(row('lead'));
    expect(seen.menus.at(-1)?.open).toBe(false);
    expect(view?.container.querySelector('[data-row-menu="alpha:lead:false"]')).not.toBeNull();

    await interact(() => fire(row('kid-1'), 'contextmenu'));
    (document.activeElement as HTMLElement | null)?.blur();
    await interact(() => seen.close?.(false));
    expect(document.activeElement).not.toBe(row('kid-1'));
  });

  test('a row that left the page cannot take focus back', async () => {
    const seen = await mountBar();
    await interact(() => fire(row('lead'), 'contextmenu'));
    const trigger = row('lead');
    await view?.render(<div />);
    await interact(() => seen.close?.(true));
    expect(trigger.isConnected).toBe(false);
  });

  test('the drawer draws it too, outside the drawer’s own dialog', async () => {
    const seen = await mountBar({ presentation: 'drawer', onClose: () => undefined });
    await interact(() => fire(row('lead'), 'contextmenu'));
    expect(seen.menus).not.toHaveLength(0);
    const menu = must(view?.container.querySelector('[data-row-menu]'), 'menu');
    expect(menu.closest('[data-sessions-bar="drawer"]')).toBeNull();
  });
});
