/**
 * The ferret list's row menu. Ported from today's `sessions-bar-row-menu.test.tsx`, over the real list and the real
 * provider: a right-click opens the menu of THAT ferret at the pointer, the Menu key opens it at the row, a press that
 * follows a touch is a sheet, a held finger shows the hold and then opens the sheet, and closing keeps the host mounted
 * but not open and can hand focus back to the row.
 *
 * Left out, with the reason: "on the all-machines list the menu belongs to the row's own machine" (the all-machines list
 * is not built, GAP(ferret-list-rest)); "a sub-ferret row has the same menu" (the list is flat, the sub-ferret tree is
 * Unit 3); "the drawer draws it too" (5.0's phone has no drawer: the screen is the first bottom-nav item).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type ModeFilter, type ScreenRef, deviceControls } from '@ferretry/app';
import { RouterProvider } from '@ferretry/app/testing';
import type { ReactElement } from 'react';
import { FerretList } from '../../../../app/features/list/ferret-list.tsx';
import { FerretRowMenuProvider } from '../../../../app/features/list/row-actions-host.tsx';
import { LONG_PRESS_MS } from '../../../../app/features/list/row-context-gesture.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';
import { type ListDaemon, listDaemon, summary as ferretSummary } from './support.ts';

const SCREENS: readonly ScreenRef[] = [
  { plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' },
  { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' },
];

const recent = new Date(Date.parse('2026-10-16T12:00:00.000Z') - 60_000).toISOString();
const FERRETS = [
  ferretSummary('lead', {
    name: 'hadi',
    title: 'Lead task',
    folder: '/work/pack',
    mode: 'auto',
    state: 'working',
    stateAt: recent,
  }),
  ferretSummary('kid-1', {
    name: 'maryah',
    title: 'Kid task',
    folder: '/work/pack',
    mode: 'auto',
    state: 'idle',
    stateAt: recent,
  }),
];

let mounted: Mounted | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.pushState(null, '', '/');
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const draw = async (daemon: ListDaemon, withMenu = true): Promise<HTMLElement> => {
  deviceControls().setDeviceControls({ sessionsMode: 'all' as ModeFilter });
  window.history.pushState(null, '', '/d/alpha/ferrets');
  const list: ReactElement = <FerretList client={daemon.client} />;
  mounted = await mount(
    <RouterProvider screens={SCREENS}>
      {withMenu ? <FerretRowMenuProvider client={daemon.client}>{list}</FerretRowMenuProvider> : list}
    </RouterProvider>,
  );
  await settle();
  return mounted.container;
};

const row = (id: string): HTMLElement =>
  must(mounted?.container.querySelector<HTMLElement>(`[data-sbar-session="${id}"]`), `row ${id}`);
const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-ferret-row-menu]');
const host = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[data-action-toast]');

const fire = (target: EventTarget, type: string, fields: Record<string, unknown> = {}): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 0, clientY: 0, button: 2, ...fields });
  target.dispatchEvent(event);
  return event;
};
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** Closes whatever is open: Escape is the one key every presentation takes. */
const dismiss = async (): Promise<void> => {
  await interact(() => pressKey(document, 'Escape'));
  await settle();
};

describe('the ferret list row menu', () => {
  it('S-0074 right-click opens the menu for that ferret at the pointer, and the browser’s own stays away', async () => {
    await draw(listDaemon(FERRETS));
    expect(row('lead').getAttribute('aria-haspopup')).toBe('menu');
    await interact(() => {
      expect(fire(row('lead'), 'contextmenu', { clientX: 140, clientY: 210 }).defaultPrevented).toBe(true);
    });
    const open = must(menu(), 'the menu');
    expect(open.getAttribute('aria-label')).toBe('Hadi actions');
    expect(open.style.left).toBe('140px');
    expect(open.style.top).toBe('210px');
    expect(open.className).not.toContain('fy-actions-menu--sheet');
    expect(open.querySelector('[data-ferret-action-item="open"]')).not.toBeNull();
    expect(open.querySelector('[data-ferret-action-item="stop"]')).not.toBeNull();
  });

  it('another row opens the menu of its own ferret, and only that one’s rows', async () => {
    await draw(listDaemon(FERRETS));
    await interact(() => fire(row('lead'), 'contextmenu', { clientX: 5, clientY: 6 }));
    expect(menu()?.getAttribute('aria-label')).toBe('Hadi actions');
    await dismiss();
    expect(menu()).toBeNull();
    await interact(() => fire(row('kid-1'), 'contextmenu', { clientX: 7, clientY: 8 }));
    expect(menu()?.getAttribute('aria-label')).toBe('Maryah actions');
    expect(document.body.querySelectorAll('[data-ferret-row-menu]')).toHaveLength(1);
  });

  it('rows have no menu, and the browser’s own is left alone, when the host draws none', async () => {
    await draw(listDaemon(FERRETS), false);
    expect(row('lead').hasAttribute('aria-haspopup')).toBe(false);
    expect(mounted?.container.querySelector('[data-sbar-more]')).toBeNull();
    expect(fire(row('lead'), 'contextmenu').defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it('the Menu key and Shift+F10 open it at the row, as a desktop menu', async () => {
    await draw(listDaemon(FERRETS));
    await interact(() => {
      fire(document.body, 'keydown', { key: 'a' });
      fire(row('lead'), 'keydown', { key: 'ContextMenu', shiftKey: false });
    });
    expect(menu()?.className).not.toContain('fy-actions-menu--sheet');
    expect(menu()?.getAttribute('aria-label')).toBe('Hadi actions');
    await dismiss();
    await interact(() => fire(row('kid-1'), 'keydown', { key: 'F10', shiftKey: true }));
    expect(menu()?.getAttribute('aria-label')).toBe('Maryah actions');
  });

  it('a press that follows a touch is a sheet; one that follows a mouse, or a pen’s lift to a mouse, is not', async () => {
    await draw(listDaemon(FERRETS));
    const isSheet = (): boolean => menu()?.className.includes('fy-actions-menu--sheet') === true;
    await interact(() => {
      fire(document.body, 'pointerdown', { pointerType: 'touch' });
      fire(row('lead'), 'contextmenu');
    });
    expect(isSheet()).toBe(true);
    await dismiss();
    await interact(() => {
      fire(document.body, 'pointerdown', { pointerType: 'pen' });
      fire(row('lead'), 'contextmenu');
    });
    expect(isSheet()).toBe(true);
    await dismiss();
    await interact(() => {
      fire(document.body, 'pointerdown', { pointerType: 'mouse' });
      fire(row('lead'), 'contextmenu');
    });
    expect(menu() === null || isSheet()).toBe(false);
  });

  it('a keyboard open after a touch is still a desktop menu', async () => {
    await draw(listDaemon(FERRETS));
    await interact(() => {
      fire(document.body, 'pointerdown', { pointerType: 'touch' });
      fire(row('lead'), 'keydown', { key: 'ContextMenu', shiftKey: false });
    });
    expect(menu()?.className).not.toContain('fy-actions-menu--sheet');
  });

  it('S-0074 a held finger shows the hold on the row, then opens the sheet where it is', async () => {
    await draw(listDaemon(FERRETS));
    await interact(() => fire(row('lead'), 'pointerdown', { pointerType: 'touch', clientX: 20, clientY: 30 }));
    expect(row('lead').hasAttribute('data-sbar-pressing')).toBe(true);
    await interact(() => sleep(LONG_PRESS_MS + 60));
    expect(row('lead').hasAttribute('data-sbar-pressing')).toBe(false);
    const open = must(menu(), 'the sheet');
    expect(open.className).toContain('fy-actions-menu--sheet');
    expect(open.getAttribute('aria-label')).toBe('Hadi actions');
  });

  it('the ⋯ button opens the same menu for its own row, and is there to press without a right-click', async () => {
    await draw(listDaemon(FERRETS));
    const more = must(
      mounted?.container.querySelector<HTMLButtonElement>('[data-sbar-more][aria-label="Actions for Kid task"]'),
      'the ⋯ button',
    );
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    await interact(() => more.click());
    expect(menu()?.getAttribute('aria-label')).toBe('Maryah actions');
  });

  it('closing keeps the host mounted but not open, and can hand focus back to the row', async () => {
    await draw(listDaemon(FERRETS));
    await interact(() => fire(row('lead'), 'contextmenu'));
    expect(host()).not.toBeNull();
    await dismiss();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(row('lead'));
    // The host is still mounted: a contributor's dialog and the toast live in it.
    expect(host()).not.toBeNull();

    await interact(() => fire(row('kid-1'), 'contextmenu'));
    (document.activeElement as HTMLElement | null)?.blur();
    await interact(() => fire(document.body, 'pointerdown'));
    expect(menu()).toBeNull();
    expect(document.activeElement).not.toBe(row('kid-1'));
    expect(host()).not.toBeNull();
  });

  it('a row that left the page cannot take focus back', async () => {
    const daemon = listDaemon(FERRETS);
    await draw(daemon);
    await interact(() => fire(row('lead'), 'contextmenu'));
    const gone = row('lead');
    daemon.ferrets = FERRETS.filter(ferret => ferret.id !== 'lead');
    await interact(() => daemon.announce('lead', true));
    await settle();
    expect(gone.isConnected).toBe(false);
    await dismiss();
    expect(menu()).toBeNull();
    expect(document.activeElement).not.toBe(gone);
  });
});
