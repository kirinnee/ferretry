/**
 * The Needs you group in the ferret list (S-0486; v4 `sessions-bar-needs-you`): the device's "Group Needs you at the
 * top" choice decides what the list draws, and the Agenda's `ferrets.needs-you` hook says who waits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deviceControls, type ScreenRef } from '@ferretry/app';
import { RouterProvider, WithAppHooks } from '@ferretry/app/testing';
import { FerretList } from '../../../../app/features/list/ferret-list.tsx';
import { FERRETS_NEEDS_YOU_HOOK, type FerretsNeedsYou } from '../../../../contract/index.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { listDaemon, summary as ferretSummary } from './support.ts';

const SCREENS: readonly ScreenRef[] = [{ plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' }];
const FERRETS = [
  ferretSummary('calm', { name: 'ava', title: 'Calm work', folder: '/work/calm', mode: 'interactive' }),
  ferretSummary('asking', { name: 'hadi', title: 'Asking work', folder: '/work/asking', mode: 'interactive' }),
];

/** A provider that says `asking` has three open items, and lets a test change its mind. */
const provider = (): {
  readonly hook: FerretsNeedsYou;
  readonly set: (ids: readonly string[]) => void;
} => {
  const listeners = new Set<() => void>();
  let held: ReadonlyMap<string, { count: number; latestAt: string; ask: string }> = new Map([
    ['asking', { count: 3, latestAt: '2026-11-01T11:00:00.000Z', ask: 'Which branch?' }],
  ]);
  return {
    hook: {
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      watch: () => () => undefined,
      needing: () => held,
    },
    set: ids => {
      held = new Map(ids.map(id => [id, { count: 1, latestAt: '2026-11-01T11:00:00.000Z', ask: '' }]));
      for (const listener of listeners) listener();
    },
  };
};

let mounted: Mounted | undefined;
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.pushState(null, '', '/');
});

const draw = async (hook: FerretsNeedsYou | undefined, group: boolean): Promise<HTMLElement> => {
  deviceControls().setDeviceControls({ sessionsMode: 'all', groupNeedsYou: group });
  window.history.pushState(null, '', '/d/alpha/ferrets');
  mounted = await mount(
    <WithAppHooks provided={hook === undefined ? {} : { [FERRETS_NEEDS_YOU_HOOK]: hook }}>
      <RouterProvider screens={SCREENS}>
        <FerretList client={listDaemon(FERRETS).client} />
      </RouterProvider>
    </WithAppHooks>,
  );
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
  return mounted.container;
};

const groups = (root: Element): (string | null)[] =>
  [...root.querySelectorAll('section.fy-sbar__group')].map(node => node.getAttribute('aria-label'));

describe('the Needs you group in the ferret list', () => {
  it('S-0486 puts the ferret that waits on you in "Needs you", above the folders, with its count', async () => {
    const root = await draw(provider().hook, true);
    expect(groups(root)).toEqual(['Needs you', 'calm']);
    const group = must(root.querySelector('[data-sbar-needs-you-group]'), 'the Needs you group');
    expect(group.querySelector('[data-sbar-session="asking"]')).not.toBeNull();
    expect(group.querySelector('[data-sbar-unread]')?.textContent).toContain('3');
  });

  it('S-0486 leaves it in its folder, still marked, when "Group Needs you at the top" is off', async () => {
    const root = await draw(provider().hook, false);
    expect(groups(root)).toEqual(['asking', 'calm']);
    expect(root.querySelector('[data-sbar-needs-you-group]')).toBeNull();
    expect(root.querySelector('[data-sbar-session="asking"]')?.hasAttribute('data-sbar-needs-you')).toBe(true);
  });

  it('S-0486 draws no group, and nothing bold, without a provider', async () => {
    const root = await draw(undefined, true);
    expect(groups(root)).toEqual(['asking', 'calm']);
    expect(root.querySelector('[data-sbar-needs-you]')).toBeNull();
  });

  it('S-0486 follows the answer live: a ferret that stops waiting leaves the group', async () => {
    const live = provider();
    const root = await draw(live.hook, true);
    expect(groups(root)).toContain('Needs you');
    await interact(async () => live.set([]));
    expect(groups(root)).not.toContain('Needs you');
  });
});
