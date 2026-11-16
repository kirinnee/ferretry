/**
 * The Pinned group. Ported from today's `sessions-bar-pinned.test.tsx` (above the folders and in pin order, once, a
 * finished one stays dimmed, hidden when nothing is pinned, follows the kind filter). Left out: "above Needs you" and
 * "spans machines" (Agenda's group; the all-machines list is S-0550, open) and "leads the collapsed rail" (Unit 3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { RouterProvider } from '@ferretry/app/testing';
import { deviceControls, type ModeFilter, type ScreenRef } from '@ferretry/app';
import { FerretList } from '../../../../app/features/list/ferret-list.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { listDaemon, summary as ferretSummary } from './support.ts';

const SCREENS: readonly ScreenRef[] = [{ plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' }];
const pinnedAt = (minutes: number): string => new Date(Date.UTC(2026, 10, 2, 10, minutes)).toISOString();

const live = ferretSummary('live-pin', {
  name: 'hadi',
  title: 'Live work',
  folder: '/work/live',
  mode: 'interactive',
  pinnedAt: pinnedAt(5),
});
const finished = ferretSummary('done-pin', {
  name: 'ora',
  title: 'Finished work',
  folder: '/work/done',
  mode: 'interactive',
  state: 'stopped',
  pinnedAt: pinnedAt(1),
});
const plain = ferretSummary('plain', { name: 'ava', title: 'Plain work', folder: '/work/plain', mode: 'interactive' });
const hiddenDone = ferretSummary('hidden-done', {
  name: 'old',
  title: 'Old work',
  folder: '/work/old',
  mode: 'interactive',
  state: 'stopped',
});

let mounted: Mounted | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.pushState(null, '', '/');
});

const draw = async (ferrets: Parameters<typeof listDaemon>[0], mode: ModeFilter = 'all'): Promise<HTMLElement> => {
  deviceControls().setDeviceControls({ sessionsMode: mode });
  window.history.pushState(null, '', '/d/alpha/ferrets');
  mounted = await mount(
    <RouterProvider screens={SCREENS}>
      <FerretList client={listDaemon(ferrets).client} />
    </RouterProvider>,
  );
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
  return mounted.container;
};

const ids = (root: Element): (string | null)[] =>
  [...root.querySelectorAll('[data-sbar-session]')].map(node => node.getAttribute('data-sbar-session'));

describe('the Pinned group in the ferret list', () => {
  it('S-0405 sits above the folders, lists pins oldest first, and shows each ferret only once', async () => {
    const root = await draw([plain, live, finished, hiddenDone]);
    const groups = [...root.querySelectorAll('section.fy-sbar__group')].map(node => node.getAttribute('aria-label'));
    expect(groups).toEqual(['Pinned', 'plain']);
    const pinned = must(root.querySelector('[data-sbar-pinned-group]'), 'the Pinned group');
    expect(ids(pinned)).toEqual(['done-pin', 'live-pin']);
    expect(ids(root).sort()).toEqual(['done-pin', 'live-pin', 'plain']);
  });

  it('S-0405 keeps a finished pinned ferret listed, marked so it reads dimmed', async () => {
    const root = await draw([plain, live, finished, hiddenDone]);
    const row = must(root.querySelector('[data-sbar-session="done-pin"]'), 'the finished row');
    expect(row.hasAttribute('data-sbar-stopped')).toBe(true);
    expect(row.hasAttribute('data-sbar-pinned')).toBe(true);
    expect(root.querySelector('[data-sbar-session="hidden-done"]')).toBeNull();
  });

  it('is hidden when nothing is pinned', async () => {
    const root = await draw([plain]);
    expect(root.querySelector('[data-sbar-pinned-group]')).toBeNull();
  });

  it('follows the kind filter', async () => {
    const root = await draw([plain, live, finished], 'auto');
    expect(root.querySelector('[data-sbar-pinned-group]')).toBeNull();
  });
});
