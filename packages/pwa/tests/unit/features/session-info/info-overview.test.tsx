/** Info › Overview: who the ferret is, where it works, and where it came from. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { ManagedWorktreeView } from '@ferretry/protocol';
import { InfoOverview, type InfoOverviewProps } from '../../../../src/features/session-info/info-overview.tsx';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

const NOW = Date.parse('2026-10-16T10:00:00.000Z');

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const show = async (overrides: Partial<InfoOverviewProps> = {}) => {
  const written: string[] = [];
  const renamed: boolean[] = [];
  const opened: string[] = [];
  mounted = await mount(
    <InfoOverview
      name="Hadi"
      now={NOW}
      project={null}
      view={sessionView('session-a', {
        config: { createdAt: '2026-10-16T09:00:00.000Z' },
        state: { startedAt: undefined, lastActivityAt: '2026-10-16T09:58:00.000Z' },
      })}
      worktrees={null}
      write={async text => void written.push(text)}
      {...overrides}
    />,
  );
  return { root: mounted.container, written, renamed, opened };
};

describe('InfoOverview', () => {
  it('shows the name, task, cwd and session id, with no rename or card control when the host offers none', async () => {
    const { root, written } = await show({ project: 'ferretry' });
    expect(root.querySelector('[data-info-row="Name"] strong')?.textContent).toBe('Hadi');
    expect(root.querySelector('[data-info-rename]')).toBeNull();
    expect(root.querySelector('[data-info-row="Card"]')).toBeNull();
    expect(root.textContent).toContain('ferretry');
    expect(root.textContent).toContain('/work/session-a');
    expect(root.textContent).toContain('session-a');
    expect(root.textContent).toContain('2m ago');

    const copy = must(root.querySelector<HTMLButtonElement>('button[aria-label="Copy Session id"]'), 'copy id');
    await interact(() => copy.click());
    expect(written).toEqual(['session-a']);
  });

  it("shows the task by its name and a batch label on its own row, never in the name's place", async () => {
    const labelled = sessionView('session-b', { config: { name: 'CyanPrint', label: 'diene-cyan' } });
    const { root } = await show({ view: labelled });
    expect(root.querySelector('[data-info-row="Task"]')?.textContent).toContain('CyanPrint');
    expect(root.querySelector('[data-info-row="Label"]')?.textContent).toContain('diene-cyan');
    await mounted?.unmount();

    const plain = await show({ view: sessionView('session-c', { config: { name: 'CyanPrint' } }) });
    expect(plain.root.querySelector('[data-info-row="Label"]')).toBeNull();
  });

  it('says a ferret has no project with a muted note', async () => {
    const { root } = await show({ project: null });
    expect(root.textContent).toContain('Not in a project');
  });

  it('offers Rename when the host hands it in, and calls back', async () => {
    const renamed: boolean[] = [];
    const { root } = await show({ onRename: () => renamed.push(true) });
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-rename]'), 'rename').click());
    expect(renamed).toEqual([true]);
  });

  describe('the Card row', () => {
    const chip = {
      kind: 'card',
      id: 'F18',
      ref: '&F18',
      title: 'Board system',
      lane: 'Plan/Design',
      activity: 'active',
      tone: 'ok',
    } as const;

    it('reads `&F18 (Plan/Design)` and opens the card when tapped', async () => {
      const opened: boolean[] = [];
      const { root } = await show({ card: { chip, onOpen: () => opened.push(true) } });
      const button = must(root.querySelector<HTMLButtonElement>('[data-info-card="F18"]'), 'card');
      expect(root.querySelector('[data-info-row="Card"]')?.textContent).toContain('&F18 (Plan/Design)');
      expect(root.querySelector('[data-info-row="Tasks"]')).toBeNull();
      await interact(() => button.click());
      expect(opened).toEqual([true]);
    });

    it('reads just the id while the card’s lane is not known', async () => {
      const { root } = await show({ card: { chip: { ...chip, lane: null }, onOpen: () => undefined } });
      expect(root.querySelector('[data-info-row="Card"]')?.textContent).toContain('&F18');
      expect(root.querySelector('[data-info-row="Card"]')?.textContent).not.toContain('(');
    });

    it('says No card, in amber and without a link, when the session has none', async () => {
      const { root } = await show({ card: { chip: { kind: 'none' }, onOpen: () => undefined } });
      const none = must(root.querySelector('[data-info-card="none"]'), 'none');
      expect(none.textContent).toBe('No card');
      expect(none.className).toContain('fy-info-warn');
      expect(root.querySelector('button[data-info-card]')).toBeNull();
    });
  });

  it('reads the main checkout as "Main checkout" when the folder is in no managed worktree', async () => {
    const { root } = await show({ worktrees: [] });
    expect(root.textContent).toContain('Main checkout');
  });

  it('shows Worktree as Unknown while the worktree list is unread', async () => {
    const { root } = await show({ worktrees: null });
    expect(root.textContent).toContain('Unknown');
  });

  it('names the worktree, its branch and its clean/dirty chip, with a copy button on the path', async () => {
    const written: string[] = [];
    const view = sessionView('session-a', { config: { cwd: '/work/app/packages/pwa' } });
    const trees: readonly ManagedWorktreeView[] = [
      {
        path: '/work/app/packages/pwa',
        branch: 'feat/info',
        live: { branch: 'feat/info', status: { staged: true, unstaged: false, untracked: false, conflicted: false } },
      } as unknown as ManagedWorktreeView,
    ];
    const { root } = await show({ view, worktrees: trees, write: async text => void written.push(text) });
    expect(root.textContent).toContain('feat/info');
    expect(root.textContent).toContain('uncommitted changes');
    const copy = must(root.querySelector<HTMLButtonElement>('button[aria-label="Copy Worktree"]'), 'copy worktree');
    await interact(() => copy.click());
    expect(written).toEqual(['/work/app/packages/pwa']);
  });

  it('shows clean when the worktree has no outstanding changes', async () => {
    const view = sessionView('session-a', { config: { cwd: '/work/app' } });
    const trees: readonly ManagedWorktreeView[] = [
      {
        path: '/work/app',
        branch: 'main',
        live: { branch: 'main', status: { staged: false, unstaged: false, untracked: false, conflicted: false } },
      } as unknown as ManagedWorktreeView,
    ];
    const { root } = await show({ view, worktrees: trees });
    expect(root.textContent).toContain('clean');
  });

  it('says it was started by you when there is no parent', async () => {
    const { root } = await show({ view: sessionView('session-a', { config: { parent: undefined } }) });
    expect(root.textContent).toContain('Started by you');
  });

  it('names a parent not among the sessions read as a bare mono id', async () => {
    const view = sessionView('child', { config: { parent: 'ghost' } });
    const { root } = await show({ view, sessions: [view] });
    const parentRow = must(root.querySelector('[data-info-row="Started by"]'), 'the parent row');
    expect(parentRow.textContent).toContain('ghost');
    expect(parentRow.querySelector('.font-mono')?.textContent).toBe('ghost');
  });

  it('links to a resolved parent and to every child, and falls back to plain text with no onOpenSession', async () => {
    const parent = sessionView('parent-a', { config: { name: 'Parent one', label: 'diene-cyan' } });
    const child = sessionView('child-a', { config: { parent: 'parent-a' } });
    const kid = sessionView('kid-a', { config: { parent: 'child-a', name: 'Kid one' } });
    const opened: string[] = [];
    const { root } = await show({
      view: child,
      sessions: [parent, child, kid],
      onOpenSession: id => opened.push(id),
    });
    const parentLink = must(
      root.querySelector<HTMLButtonElement>('[data-info-session-link="parent-a"]'),
      'the parent link',
    );
    expect(parentLink.textContent).toBe('Parent one');
    await interact(() => parentLink.click());
    expect(opened).toEqual(['parent-a']);

    const childLink = must(root.querySelector<HTMLButtonElement>('[data-sub-ferret-open="kid-a"]'), 'the child link');
    expect(childLink.textContent).toBe('Kid one');
    await interact(() => childLink.click());
    expect(opened).toEqual(['parent-a', 'kid-a']);

    await mounted?.unmount();
    mounted = undefined;
    const plain = await show({ view: child, sessions: [parent, child, kid] });
    expect(plain.root.querySelector('[data-info-session-link]')).toBeNull();
    expect(plain.root.querySelector('[data-sub-ferret-open]')).toBeNull();
    expect(plain.root.querySelector('[data-sub-ferret="kid-a"] .fy-sub-ferret-name')?.textContent).toBe('Kid one');
    expect(plain.root.textContent).toContain('Parent one');
  });

  it('counts the sub-ferrets in the label', async () => {
    const parent = sessionView('parent-a');
    const kids = [
      sessionView('k1', { config: { parent: 'parent-a' } }),
      sessionView('k2', { config: { parent: 'parent-a' } }),
    ];
    const { root } = await show({ view: parent, sessions: [parent, ...kids] });
    expect(root.querySelector('[data-info-row="Sub-ferrets (2)"]')).not.toBeNull();
  });

  it('lists each sub-ferret with how it is doing now, why, and the model it runs on', async () => {
    const parent = sessionView('parent-a');
    const kids = [
      sessionView('k1', {
        config: {
          parent: 'parent-a',
          teammate: 'nadia',
          model: 'claude-opus-5-5',
          createdAt: '2026-10-20T02:00:00.000Z',
        },
        state: { status: 'running', turnState: 'needs-input', turnPrompt: 'Trust this folder?' },
      }),
      sessionView('k2', {
        config: { parent: 'parent-a', label: 'Sweep imports', createdAt: '2026-10-20T01:00:00.000Z' },
        state: { status: 'failed', reason: 'out of quota' },
      }),
    ];
    const { root } = await show({ view: parent, sessions: [parent, ...kids], onOpenSession: () => undefined });
    const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-sub-ferret]')];
    // The failed one is finished: hidden until asked for.
    expect(rows().map(row => row.dataset['subFerret'])).toEqual(['k1']);
    expect(rows()[0]?.querySelector('[data-sub-ferret-state]')?.textContent).toBe('Needs you — Trust this folder?');
    expect(rows()[0]?.querySelector('.fy-sub-ferret-model')?.textContent).toBe('claude-opus-5-5');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('[data-sub-ferret-finished-toggle]'), 'toggle').click(),
    );
    expect(rows().map(row => row.dataset['subFerret'])).toEqual(['k1', 'k2']);
    expect(rows()[1]?.querySelector('[data-sub-ferret-state="failed"]')?.textContent).toBe('Failed — out of quota');
    expect(rows()[1]?.querySelector('.fy-sub-ferret-model')).toBeNull();
  });

  it('counts only the active sub-ferrets and keeps the finished behind a toggle', async () => {
    const parent = sessionView('parent-a');
    const kids = [
      sessionView('live', { config: { parent: 'parent-a' }, state: { status: 'running' } }),
      sessionView('done', { config: { parent: 'parent-a' }, state: { status: 'completed' } }),
      sessionView('stopped', { config: { parent: 'parent-a' }, state: { status: 'stopped' } }),
    ];
    const { root } = await show({ view: parent, sessions: [parent, ...kids] });
    expect(root.querySelector('[data-info-row="Sub-ferrets (1)"]')).not.toBeNull();
    const toggle = must(root.querySelector<HTMLButtonElement>('[data-sub-ferret-finished-toggle]'), 'toggle');
    expect(toggle.textContent).toBe('Show finished (2)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await interact(() => toggle.click());
    expect(toggle.textContent).toBe('Hide finished (2)');
    expect(root.querySelectorAll('[data-sub-ferret]').length).toBe(3);
    await interact(() => toggle.click());
    expect(root.querySelectorAll('[data-sub-ferret]').length).toBe(1);
  });

  it('says none are active, with the finished one tap away, when every sub-ferret is finished', async () => {
    const parent = sessionView('parent-a');
    const kid = sessionView('done', { config: { parent: 'parent-a' }, state: { status: 'completed' } });
    const { root } = await show({ view: parent, sessions: [parent, kid] });
    expect(root.querySelector('[data-info-row="Sub-ferrets (0)"]')?.textContent).toContain('None active');
    expect(root.querySelector('[data-sub-ferret]')).toBeNull();
    expect(root.querySelector('[data-sub-ferret-finished-toggle]')?.textContent).toBe('Show finished (1)');
  });

  it('says None when a ferret has started no children', async () => {
    const { root } = await show({ sessions: [sessionView('session-a')] });
    expect(root.textContent).toContain('None');
  });

  it('reads Started from startedAt when the daemon has one, else from createdAt', async () => {
    const withStart = await show({
      view: sessionView('session-a', {
        state: { startedAt: '2026-10-16T09:55:00.000Z' },
        config: { createdAt: '2026-10-16T01:00:00.000Z' },
      }),
    });
    expect(withStart.root.textContent).toContain('5m ago');
  });
});
