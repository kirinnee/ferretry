import { describe, expect, it } from 'bun:test';
import { ScreenHrefProvider } from '@ferretry/app';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import type { ListClient } from '../../../app/features/list/api.ts';
import { EVENT_ORDER } from '../../../app/features/list/model.ts';
import { PullsList } from '../../../app/features/list/pulls-list.tsx';
import { ProjectPulls } from '../../../app/features/list/project-section.tsx';
import type { WatchOverview } from '../../../contract/index.ts';
import { mixed, NOW, overview, PROJECT, pull, REPO, view } from '../../fixtures/pulls-list-views.ts';

interface Call {
  readonly route: string;
  readonly init: { params?: Record<string, string>; body?: unknown } | undefined;
}

/** A fake daemon: the overview, the project names, and a PATCH that is recorded. `patchAnswer` may be an error. */
const fake = (
  current: () => WatchOverview,
  calls: Call[] = [],
  patchAnswer: unknown = { view: { project: PROJECT, watch: true, notify: {} } },
): ListClient => ({
  call: (async (route: string, init?: Call['init']) => {
    calls.push({ route, init });
    if (route === 'GET /v1/pulls/watch') return current();
    if (route === 'GET /v1/projects') return [{ id: PROJECT, name: 'Demo project' }];
    if (route === 'PATCH /v1/pulls/watch/:project') {
      if (patchAnswer instanceof Error) throw patchAnswer;
      return patchAnswer;
    }
    throw new Error(`unexpected ${route}`);
  }) as ListClient['call'],
});

const href = (_daemon: string, plugin: string, screen: string, params: Readonly<Record<string, string>> = {}) =>
  `/d/${plugin}/${screen}/${params.repo ?? ''}/${params.number ?? ''}`;

const screen = (client: ListClient) => (
  <RouterProvider>
    <ScreenHrefProvider href={href}>
      <PullsList client={client} daemon="workstation" nowMs={NOW} onNavigate={() => undefined} />
    </ScreenHrefProvider>
  </RouterProvider>
);

const shown = async (mounted: Mounted, selector: string): Promise<void> =>
  await settleUntil(() => mounted.container.querySelector(selector) !== null, selector, interact);

const click = async (element: Element): Promise<void> => {
  await interact(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
};

const rows = (mounted: Mounted): string[] =>
  [...mounted.container.querySelectorAll('[data-pull-row]')].map(el => el.getAttribute('data-pull-row') ?? '');

const chip = (mounted: Mounted, key: string): HTMLElement =>
  must(mounted.container.querySelector<HTMLElement>(`[data-pulls-filter="${key}"]`), `chip ${key}`);

describe('the PRs screen', () => {
  it('opens on "mine", counts every filter, and the chips narrow the list', async () => {
    const mounted = await mount(screen(fake(mixed)));
    await shown(mounted, '[data-pull-row]');
    expect(rows(mounted)).toEqual(['1']);
    expect(chip(mounted, 'mine').textContent).toContain('1');
    expect(chip(mounted, 'all').textContent).toContain('4');
    await click(chip(mounted, 'review'));
    expect(rows(mounted)).toEqual(['2']);
    await click(chip(mounted, 'all'));
    expect(rows(mounted)).toEqual(['4', '2', '1', '3']);
    expect(mounted.container.textContent).toContain('Demo project');
    await mounted.unmount();
  });

  it('shows each PR’s state: draft, review, CI, who and when, on one clock', async () => {
    const mounted = await mount(screen(fake(mixed)));
    await shown(mounted, '[data-pull-row]');
    await click(chip(mounted, 'all'));
    const row = (n: number) => must(mounted.container.querySelector<HTMLElement>(`[data-pull-row="${n}"]`), `row ${n}`);
    expect(row(1).querySelector('[data-pull-ci="failing"]')?.textContent).toBe('CI failing');
    expect(row(1).querySelector('[data-pull-review="changes_requested"]')?.textContent).toBe('Changes requested');
    expect(row(2).querySelector('[data-pull-ci="running"]')?.textContent).toBe('CI running');
    expect(row(2).querySelector('[data-pull-asked]')).not.toBeNull();
    expect(row(3).querySelector('[data-pull-draft]')).not.toBeNull();
    expect(row(3).textContent).toContain('updated 27h ago');
    expect(row(1).textContent).toContain('updated 4m ago');
    // Row 1 opens the PR page in the app and has a GitHub link beside it.
    expect(row(1).querySelector('a[href="/d/pulls/pull/octo~demo/1"]')).not.toBeNull();
    expect(row(1).querySelector('a[href="https://github.com/octo/demo/pull/1"]')?.getAttribute('rel')).toContain(
      'noopener',
    );
    await mounted.unmount();
  });

  it('draws a stranger’s title and login as inert text, and links only an https://github.com address', async () => {
    const hostile = overview(
      view({
        repos: [
          {
            repo: REPO,
            account: 'gha_1',
            login: 'me',
            checkedAt: '2026-02-03T11:59:00Z',
            pulls: [
              pull(5, {
                title: `<img src=x onerror=alert(1)> <script>x()</script> ${'W'.repeat(300)}`,
                author: { login: 'evil' },
                url: 'https://github.com.evil.example/octo/demo/pull/5',
                mine: true,
              }),
              pull(6, { title: 'javascript link', url: 'https://github.com/octo/demo/pull/6', mine: true }),
            ],
          },
        ],
      }),
    );
    const mounted = await mount(screen(fake(() => hostile)));
    await shown(mounted, '[data-pull-row]');
    const root = mounted.container;
    for (const tag of ['img', 'script', 'iframe']) expect(root.querySelector(tag)).toBeNull();
    expect(root.textContent).toContain('<script>x()</script>');
    expect(root.querySelector('[data-pull-row="5"] bdi')?.textContent).toContain('<img');
    // The title breaks anywhere, so 300 unbroken characters cannot widen the page.
    expect(root.querySelector('[data-pull-row="5"] .\\[overflow-wrap\\:anywhere\\]')).not.toBeNull();
    // A look-alike host is not linked; the real one is.
    expect(root.querySelector('[data-pull-row="5"] a[href^="https://github.com.evil"]')).toBeNull();
    expect(root.querySelector('[data-pull-row="6"] a[href="https://github.com/octo/demo/pull/6"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('folds a long repository and every PR stays reachable', async () => {
    const many = overview(
      view({
        repos: [
          {
            repo: REPO,
            account: 'gha_1',
            login: 'me',
            checkedAt: '2026-02-03T11:59:00Z',
            pulls: Array.from({ length: 45 }, (_, i) => pull(i + 1, { mine: true })),
          },
        ],
      }),
    );
    const mounted = await mount(screen(fake(() => many)));
    await shown(mounted, '[data-pull-row]');
    expect(rows(mounted)).toHaveLength(20);
    const more = must(
      [...mounted.container.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('Show 20 more')),
      'a show-more button',
    );
    expect(more.textContent).toContain('25 hidden');
    await click(more);
    expect(rows(mounted)).toHaveLength(40);
    await click(
      must(
        [...mounted.container.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('Show 5 more')),
        'last page',
      ),
    );
    expect(rows(mounted)).toHaveLength(45);
    await mounted.unmount();
  });

  it('says why a project shows nothing: watch off, no account, nothing open', async () => {
    const off = overview(view({ watch: false }));
    let mounted = await mount(screen(fake(() => off)));
    await shown(mounted, '[data-pulls-empty]');
    expect(mounted.container.querySelector('[data-pulls-empty="watch-off"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-pulls-watch] input[type="checkbox"]')).toBeNull();
    expect(mounted.container.querySelector('[data-pulls-watch-again]')?.textContent).toBe('Watch again');
    await mounted.unmount();

    const unlinked = overview(view({ watch: false, watchedBy: 'default', repos: [] }));
    mounted = await mount(screen(fake(() => unlinked)));
    await shown(mounted, '[data-pulls-empty="no-reader"]');
    expect(mounted.container.querySelector('[data-pulls-empty="no-reader"]')?.textContent).toContain(
      'Link a GitHub account to see its pull requests',
    );
    expect(mounted.container.querySelector('[data-pulls-stop]')).toBeNull();
    await mounted.unmount();

    const lonely = overview(
      view({ repos: [], needsAccount: [{ provider: 'github', owner: 'octo', name: 'private' }] }),
    );
    mounted = await mount(screen(fake(() => lonely)));
    await shown(mounted, '[data-pulls-needs-account]');
    expect(mounted.container.querySelector('[data-pulls-needs-account]')?.textContent).toContain('octo/private');
    expect(mounted.container.querySelector('[data-pulls-empty="no-account"]')).not.toBeNull();
    await mounted.unmount();

    mounted = await mount(screen(fake(() => overview())));
    await shown(mounted, '[data-pulls-empty="no-projects"]');
    await mounted.unmount();
  });

  it('says polling is paused to stay inside GitHub’s limit', async () => {
    const paused = overview(view({ pausedUntil: '2026-02-03T12:30:00Z' }));
    const mounted = await mount(screen(fake(() => paused)));
    await shown(mounted, '[data-pulls-paused]');
    expect(mounted.container.querySelector('[data-pulls-paused]')?.textContent).toContain('Paused until');
    expect(mounted.container.querySelector('[data-pulls-paused]')?.textContent).toContain(
      "to stay inside GitHub's limit",
    );
    await mounted.unmount();
  });

  it('turns the watch on with one PATCH naming only that change, then reads again', async () => {
    let current = overview(view({ watch: false }));
    const calls: Call[] = [];
    const mounted = await mount(screen(fake(() => current, calls)));
    await shown(mounted, '[data-pulls-watch]');
    current = overview(view({ watch: true }));
    await click(must(mounted.container.querySelector('[data-pulls-watch-again]'), 'watch again'));
    await settleUntil(() => calls.some(c => c.route.startsWith('PATCH')), 'the patch', interact);
    const patch = calls.find(c => c.route.startsWith('PATCH'));
    expect(patch?.init).toEqual({ params: { project: PROJECT }, body: { watch: true } });
    // It reads again so what is drawn is what the daemon holds.
    await settleUntil(
      () => mounted.container.querySelector('[data-pulls-notify]') !== null,
      'the notify choices',
      interact,
    );
    await mounted.unmount();
  });

  it('a watched project shows its PRs with only a quiet Stop watching, and stopping is one PATCH', async () => {
    let current = mixed();
    const calls: Call[] = [];
    const mounted = await mount(screen(fake(() => current, calls)));
    await shown(mounted, '[data-pull-row]');
    expect(mounted.container.querySelector('input[type="checkbox"][id^="pulls-watch"]')).toBeNull();
    const stop = must(mounted.container.querySelector<HTMLButtonElement>('[data-pulls-stop]'), 'stop');
    expect(stop.textContent).toContain('Stop watching');
    // The list comes first and the control after it.
    expect(
      must(mounted.container.querySelector('[data-pull-row]'), 'row').compareDocumentPosition(stop) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    current = overview(view({ watch: false }));
    await click(stop);
    await settleUntil(
      () => mounted.container.querySelector('[data-pulls-watch-again]') !== null,
      'watch again',
      interact,
    );
    const patches = calls.filter(c => c.route.startsWith('PATCH'));
    expect(patches.map(c => c.init?.body)).toEqual([{ watch: false }]);
    expect(mounted.container.querySelector('[data-pull-row]')).toBeNull();
    await mounted.unmount();
  });

  it('a project watched only by default asks the owner to pick what notifies the phone', async () => {
    const current = overview(
      view({
        watchedBy: 'default',
        notify: Object.fromEntries(EVENT_ORDER.map(event => [event, false])),
      }),
    );
    const mounted = await mount(screen(fake(() => current)));
    await shown(mounted, '[data-pulls-notify-hint]');
    expect(mounted.container.querySelector('[data-pulls-notify-hint]')?.textContent).toBe(
      'Pick what should notify your phone.',
    );
    const boxes = [...mounted.container.querySelectorAll<HTMLInputElement>('[data-pulls-notify-event]')];
    expect(boxes).toHaveLength(EVENT_ORDER.length);
    expect(boxes.every(box => !box.checked)).toBe(true);
    await mounted.unmount();
  });

  it('sends one notify choice at a time, and shows a refusal as the daemon worded it', async () => {
    const calls: Call[] = [];
    const mounted = await mount(
      screen(fake(() => overview(view()), calls, new Error('this device may not change settings'))),
    );
    await shown(mounted, '[data-pulls-notify-event="ciPassed"]');
    const box = must(mounted.container.querySelector<HTMLInputElement>('[data-pulls-notify-event="ciPassed"]'), 'box');
    expect(box.checked).toBe(false);
    await click(box);
    await settleUntil(() => mounted.container.querySelector('[role="alert"]') !== null, 'the refusal', interact);
    expect(calls.find(c => c.route.startsWith('PATCH'))?.init?.body).toEqual({ notify: { ciPassed: true } });
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      'this device may not change settings',
    );
    await mounted.unmount();
  });

  it('shows a daemon-held change as waiting, never as done', async () => {
    const mounted = await mount(
      screen(
        fake(() => overview(view()), [], {
          held: ['Turning this on is held for the owner.'],
          view: { project: PROJECT, watch: true, notify: {} },
        }),
      ),
    );
    await shown(mounted, '[data-pulls-notify-event="ciPassed"]');
    await click(must(mounted.container.querySelector('[data-pulls-notify-event="ciPassed"]'), 'box'));
    await settleUntil(() => mounted.container.querySelector('[role="status"]') !== null, 'held line', interact);
    expect(mounted.container.textContent).toContain('Waiting for you to confirm on the machine');
    await mounted.unmount();
  });

  it('fails loud when the read fails, with a way to try again', async () => {
    const mounted = await mount(
      screen({
        call: (async () => {
          throw new Error('daemon unreachable');
        }) as ListClient['call'],
      }),
    );
    await shown(mounted, '[role="alert"]');
    expect(mounted.container.textContent).toContain('daemon unreachable');
    expect(mounted.container.textContent).toContain('Try again');
    await mounted.unmount();
  });
});

describe('the PRs section on a project page', () => {
  it('draws this project’s PRs with the same block, and says so when the daemon does not list it', async () => {
    const section = (project: string, client: ListClient) => (
      <RouterProvider>
        <ScreenHrefProvider href={href}>
          <ProjectPulls
            client={client}
            daemon="workstation"
            nowMs={NOW}
            onNavigate={() => undefined}
            project={project}
          />
        </ScreenHrefProvider>
      </RouterProvider>
    );
    let mounted = await mount(section(PROJECT, fake(mixed)));
    await shown(mounted, '[data-pull-row]');
    expect(rows(mounted)).toEqual(['4', '2', '1', '3']);
    await mounted.unmount();
    mounted = await mount(section('99999999-9999-4999-8999-999999999999', fake(mixed)));
    await shown(mounted, '[data-pulls-empty="unknown-project"]');
    await mounted.unmount();
  });
});
