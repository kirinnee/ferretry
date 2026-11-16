/**
 * Folder mode in the ferret list: Projects' `ferrets.list-scope` says which registered project a folder belongs to and
 * which group the list is focused on. The list names its groups by project, focuses one on a click, says so with a way
 * out, and drops a focus on a folder that no longer exists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deviceControls, type ScreenRef } from '@ferretry/app';
import { RouterProvider, WithAppHooks } from '@ferretry/app/testing';
import { FerretList } from '../../../../app/features/list/ferret-list.tsx';
import {
  FERRETS_LIST_SCOPE_HOOK,
  type FerretListScopeSnapshot,
  type FerretsListScope,
} from '../../../../contract/index.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { listDaemon, summary as ferretSummary } from './support.ts';

const SCREENS: readonly ScreenRef[] = [{ plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' }];
const FERRETS = [
  ferretSummary('main', { name: 'ava', title: 'Main work', folder: '/work/app', mode: 'interactive' }),
  ferretSummary('tree', { name: 'hadi', title: 'Tree work', folder: '/work/app/.worktrees/x', mode: 'interactive' }),
  ferretSummary('solo', { name: 'wren', title: 'Solo work', folder: '/work/solo', mode: 'interactive' }),
];

/** A provider over one registered project ("App", at `/work/app`) that records what the list asked of it. */
const provider = (
  first: string | null,
  options: { readonly unread?: boolean } = {},
): {
  readonly hook: FerretsListScope;
  readonly asked: string[];
  readonly watching: () => number;
  readonly set: (scope: string | null) => void;
  /** The registry answers: from now on the project is known (an unread registry covers no folder). */
  readonly learn: () => void;
} => {
  const listeners = new Set<() => void>();
  const asked: string[] = [];
  let watching = 0;
  let known = options.unread !== true;
  const groupOf: FerretListScopeSnapshot['groupOf'] = folder =>
    known && (folder === '/work/app' || folder.startsWith('/work/app/')) ? { key: '/work/app', name: 'App' } : null;
  let held: FerretListScopeSnapshot = { scope: first, known, groupOf };
  const set = (scope: string | null): void => {
    held = { scope, known, groupOf };
    for (const listener of listeners) listener();
  };
  return {
    asked,
    set,
    learn: () => {
      known = true;
      set(held.scope);
    },
    watching: () => watching,
    hook: {
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      watch: () => {
        watching += 1;
        return () => {
          watching -= 1;
        };
      },
      snapshot: () => held,
      enter: key => {
        asked.push(`enter ${key}`);
        set(key);
      },
      exit: () => {
        asked.push('exit');
        set(null);
      },
      recover: () => {
        asked.push('recover');
        set(null);
      },
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

const draw = async (hook: FerretsListScope | undefined): Promise<HTMLElement> => {
  deviceControls().setDeviceControls({ sessionsMode: 'all' });
  window.history.pushState(null, '', '/d/alpha/ferrets');
  mounted = await mount(
    <WithAppHooks provided={hook === undefined ? {} : { [FERRETS_LIST_SCOPE_HOOK]: hook }}>
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

describe('folder mode in the ferret list', () => {
  it('names a group by its registered project and files a worktree under it', async () => {
    const live = provider(null);
    const root = await draw(live.hook);
    expect(groups(root)).toEqual(['App', 'solo']);
    const app = must(root.querySelector('section[aria-label="App"]'), 'the App group');
    expect(
      [...app.querySelectorAll('[data-sbar-session]')].map(row => row.getAttribute('data-sbar-session')).sort(),
    ).toEqual(['main', 'tree']);
    expect(live.watching()).toBe(1);
  });

  it('focuses a group when its name is chosen, shows only it, and offers the way back', async () => {
    const live = provider(null);
    const root = await draw(live.hook);
    await interact(() =>
      must(root.querySelector<HTMLElement>('[data-sbar-focus="/work/app"]'), 'the focus button').click(),
    );
    expect(live.asked).toEqual(['enter /work/app']);
    expect(groups(root)).toEqual(['App']);
    expect(root.querySelector('[data-sbar-scope]')?.textContent).toContain('App');
    expect(root.querySelector('[data-sbar-focus]')).toBeNull();

    await interact(() => must(root.querySelector<HTMLElement>('[data-sbar-scope-exit]'), 'the way back').click());
    expect(live.asked).toEqual(['enter /work/app', 'exit']);
    expect(groups(root)).toEqual(['App', 'solo']);
    expect(root.querySelector('[data-sbar-scope]')).toBeNull();
  });

  it('starts on a focus the device already holds, naming a folder no project covers by its own name', async () => {
    const root = await draw(provider('/work/solo').hook);
    expect(groups(root)).toEqual(['solo']);
    expect(root.querySelector('[data-sbar-scope]')?.textContent).toContain('solo');
  });

  it('drops a focus on a folder that is gone, and draws every folder again', async () => {
    const live = provider('/work/deleted');
    const root = await draw(live.hook);
    expect(live.asked).toEqual(['recover']);
    expect(groups(root)).toEqual(['App', 'solo']);
  });

  it('waits for the registry before it drops a focus: a worktree-only ferret under a valid project keeps it', async () => {
    const live = provider('/work/app', { unread: true });
    deviceControls().setDeviceControls({ sessionsMode: 'all' });
    window.history.pushState(null, '', '/d/alpha/ferrets');
    mounted = await mount(
      <WithAppHooks provided={{ [FERRETS_LIST_SCOPE_HOOK]: live.hook }}>
        <RouterProvider screens={SCREENS}>
          <FerretList client={listDaemon([FERRETS[1] as (typeof FERRETS)[number]]).client} />
        </RouterProvider>
      </WithAppHooks>,
    );
    await interact(async () => {
      for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(live.asked).toEqual([]);
    await interact(() => live.learn());
    expect(live.asked).toEqual([]);
    expect(groups(mounted.container)).toEqual(['App']);
    expect(mounted.container.querySelector('[data-sbar-scope]')?.textContent).toContain('App');
  });

  it('still drops a focus on a deleted project once the registry has answered', async () => {
    const live = provider('/work/deleted', { unread: true });
    const root = await draw(live.hook);
    expect(live.asked).toEqual([]);
    await interact(() => live.learn());
    expect(live.asked).toEqual(['recover']);
    expect(groups(root)).toEqual(['App', 'solo']);
  });

  it('keeps a known folder with no ferrets focused, and says it is empty', async () => {
    const live = provider('/work/app');
    mounted = undefined;
    deviceControls().setDeviceControls({ sessionsMode: 'all' });
    window.history.pushState(null, '', '/d/alpha/ferrets');
    mounted = await mount(
      <WithAppHooks provided={{ [FERRETS_LIST_SCOPE_HOOK]: live.hook }}>
        <RouterProvider screens={SCREENS}>
          <FerretList client={listDaemon([FERRETS[2] as (typeof FERRETS)[number]]).client} />
        </RouterProvider>
      </WithAppHooks>,
    );
    await interact(async () => {
      for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(live.asked).toEqual([]);
    expect(mounted.container.querySelector('[data-sbar-scope]')).not.toBeNull();
    expect(mounted.container.querySelector('.fy-sbar__empty')?.textContent).toContain('No');
  });

  it('draws as it always did, by folder with nothing to focus, when nobody provides it', async () => {
    const root = await draw(undefined);
    expect(groups(root)).toEqual(['app', 'solo', 'x']);
    expect(root.querySelector('[data-sbar-focus]')).toBeNull();
    expect(root.querySelector('[data-sbar-scope]')).toBeNull();
  });

  it('stops watching when the list goes', async () => {
    const live = provider(null);
    await draw(live.hook);
    await mounted?.unmount();
    mounted = undefined;
    expect(live.watching()).toBe(0);
  });
});
