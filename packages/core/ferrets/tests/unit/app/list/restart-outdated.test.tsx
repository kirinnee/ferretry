/**
 * S-0320 "Restart outdated (N)" in the ferret list (v4 `features/restart-outdated`): the outdated mark on a row, the press in
 * the list's ⋯ menu with a count badge, and the answer line under the list head — over a scripted daemon.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { RouterProvider } from '@ferretry/app/testing';
import { deviceControls, type ScreenRef } from '@ferretry/app';
import { FerretList } from '../../../../app/features/list/ferret-list.tsx';
import { RestartOverlayProvider } from '../../../../app/features/restart-outdated/restart-overlay.tsx';
import type { FerretSummary, RestartResult } from '../../../../contract/index.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { listDaemon, summary } from './support.ts';

const SCREENS: readonly ScreenRef[] = [
  { plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' },
  { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' },
];

const FERRETS: readonly FerretSummary[] = [
  summary('busy-1', {
    name: 'hadi',
    title: 'Busy one',
    mode: 'auto',
    state: 'working',
    outdated: { sections: ['pack', 'agenda'] },
  }),
  summary('idle-1', {
    name: 'maryah',
    title: 'Idle one',
    mode: 'auto',
    state: 'idle',
    outdated: { sections: ['tools'] },
  }),
  summary('fresh-1', { name: 'nem', title: 'Current one', mode: 'auto', state: 'idle' }),
  summary('over-1', {
    name: 'old',
    title: 'Over one',
    mode: 'auto',
    state: 'stopped',
    outdated: { sections: ['tools'] },
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

const click = async (element: Element | null, what: string): Promise<void> => {
  await interact(() => (must(element, what) as HTMLElement).click());
  await settle();
};

interface Posted {
  readonly body: unknown;
}

const draw = async (
  restart: (() => Promise<RestartResult> | RestartResult) | undefined,
  posted: Posted[] = [],
): Promise<HTMLElement> => {
  deviceControls().setDeviceControls({ sessionsMode: 'all' });
  window.history.pushState(null, '', '/d/alpha/ferrets');
  const daemon = listDaemon(FERRETS);
  const base = daemon.client.call;
  (daemon.client as { call: unknown }).call = async (route: string, init?: { body?: unknown }) => {
    if (route === 'POST /v1/restarts') {
      posted.push({ body: init?.body });
      if (restart === undefined) throw new Error('no route');
      return restart();
    }
    return (base as (route: string) => Promise<unknown>)(route);
  };
  mounted = await mount(
    <RouterProvider screens={SCREENS}>
      <RestartOverlayProvider>
        <FerretList client={daemon.client} />
      </RestartOverlayProvider>
    </RouterProvider>,
  );
  await settle();
  return mounted.container;
};

const options = (root: ParentNode): HTMLElement | null => root.querySelector<HTMLElement>('[data-sbar-options]');
const menuItem = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-context-menu] [role="menuitem"]');
const mark = (root: ParentNode, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-sbar-session="${id}"] .fy-outdated-mark`);

describe('S-0320 the outdated mark on a ferret row', () => {
  it('S-0320 marks a live ferret whose instructions are stale, with the sections in its words, and leaves the rest bare', async () => {
    const root = await draw(undefined);
    expect(mark(root, 'busy-1')?.getAttribute('aria-label')).toBe(
      'Outdated — restart to load new instructions (Pack mode and agenda)',
    );
    expect(mark(root, 'idle-1')?.getAttribute('aria-label')).toBe(
      'Outdated — restart to load new instructions (tools)',
    );
    expect(mark(root, 'fresh-1')).toBeNull();
    // A stopped ferret has nothing a restart can fix: no mark.
    expect(mark(root, 'over-1')).toBeNull();
  });
});

describe('S-0320 Restart outdated (N) in the list ⋯ menu', () => {
  it('S-0320 wears the count on the ⋯ and offers the press with that count; nothing is offered when nothing is outdated', async () => {
    const root = await draw(undefined);
    const button = must(options(root), 'the list options button');
    expect(button.querySelector('[data-sbar-options-badge]')?.textContent).toBe('2');
    expect(button.getAttribute('aria-label')).toContain('2 outdated');
    await click(button, 'the options button');
    expect(menuItem()?.textContent).toContain('Restart outdated (2)');
  });

  it('S-0320 presses once with scope outdated; idle ones restart now and busy ones queue, said in a line, and the marks follow', async () => {
    const posted: Posted[] = [];
    const root = await draw(
      () => ({
        restarted: [{ id: 'idle-1', name: 'maryah' }],
        queued: [{ id: 'busy-1', name: 'hadi', reason: 'mid-turn' as const }],
        skipped: [],
        failed: [],
      }),
      posted,
    );
    await click(options(root), 'the options button');
    await click(menuItem(), 'Restart outdated');
    expect(posted).toEqual([{ body: { scope: 'outdated' } }]);
    expect(root.querySelector('[data-restart-outdated-result]')?.textContent).toContain(
      '1 ferret restarted now, 1 ferret queued for their next idle moment.',
    );
    // The restarted ferret drops its mark; the queued one reads Queued in muted ink; the count stops counting both.
    expect(mark(root, 'idle-1')).toBeNull();
    expect(mark(root, 'busy-1')?.getAttribute('data-outdated-mark')).toBe('queued');
    // Nothing is left to restart, so the ⋯ goes away with its badge.
    expect(options(root)).toBeNull();
    // Dismiss clears the line and the overlay: the daemon's own word is the truth again.
    await click(root.querySelector('.fy-restart-outdated__dismiss'), 'Dismiss');
    expect(root.querySelector('[data-restart-outdated-result]')).toBeNull();
    expect(mark(root, 'idle-1')).not.toBeNull();
  });

  it('S-0320 says why when the daemon refuses, in an alert, and keeps the count', async () => {
    const root = await draw(() => {
      throw new Error('the daemon is busy');
    });
    await click(options(root), 'the options button');
    await click(menuItem(), 'Restart outdated');
    expect(root.querySelector('[data-restart-outdated-failed]')?.textContent).toContain(
      'Could not restart: the daemon is busy.',
    );
    expect(options(root)?.querySelector('[data-sbar-options-badge]')?.textContent).toBe('2');
  });
});
