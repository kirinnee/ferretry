/**
 * The one-step Add account flow as the person sees it on Settings › Runtimes (runtimes plan U3): a login is added and its
 * runtime appears by itself; a name that clashes carries the login's own stable suffix, never `-2`/`-3`; and Advanced
 * still opens today's form. The daemon half (names, CLI installed) is `runtimes-api.test.ts` and `derived-runtimes.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type RuntimeCatalog, RuntimeCatalogSchema, type RuntimeView } from '../../../../../../contract/index.ts';
import { RuntimesTab } from '../../../../../../app/features/fleet/runtimes/runtimes-tab.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import { DATA, machine, READS, RUNTIMES, runtime, scripted } from '../account-support.ts';
import { live } from './support-a.ts';

/** `stableSuffix('work')` (derived-runtimes.ts): pinned here, so a change of the suffix is a visible, deliberate one. */
const WORK_SUFFIX = 'exppc';

beforeEach(() => {
  window.history.pushState({}, '', '/d/d1/settings/runtimes/runtimes');
});

afterEach(() => {
  window.location.hash = '';
  window.history.pushState({}, '', '/');
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 4; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const catalog = (runtimes: readonly RuntimeView[]): RuntimeCatalog =>
  RuntimeCatalogSchema.parse({ ...RUNTIMES, runtimes });

const forLogin = (name: string, login: string): RuntimeView =>
  runtime({ name, credential: { id: login, store: 'ferretry', label: login, status: 'ready' } });

/** The tab on a daemon whose runtimes are whatever `current()` says now; `added` tells it a login was added. */
const open = async (current: () => readonly RuntimeView[]) => {
  const harness = live(
    scripted({
      ...READS(DATA),
      'GET /v1/runtimes': () => catalog(current()),
    }),
  );
  const view = await mount(
    <RuntimesTab
      client={harness.client}
      machineName="studio-mac"
      machine={machine()}
      online
      checking={false}
      onRetry={() => undefined}
    />,
  );
  await settle();
  return {
    view,
    added: async (loginId: string) => {
      await interact(() => harness.emit('logins.changed', { loginId }));
      await settle();
    },
  };
};

const names = (container: ParentNode): string[] =>
  [...container.querySelectorAll('[data-runtime-row]')].map(row => row.getAttribute('data-runtime-row') ?? '');

describe('Add account, as the Runtimes tab shows it', () => {
  it('shows the runtime of a login the moment the login is added, with nothing made by hand', async () => {
    // Arrange — one runtime now; the daemon derives a second as soon as login "kimi" exists
    let runtimes = [forLogin('claude-default', 'claude-personal')];
    const { view, added } = await open(() => runtimes);
    expect(names(view.container)).toEqual(['claude-default']);

    // Act — the person adds a login; the machine says logins changed
    runtimes = [...runtimes, forLogin('kimi', 'kimi')];
    await added('kimi');

    // Assert
    expect(names(view.container)).toEqual(['claude-default', 'kimi']);
    expect(must(view.container.querySelector('[data-runtimes-count]'), 'count').textContent).toBe(
      '2 runtimes on studio-mac',
    );
    await view.unmount();
  });

  it('shows a clashing login under its own stable suffix, and keeps every other name when one login goes', async () => {
    // Arrange — the owner's runtime "work" is on another login, so login "work" has "work-<suffix>"; login "work-2" is plain
    const clashing = `work-${WORK_SUFFIX}`;
    let runtimes = [forLogin('work', 'other'), forLogin(clashing, 'work'), forLogin('work-2', 'work-2')];
    const { view, added } = await open(() => runtimes);
    expect(names(view.container).toSorted()).toEqual(['work', 'work-2', clashing].toSorted());

    // Act — login "work" is deleted
    runtimes = runtimes.filter(item => item.name !== clashing);
    await added('work');

    // Assert — work-2 is still login work-2 (it was never "work"'s -2), and the deleted name is simply gone
    expect(names(view.container).toSorted()).toEqual(['work', 'work-2']);
    expect(must(view.container.querySelector('[data-runtime-card="work-2"]'), 'work-2').textContent).toContain(
      '(work-2) · Default profile',
    );
    await view.unmount();
  });

  it('keeps Advanced: it opens today’s add-a-runtime form', async () => {
    const { view } = await open(() => [forLogin('claude-default', 'claude-personal')]);

    await interact(() => must(view.container.querySelector<HTMLElement>('[data-add-runtime]'), 'Advanced').click());

    expect(must(view.container.querySelector('[data-add-runtime] h3'), 'form').textContent).toBe(
      'Advanced: add a runtime',
    );
    await view.unmount();
  });
});
