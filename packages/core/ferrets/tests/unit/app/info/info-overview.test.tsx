/** Info › Overview and its "About this ferret" block: who the ferret is, where it works, where it came from. */

import { afterEach, describe, expect, it } from 'bun:test';
import { InfoOverview, type InfoOverviewProps } from '../../../../app/features/info/info-overview.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { ferretOf, NOW } from './fixtures.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const show = async (overrides: Partial<InfoOverviewProps> = {}) => {
  mounted = await mount(
    <InfoOverview
      ferret={ferretOf('f1', { title: 'Fix the login bug' })}
      name="Hadi"
      now={NOW}
      worktrees={null}
      write={async () => {}}
      {...overrides}
    />,
  );
  return mounted.container;
};

const row = (root: HTMLElement, label: string): string =>
  root.querySelector(`[data-info-row="${label}"] dd`)?.textContent ?? '';

describe('InfoOverview', () => {
  it('names the ferret, its task, state, folder, id and when it started', async () => {
    const root = await show();
    expect(row(root, 'Name')).toContain('Hadi');
    expect(row(root, 'Task')).toBe('Fix the login bug');
    expect(row(root, 'State')).toBe('Working');
    expect(row(root, 'Folder')).toContain('/work/app');
    expect(row(root, 'Ferret id')).toContain('f1');
    expect(row(root, 'Started')).toBe('2h ago');
    expect(row(root, 'In this state since')).toBe('1h ago');
    expect(row(root, 'Project')).toBe('Not in a project');
    expect(row(root, 'Started by')).toBe('Started by you');
  });

  it('says why a stopped ferret ended, and nothing for one that is still going', async () => {
    const ended = await show({
      ferret: ferretOf('f1', { state: 'stopped', cause: { kind: 'agent_crashed', exitCode: 2 } }),
    });
    expect(row(ended, 'Ended')).toBe('The agent exited with code 2');
    await mounted?.unmount();
    const going = await show();
    expect(going.querySelector('[data-info-row="Ended"]')).toBeNull();
  });

  it('does not invent a task or label the record does not carry', async () => {
    const root = await show({ ferret: ferretOf('f1') });
    expect(root.querySelector('[data-info-row="Task"]')).toBeNull();
    expect(root.querySelector('[data-info-row="Label"]')).toBeNull();
    expect(root.querySelector('[data-info-row="Pack"]')).toBeNull();
  });

  it('says the worktree is unknown until read, and the main checkout once read with none matching', async () => {
    expect(row(await show(), 'Worktree')).toBe('Unknown');
    await mounted?.unmount();
    expect(row(await show({ worktrees: [] }), 'Worktree')).toBe('Main checkout');
  });

  it('shows the managed worktree with its branch and whether it has uncommitted changes', async () => {
    const root = await show({
      ferret: ferretOf('f1', { folder: '/wt/app-feature' }),
      worktrees: [
        {
          path: '/wt/app-feature',
          branch: 'feature',
          live: { status: { staged: false, unstaged: false, untracked: true, conflicted: false } },
        },
      ],
    });
    expect(row(root, 'Worktree')).toContain('/wt/app-feature');
    expect(row(root, 'Worktree')).toContain('feature');
    expect(row(root, 'Worktree')).toContain('uncommitted changes');
  });

  it('links the parent by name when the host can navigate, and says an unlisted parent by id', async () => {
    const opened: string[] = [];
    const parent = ferretOf('p1', { name: 'rin' });
    const root = await show({
      ferret: ferretOf('f1', { parent: 'p1' }),
      ferrets: [parent],
      onOpenFerret: id => opened.push(id),
    });
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-ferret-link="p1"]'), 'link').click());
    expect(opened).toEqual(['p1']);
    expect(row(root, 'Started by')).toBe('Rin');
    await mounted?.unmount();
    expect(row(await show({ ferret: ferretOf('f1', { parent: 'p1' }) }), 'Started by')).toBe('p1');
  });

  it('offers Rename only when the host can open it', async () => {
    const renames: string[] = [];
    expect((await show()).querySelector('[data-info-rename]')).toBeNull();
    await mounted?.unmount();
    const root = await show({ onRename: () => renames.push('rename') });
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-rename]'), 'rename').click());
    expect(renames).toEqual(['rename']);
  });

  it('says a declared wait and a done ferret', async () => {
    const root = await show({
      ferret: ferretOf('f1', {
        waiting: { since: '2026-11-07T11:00:00.000Z', condition: 'CI' },
        finishedAt: '2026-11-07T11:30:00.000Z',
      }),
    });
    expect(row(root, 'State')).toContain('waiting: CI');
    expect(row(root, 'State')).toContain('said it is done');
  });
});

describe('InfoOverview — About this ferret', () => {
  it('lists the sub-ferrets it started and the card it works on', async () => {
    const root = await show({
      ferret: ferretOf('f1', { card: 'F12' }),
      ferrets: [ferretOf('c1', { name: 'sol', parent: 'f1' }), ferretOf('x', { parent: 'other' })],
    });
    const about = must(root.querySelector('[data-info-about]'), 'the about block');
    expect(about.textContent).toContain('Sub-ferrets (1)');
    expect(about.querySelectorAll('[data-sub-ferret]').length).toBe(1);
    expect(about.querySelector('[data-info-card="F12"]')?.textContent).toBe('F12');
  });

  it('says none, and draws no Card or Restart row, when there is nothing to say or do', async () => {
    const about = must((await show()).querySelector('[data-info-about]'), 'the about block');
    expect(about.textContent).toContain('None');
    expect(about.querySelector('[data-info-row="Card"]')).toBeNull();
    expect(about.querySelector('[data-info-restart]')).toBeNull();
  });

  it('restarts through the host’s Restart and is busy while it runs', async () => {
    let finish = (): void => {};
    const root = await show({
      about: {
        onRestart: () =>
          new Promise<boolean>(resolve => {
            finish = () => resolve(true);
          }),
      },
    });
    const button = must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart');
    await interact(() => button.click());
    expect(button.textContent).toBe('Restarting…');
    expect(button.disabled).toBe(true);
    await interact(() => finish());
    expect(button.textContent).toBe('Restart');
  });
});
