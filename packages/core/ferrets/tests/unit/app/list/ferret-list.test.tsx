/**
 * The ferret list component. Ported from today's `sessions-bar.test.tsx` (lists by project and marks the open one,
 * titles, hides stopped until ticked, keeps the open one, narrows by kind with live counts, opens on Interactive, still
 * reading / nothing running, navigates from a row), over the scripted daemon. Left out: the badge, preview, switch
 * marks, machine switcher, finder and foot places (not Ferrets'), and the ⋯ options menu (Show stopped is a tick here).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { RouterProvider } from '@ferretry/app/testing';
import { deviceControls, type ModeFilter, type ScreenRef } from '@ferretry/app';
import { FerretList } from '../../../../app/features/list/ferret-list.tsx';
import type { FerretSummary } from '../../../../contract/index.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { type ListDaemon, listDaemon, summary as ferretSummary } from './support.ts';

const SCREENS: readonly ScreenRef[] = [
  { plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' },
  { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' },
];

const recent = new Date(Date.parse('2026-10-16T12:00:00.000Z') - 60_000).toISOString();
const FERRETS: readonly FerretSummary[] = [
  ferretSummary('hadi-1', {
    name: 'hadi',
    title: 'Fix the stuck sign-in',
    folder: '/work/ferretry',
    mode: 'auto',
    state: 'working',
    stateAt: recent,
  }),
  ferretSummary('maryah-1', {
    name: 'maryah',
    title: 'Diene work',
    folder: '/work/home-manager',
    mode: 'auto',
    state: 'idle',
    stateAt: recent,
  }),
  ferretSummary('nameless', {
    name: 'nem',
    title: undefined,
    folder: '/work/home-manager',
    mode: 'auto',
    state: 'idle',
    stateAt: recent,
  }),
];

let mounted: Mounted | undefined;
beforeEach(() => {
  // The kind a device remembers is part of the app's controls, which live in the browser's own storage.
  localStorage.clear();
});
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

/** `mode` is what the device remembers: All unless a test says otherwise; `null` is a new device; 'keep' leaves it. */
const draw = async (
  daemon: ListDaemon,
  path = '/d/alpha/ferrets/hadi-1/chat',
  mode: ModeFilter | null | 'keep' = 'all',
): Promise<HTMLElement> => {
  if (mode !== 'keep') deviceControls().setDeviceControls({ sessionsMode: mode });
  window.history.pushState(null, '', path);
  mounted = await mount(
    <RouterProvider screens={SCREENS}>
      <FerretList client={daemon.client} />
    </RouterProvider>,
  );
  await settle();
  return mounted.container;
};

const click = async (element: Element | null, what: string): Promise<void> => {
  await interact(() => (must(element, what) as HTMLElement).click());
  await settle();
};

const ids = (root: ParentNode): (string | null)[] =>
  [...root.querySelectorAll('[data-sbar-session]')].map(node => node.getAttribute('data-sbar-session'));

describe('the ferret list as a column', () => {
  it('S-0405 lists ferrets by folder and marks the open one', async () => {
    const root = await draw(listDaemon(FERRETS));
    const folders = [...root.querySelectorAll('.fy-sbar__project')].map(node => node.textContent?.replace(/\d+$/u, ''));
    expect(folders).toEqual(['home-manager', 'ferretry']);
    const open = must(root.querySelector('[data-sbar-session="hadi-1"]'), 'the open ferret');
    expect(open.getAttribute('aria-current')).toBe('page');
    expect(root.querySelector('[data-sbar-session="maryah-1"]')?.getAttribute('aria-current')).toBeNull();
    // The title is the task; the ferret doing it is the small second line, with its initial.
    expect(open.querySelector('.fy-sbar__name')?.textContent).toBe('Fix the stuck sign-in');
    expect(open.querySelector('[data-sbar-ferret] .fy-sbar__ferret-name')?.textContent).toBe('Hadi');
    expect(open.querySelector('[data-sbar-ferret] .fy-sbar__initial')?.textContent).toBe('H');
    expect(open.querySelector('[data-sbar-dir]')?.textContent).toBe('/work/ferretry');
    // A ferret with no task of its own is titled by its folder, the ferret second.
    const nameless = must(root.querySelector('[data-sbar-session="nameless"]'), 'the task-less ferret');
    expect(nameless.querySelector('.fy-sbar__name')?.textContent).toBe('home-manager');
    expect(nameless.querySelector('[data-sbar-ferret] .fy-sbar__ferret-name')?.textContent).toBe('Nem');
    expect(nameless.querySelector('[data-sbar-dir]')?.textContent).toBe('/work/home-manager');
  });

  it('S-0405 titles a row by its task, else its folder, with the ferret second', async () => {
    const taskless = ferretSummary('taskless-1', {
      name: 'pim',
      title: undefined,
      folder: '/work/ferretry',
      mode: 'auto',
    });
    const root = await draw(listDaemon([...FERRETS, taskless]));
    const row = (id: string) => must(root.querySelector(`[data-sbar-session="${id}"]`), id);
    expect(row('maryah-1').querySelector('.fy-sbar__name')?.textContent).toBe('Diene work');
    expect(row('maryah-1').querySelector('.fy-sbar__ferret-name')?.textContent).toBe('Maryah');
    expect(row('taskless-1').querySelector('.fy-sbar__name')?.textContent).toBe('ferretry');
    expect(row('taskless-1').querySelector('.fy-sbar__ferret-name')?.textContent).toBe('Pim');
    expect(row('maryah-1').getAttribute('title')).toContain('Diene work — Maryah');
  });

  it('S-0405 hides stopped ferrets until "Show stopped" is ticked, and says how many it is hiding', async () => {
    const stopped = ferretSummary('old-1', {
      name: 'ora',
      title: 'Finished work',
      folder: '/work/ferretry',
      state: 'stopped',
      mode: 'auto',
    });
    const root = await draw(listDaemon([...FERRETS, stopped]));
    expect(ids(root)).not.toContain('old-1');
    const tick = must(root.querySelector<HTMLInputElement>('[data-sbar-show-stopped] input'), 'the tick');
    expect(root.querySelector('[data-sbar-show-stopped]')?.textContent).toBe('Show stopped(1)');
    expect(root.querySelector('[data-sbar-filter="all"] .fy-sbar__count')?.textContent).toBe('3');

    await click(tick, 'Show stopped');
    expect(ids(root)).toContain('old-1');
    expect(root.querySelector('[data-sbar-show-stopped]')?.textContent).toBe('Show stopped');
    expect(root.querySelector('[data-sbar-filter="all"] .fy-sbar__count')?.textContent).toBe('4');
    expect(root.querySelector('[data-sbar-session="old-1"]')?.hasAttribute('data-sbar-stopped')).toBe(true);

    await click(tick, 'Show stopped');
    expect(ids(root)).not.toContain('old-1');
  });

  it('S-0405 keeps the open ferret listed even when it has stopped', async () => {
    const stopped = ferretSummary('hadi-1', {
      name: 'hadi',
      title: 'Done',
      folder: '/work/ferretry',
      state: 'stopped',
      mode: 'auto',
    });
    const root = await draw(listDaemon([stopped]));
    expect(root.querySelector('[data-sbar-session="hadi-1"]')).not.toBeNull();
    await mounted?.unmount();
    const away = await draw(listDaemon([stopped]), '/d/alpha/ferrets');
    expect(away.querySelector('[data-sbar-session="hadi-1"]')).toBeNull();
    expect(away.querySelector('.fy-sbar__empty')?.textContent).toBe('No live ferrets — 1 stopped. Tick Show stopped.');
  });

  it('S-0405 narrows by kind with live counts, and says plainly when a kind has nothing', async () => {
    const person = ferretSummary('pat-1', {
      name: 'pat',
      title: 'Pairing',
      mode: 'interactive',
      folder: '/work/ferretry',
    });
    const daemon = listDaemon([FERRETS[0] as FerretSummary, person]);
    const root = await draw(daemon, undefined, null);
    const segment = (id: string) => root.querySelector<HTMLButtonElement>(`[data-sbar-filter="${id}"]`);
    const words = () => ['all', 'auto', 'interactive'].map(id => segment(id)?.textContent);
    // A new device opens on Interactive.
    expect(segment('interactive')?.getAttribute('aria-pressed')).toBe('true');
    expect(ids(root)).toEqual(['pat-1']);

    await click(segment('all'), 'All');
    expect(ids(root).sort()).toEqual(['hadi-1', 'pat-1']);
    expect(words()).toEqual(['All2', 'Agents1', 'Interactive1']);
    await click(segment('auto'), 'Agents');
    expect(ids(root)).toEqual(['hadi-1']);
    // The numbers are what each segment would show, so choosing one leaves the others' alone.
    expect(words()).toEqual(['All2', 'Agents1', 'Interactive1']);

    await mounted?.unmount();
    const lonely = await draw(listDaemon([FERRETS[0] as FerretSummary]), undefined, null);
    expect(lonely.textContent).toContain('No interactive ferrets.');
    expect(lonely.querySelector('[data-ferret-new]')).toBeNull();
  });

  it('S-0405 opens on Interactive until the device remembers another kind', async () => {
    const person = ferretSummary('pat-1', {
      name: 'pat',
      title: 'Pairing',
      mode: 'interactive',
      folder: '/work/ferretry',
    });
    const daemon = listDaemon([FERRETS[0] as FerretSummary, person]);
    const root = await draw(daemon, undefined, null);
    const pressed = () =>
      [...root.querySelectorAll<HTMLButtonElement>('[data-sbar-filter]')].map(node => [
        node.getAttribute('data-sbar-filter'),
        node.getAttribute('aria-pressed'),
      ]);
    expect(pressed()).toEqual([
      ['interactive', 'true'],
      ['all', 'false'],
      ['auto', 'false'],
    ]);
    await click(root.querySelector('[data-sbar-filter="auto"]'), 'Agents');
    await mounted?.unmount();
    // A new list on the same device opens on the kind it remembered.
    const again = await draw(daemon, undefined, 'keep');
    expect(again.querySelector('[data-sbar-filter="auto"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(ids(again)).toEqual(['hadi-1']);
  });

  it('S-0405 says it is still reading, and says plainly when nothing is running, with a way to start one', async () => {
    const daemon = listDaemon([]);
    let release = (): void => undefined;
    daemon.hold = new Promise<void>(resolve => (release = resolve));
    window.history.pushState(null, '', '/d/alpha/ferrets');
    mounted = await mount(
      <RouterProvider screens={SCREENS}>
        <FerretList client={daemon.client} />
      </RouterProvider>,
    );
    expect(mounted.container.querySelector('[role="status"]')?.textContent).toBe('Reading ferrets…');
    release();
    await settle();
    await click(mounted.container.querySelector('[data-sbar-filter="all"]'), 'All');
    expect(mounted.container.textContent).toContain('No ferrets are running.');
    expect(mounted.container.querySelector('[data-ferret-new]')?.getAttribute('href')).toBe('/d/alpha/new');
    expect(mounted.container.querySelector('[data-ferret-new]')?.textContent).toBe('+ New ferret');
  });

  it('says the read failed, with a Retry that reads again, and says when the rows may be stale', async () => {
    const daemon = listDaemon([FERRETS[0] as FerretSummary]);
    daemon.failWith = new Error('the daemon is unreachable');
    const root = await draw(daemon);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('the daemon is unreachable');
    daemon.failWith = undefined;
    await click(root.querySelector('[role="alert"] button'), 'Retry');
    await click(root.querySelector('[data-sbar-filter="all"]'), 'All');
    expect(ids(root)).toEqual(['hadi-1']);
    daemon.failWith = new Error('gone again');
    await interact(() => daemon.announce('hadi-1'));
    await settle();
    expect(ids(root)).toEqual(['hadi-1']);
    expect(root.querySelector('[data-sbar-stale]')?.textContent).toContain('may be out of date');
  });

  it('S-0405 navigates from a row to the ferret’s chat', async () => {
    const root = await draw(listDaemon(FERRETS), '/d/alpha/ferrets');
    await click(root.querySelector('[data-sbar-filter="all"]'), 'All');
    const row = must(root.querySelector<HTMLAnchorElement>('[data-sbar-session="maryah-1"]'), 'a ferret row');
    expect(row.getAttribute('href')).toBe('/d/alpha/ferrets/maryah-1/chat');
    await click(row, 'a ferret row');
    expect(window.location.pathname).toBe('/d/alpha/ferrets/maryah-1/chat');
    expect(root.querySelector('[data-sbar-session="maryah-1"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('draws nothing where the route names no machine', async () => {
    const root = await draw(listDaemon(FERRETS), '/settings');
    expect(root.querySelector('[data-ferret-list]')).toBeNull();
    expect(root.textContent).toBe('');
  });

  it('navigating to another ferret does not read the list again', async () => {
    const daemon = listDaemon(FERRETS);
    const root = await draw(daemon);
    expect(daemon.reads).toBe(1);
    await click(root.querySelector('[data-sbar-filter="all"]'), 'All');
    await click(root.querySelector('[data-sbar-session="maryah-1"]'), 'a ferret row');
    await click(root.querySelector('[data-sbar-session="nameless"]'), 'a ferret row');
    expect(root.querySelector('[data-sbar-session="nameless"]')?.getAttribute('aria-current')).toBe('page');
    expect(daemon.reads).toBe(1);
  });
});
