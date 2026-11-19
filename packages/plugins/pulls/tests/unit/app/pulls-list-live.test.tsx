import { describe, expect, it } from 'bun:test';
import { ScreenHrefProvider } from '@ferretry/app';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import type { ListClient } from '../../../app/features/list/api.ts';
import { PullsList } from '../../../app/features/list/pulls-list.tsx';
import { REPOS_OPEN, PAGE } from '../../../app/features/list/model.ts';
import { WatchOverviewSchema, type WatchOverview } from '../../../contract/index.ts';
import { mixed, NOW, overview, PROJECT, pull, view } from '../../fixtures/pulls-list-views.ts';

const href = (_daemon: string, plugin: string, screen: string, params: Readonly<Record<string, string>> = {}) =>
  `/d/${plugin}/${screen}/${params.repo ?? ''}/${params.number ?? ''}`;

const screen = (client: ListClient) => (
  <RouterProvider>
    <ScreenHrefProvider href={href}>
      <PullsList client={client} daemon="workstation" nowMs={NOW} onNavigate={() => undefined} />
    </ScreenHrefProvider>
  </RouterProvider>
);

const click = async (element: Element): Promise<void> => {
  await interact(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
};

const rows = (mounted: Mounted): string[] =>
  [...mounted.container.querySelectorAll('[data-pull-row]')].map(el => el.getAttribute('data-pull-row') ?? '');

const chip = (mounted: Mounted, key: string): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>(`[data-pulls-filter="${key}"]`), `chip ${key}`);

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: Error) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

interface Read {
  readonly answer: Deferred<WatchOverview>;
  readonly signal: AbortSignal | undefined;
}

/** A daemon whose every overview read is a promise the test settles by hand, plus the wake-up the test can fire. */
const slow = (projects: unknown = [{ id: PROJECT, name: 'Demo project' }]) => {
  const reads: Read[] = [];
  const wake: Array<() => void> = [];
  const client: ListClient = {
    call: (async (route: string, init?: { signal?: AbortSignal }) => {
      if (route === 'GET /v1/projects') return projects;
      const answer = deferred<WatchOverview>();
      reads.push({ answer, signal: init?.signal });
      return await answer.promise;
    }) as ListClient['call'],
    subscribe: ((_event: unknown, listener: () => void) => {
      wake.push(listener);
      return () => undefined;
    }) as NonNullable<ListClient['subscribe']>,
  };
  return {
    client,
    reads,
    fire: async () =>
      await interact(() => {
        for (const listener of wake) listener();
      }),
  };
};

/** Every 60-second refresh timer still pending: set when armed, dropped when cleared or fired. */
const watchTimers = (): { pending: () => number; restore: () => void } => {
  const live = new Set<unknown>();
  const { setTimeout: set, clearTimeout: clear } = globalThis;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const handle: unknown = (set as (...a: unknown[]) => unknown)(
      () => {
        live.delete(handle);
        fn();
      },
      ms,
      ...rest,
    );
    if (ms === 60_000) live.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    live.delete(handle);
    clear(handle);
  }) as typeof clearTimeout;
  return {
    pending: () => live.size,
    restore: () => {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
};

describe('the PRs screen reads', () => {
  it('lets only the newest read apply, so an older empty answer never replaces a newer list, and keeps one timer', async () => {
    // The DOM harness installs its own timers at mount, so the watch goes on after it.
    const { client, reads, fire } = slow();
    const mounted = await mount(screen(client));
    const timers = watchTimers();
    try {
      await settleUntil(() => reads.length === 1, 'the first read', interact);
      await fire();
      await settleUntil(() => reads.length === 2, 'the second read', interact);
      // The newer read supersedes the older one: it is told to stop, the newer one is not.
      expect(reads[0]?.signal?.aborted).toBe(true);
      expect(reads[1]?.signal?.aborted).toBe(false);
      await interact(() => reads[1]?.answer.resolve(mixed()));
      await settleUntil(() => rows(mounted).length > 0, 'the newer list', interact);
      expect(rows(mounted)).toEqual(['1']);
      // The older read answers last, with an empty list: it must not win.
      await interact(() => reads[0]?.answer.resolve(overview()));
      expect(mounted.container.querySelector('[data-pulls-empty="no-projects"]')).toBeNull();
      expect(rows(mounted)).toEqual(['1']);
      // And an older read that fails late is not shown as a failed refresh.
      await fire();
      await settleUntil(() => reads.length === 3, 'the third read', interact);
      await fire();
      await settleUntil(() => reads.length === 4, 'the fourth read', interact);
      await interact(() => reads[3]?.answer.resolve(mixed()));
      await interact(() => reads[2]?.answer.reject(new Error('late failure')));
      expect(mounted.container.textContent).not.toContain('late failure');
      expect(rows(mounted)).toEqual(['1']);
      // One timer waits for the next minute, not one per read.
      expect(timers.pending()).toBe(1);
      await mounted.unmount();
      expect(timers.pending()).toBe(0);
    } finally {
      timers.restore();
    }
  });

  it('keeps the last good list and says so when a refresh fails after one that worked', async () => {
    const { client, reads, fire } = slow();
    const mounted = await mount(screen(client));
    await settleUntil(() => reads.length === 1, 'the first read', interact);
    await interact(() => reads[0]?.answer.resolve(mixed()));
    await settleUntil(() => rows(mounted).length > 0, 'the list', interact);
    await fire();
    await settleUntil(() => reads.length === 2, 'the refresh', interact);
    await interact(() => reads[1]?.answer.reject(new Error('daemon went away')));
    await settleUntil(() => (mounted.container.textContent ?? '').includes('daemon went away'), 'the notice', interact);
    expect(rows(mounted)).toEqual(['1']);
    await mounted.unmount();
  });

  it('says "no results yet" for a project the watch has not read, and "no repo" only when its record says so', async () => {
    for (const [record, expected] of [
      [{ id: PROJECT, name: 'Demo project' }, 'no-results'],
      [{ id: PROJECT, name: 'Demo project', repos: [] }, 'no-repos'],
    ] as const) {
      const { client, reads } = slow([record]);
      const mounted = await mount(screen(client));
      await settleUntil(() => reads.length === 1, 'the read', interact);
      await interact(() => reads[0]?.answer.resolve(overview(view({ repos: [] }))));
      await settleUntil(
        () => mounted.container.querySelector(`[data-pulls-empty="${expected}"]`) !== null,
        expected,
        interact,
      );
      await mounted.unmount();
    }
  });

  it('does not count a project whose watch is off in the chips', async () => {
    const { client, reads } = slow();
    const mounted = await mount(screen(client));
    await settleUntil(() => reads.length === 1, 'the read', interact);
    const off = view({
      watch: false,
      repos: [{ ...must(view().repos[0], 'a repo'), pulls: [pull(7, { mine: true })] }],
    });
    await interact(() => reads[0]?.answer.resolve(overview(off)));
    await settleUntil(() => mounted.container.querySelector('[data-pulls-filters]') !== null, 'the chips', interact);
    expect(chip(mounted, 'mine').textContent).toContain('0');
    expect(rows(mounted)).toEqual([]);
    await mounted.unmount();
  });
});

/** 50 repositories of 100 open PRs each: the most one project can hold. */
const huge = (): WatchOverview =>
  WatchOverviewSchema.parse({
    projects: [
      view({
        repos: Array.from({ length: 50 }, (_, r) => ({
          repo: { provider: 'github', owner: 'octo', name: `repo-${String(r).padStart(2, '0')}` },
          account: 'gha_1',
          login: 'me',
          checkedAt: '2026-02-03T11:59:00Z',
          pulls: Array.from({ length: 100 }, (_, n) =>
            pull(n + 1, {
              mine: true,
              repo: { provider: 'github', owner: 'octo', name: `repo-${String(r).padStart(2, '0')}` },
              url: `https://github.com/octo/repo-${String(r).padStart(2, '0')}/pull/${n + 1}`,
            }),
          ),
        })),
      }),
    ],
  });

describe('a project with 50 repositories of 100 PRs', () => {
  it('draws a header per repository and a bounded number of rows, and every PR stays reachable by keyboard', async () => {
    const { client, reads } = slow();
    const mounted = await mount(screen(client));
    await settleUntil(() => reads.length === 1, 'the read', interact);
    await interact(() => reads[0]?.answer.resolve(huge()));
    await settleUntil(() => rows(mounted).length > 0, 'the rows', interact);
    const toggles = [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-pulls-repo-toggle]')];
    expect(toggles).toHaveLength(50);
    // Native buttons: focusable and operable from the keyboard, and they say whether they are open.
    expect(toggles.every(button => button.tagName === 'BUTTON' && button.type === 'button')).toBe(true);
    expect(toggles.map(button => button.getAttribute('aria-expanded')).filter(value => value === 'true')).toHaveLength(
      REPOS_OPEN,
    );
    expect(rows(mounted)).toHaveLength(REPOS_OPEN * PAGE);
    // Open the last repository: its first page draws, and "show more" reaches all 100.
    const last = must(toggles[49], 'last repo toggle');
    await click(last);
    expect(last.getAttribute('aria-expanded')).toBe('true');
    expect(rows(mounted)).toHaveLength((REPOS_OPEN + 1) * PAGE);
    const lastRepo = must(mounted.container.querySelector('[data-pulls-repo="repo-49"]'), 'last repo');
    const more = () =>
      [...lastRepo.querySelectorAll('button')].find(button => (button.textContent ?? '').startsWith('Show'));
    for (let page = 1; page < 5; page += 1) await click(must(more(), `show-more ${page}`));
    expect(lastRepo.querySelectorAll('[data-pull-row]')).toHaveLength(100);
    expect(more()).toBeUndefined();
    // Folding an open repository takes its rows away again.
    await click(last);
    expect(lastRepo.querySelectorAll('[data-pull-row]')).toHaveLength(0);
    expect(rows(mounted)).toHaveLength(REPOS_OPEN * PAGE);
    await mounted.unmount();
  });
});
