import { afterEach, describe, expect, it } from 'bun:test';
import { type BoardProject, boardErr, boardOk, LANE_TEMPLATES, type LaneSet } from '@ferretry/protocol';
import type { ReactElement } from 'react';

import { LaneEditor, LaneEditorPage } from '../../../src/features/projects/lane-editor.tsx';
import type { BoardActions } from '../../../src/lib/board-actions.ts';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { type AppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { ferretNamer } from '../../../src/lib/board-present.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { fakeEnvironment, fakePort, laneSetFor, laptop, PROJECT } from '../board-support.ts';

type Actions = Pick<BoardActions, 'acceptLanes' | 'saveLanes' | 'adoptTemplate'>;

interface Recorded extends Actions {
  readonly calls: unknown[];
}

const recorder = (fail?: { code: string | null; message: string }): Recorded => {
  const calls: unknown[] = [];
  const answer = async (call: unknown) => {
    calls.push(call);
    return fail === undefined ? boardOk(laneSetFor()) : boardErr({ status: 409, ...fail });
  };
  return {
    calls,
    adoptTemplate: (_daemon, projectId, template) => answer({ adopt: template, projectId }),
    saveLanes: (_daemon, projectId, edit) => answer({ save: edit, projectId }),
    acceptLanes: (_daemon, projectId, version) => answer({ accept: version, projectId }),
  };
};

const proposed = (): LaneSet => ({ ...laneSetFor(), confirmedBy: null, proposedBy: 'mvuc7tsf-0c3d50df' });

const projectOf = (laneSet: LaneSet | null): BoardProject => ({
  id: PROJECT,
  name: 'ferretry',
  path: '/work/ferretry',
  laneSet,
});

let open: Mounted | null = null;
afterEach(async () => {
  await open?.unmount();
  open = null;
  window.history.replaceState({}, '', '/');
});

const show = async (element: ReactElement): Promise<Mounted> => {
  open = await mount(element);
  return open;
};

const names = ferretNamer(new Map([['mvuc7tsf-0c3d50df', 'denisha']]));

const editor = (laneSet: LaneSet | null, actions: Actions = recorder(), onReload = () => undefined) => (
  <LaneEditor
    actions={actions}
    daemonId={laptop.daemonId}
    names={names}
    onReload={onReload}
    project={projectOf(laneSet)}
  />
);

const click = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const nativeInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const nativeSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

const type = async (input: Element, text: string): Promise<void> => {
  await interact(() => {
    nativeInput?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const choose = async (select: Element, value: string): Promise<void> => {
  await interact(() => {
    nativeSelect?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const byLabel = (view: Mounted, label: string): HTMLElement =>
  must(view.container.querySelector<HTMLElement>(`[aria-label="${label}"]`), label);

const buttonSaying = (view: Mounted, text: string): HTMLButtonElement =>
  must(
    [...view.container.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === text),
    `the “${text}” button`,
  );

const problems = (view: Mounted): string => view.container.querySelector('[data-lane-problems]')?.textContent ?? '';

describe('the template picker', () => {
  it('previews all six templates as chips for a project with no lanes', async () => {
    // Act
    const view = await show(editor(null));

    // Assert
    const items = [...view.container.querySelectorAll('[data-lane-template]')];
    expect(items.map(item => item.getAttribute('data-lane-template'))).toEqual(Object.keys(LANE_TEMPLATES));
    expect(items).toHaveLength(6);
    const quick = must(view.container.querySelector('[data-lane-template="quick"]'), 'the quick template');
    expect([...quick.querySelectorAll('li')].map(chip => chip.textContent)).toEqual(
      LANE_TEMPLATES.quick.lanes.map(lane => lane.name),
    );
  });

  it('adopts the picked template for this project', async () => {
    // Arrange
    const actions = recorder();
    const view = await show(editor(null, actions));

    // Act
    await click(buttonSaying(view, 'Use Quick'));

    // Assert
    expect(actions.calls).toEqual([{ adopt: 'quick', projectId: PROJECT }]);
    expect(view.container.querySelector('[data-lane-failure]')).toBeNull();
  });

  it('says why a template could not be adopted', async () => {
    // Arrange
    const actions = recorder({ code: 'owner-only', message: 'no' });
    const view = await show(editor(null, actions));

    // Act
    await click(buttonSaying(view, 'Use Quick'));

    // Assert
    expect(view.container.querySelector('[data-lane-failure]')?.textContent).toBe(
      'Only the owner can change confirmed lanes.',
    );
  });
});

describe('editing the lanes', () => {
  it('starts clean: nothing to save or discard, and no problems', async () => {
    // Act
    const view = await show(editor(laneSetFor()));

    // Assert
    expect(buttonSaying(view, 'Save lanes').disabled).toBe(true);
    expect(buttonSaying(view, 'Discard changes').disabled).toBe(true);
    expect(view.container.querySelector('[data-lane-problems]')).toBeNull();
    expect(view.container.querySelector('[data-lane-banner]')).toBeNull();
    expect(view.container.textContent).toContain('Version 1 · confirmed');
  });

  it('renames a lane without changing its id and saves the edit against the version it saw', async () => {
    // Arrange
    const actions = recorder();
    const view = await show(editor(laneSetFor(), actions));

    // Act
    await type(byLabel(view, 'Name of lane implement'), 'Build');
    await click(buttonSaying(view, 'Save lanes'));

    // Assert
    const call = actions.calls[0] as { save: { version: number; layout: { lanes: { id: string; name: string }[] } } };
    expect(call.save.version).toBe(1);
    expect(call.save.layout.lanes.find(lane => lane.id === 'implement')?.name).toBe('Build');
  });

  it('changes the category, the triggers, the owner gate and the stale time of a lane', async () => {
    // Arrange
    const actions = recorder();
    const view = await show(editor(laneSetFor(), actions));
    const row = must(view.container.querySelector('[data-lane-row="implement"]'), 'the implement row');

    // Act
    await choose(byLabel(view, 'Category of Implement'), 'review');
    const triggers = must(row.querySelector('[data-lane-triggers]'), 'the trigger list');
    const trigger = [...triggers.querySelectorAll('button')].find(node => node.textContent === 'a PR opens');
    await click(must(trigger, 'the PR opens trigger'));
    const already = [...triggers.querySelectorAll('button')].find(node => node.textContent === 'work starts');
    await click(must(already, 'the work starts trigger'));
    await click(must(row.querySelector('input[type="checkbox"]'), 'the owner gate'));
    await type(byLabel(view, 'Stale after for Implement'), '6h');
    await click(buttonSaying(view, 'Save lanes'));

    // Assert
    const call = actions.calls[0] as {
      save: {
        layout: {
          lanes: { id: string; category: string; enterOn?: string[]; ownerGate?: boolean; staleAfter?: string }[];
        };
      };
    };
    const saved = must(
      call.save.layout.lanes.find(lane => lane.id === 'implement'),
      'the saved lane',
    );
    expect(saved.category).toBe('review');
    expect(saved.enterOn).toEqual(['pr.opened']);
    expect(saved.ownerGate).toBe(true);
    expect(saved.staleAfter).toBe('6h');
  });

  it('shows what a lane is entered on, or that it is manual only', async () => {
    // Act
    const view = await show(editor(laneSetFor()));

    // Assert
    const summary = (id: string) => view.container.querySelector(`[data-lane-triggers="${id}"] summary`)?.textContent;
    expect(summary('implement')).toBe('Moves a card in when: work starts');
    expect(summary('todo')).toBe('Moves a card in when: nothing (you move it by hand)');
    expect(summary('review')).toBe('Moves a card in when: a PR opens, a PR is ready, the ferret says done');
  });

  it('names categories and the owner gate in plain words', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));

    // Act
    const options = [...byLabel(view, 'Category of Implement').querySelectorAll('option')].map(
      node => node.textContent,
    );
    const gate = must(
      [...view.container.querySelectorAll('label')].find(node => node.textContent === 'Only you move it on'),
      'the gate label',
    );
    const closedGate = must(
      view.container.querySelector('[data-lane-row="closed"] label[title]'),
      'the closed lane gate label',
    );

    // Assert
    expect(options).toEqual(['Backlog', 'Active', 'In review', 'Shipped', 'To test (verify)', 'Closed']);
    expect(gate.title).toBe('The owner must move cards out of this lane.');
    expect(closedGate.getAttribute('title')).toBe('The owner must move cards into this lane.');
    expect(view.container.textContent).toContain('Stale after');
  });

  it('draws the delete buttons neutral until they are hovered', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));

    // Act
    const button = byLabel(view, 'Delete Implement');

    // Assert
    expect(button.getAttribute('data-variant')).toBeNull();
    expect(button.className).toContain('hover:text-err');
  });

  it('reorders lanes and stops at both ends', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));
    const order = () =>
      [...view.container.querySelectorAll('[data-lane-row]')].map(row => row.getAttribute('data-lane-row'));
    const before = order();

    // Act
    await click(byLabel(view, 'Move Implement up'));

    // Assert
    expect((byLabel(view, 'Move Todo up') as HTMLButtonElement).disabled).toBe(true);
    const lanes = LANE_TEMPLATES['pr-release-verify'].lanes;
    const last = lanes[lanes.length - 1]?.name ?? '';
    expect((byLabel(view, `Move ${last} down`) as HTMLButtonElement).disabled).toBe(true);
    const after = order();
    expect(after).not.toEqual(before);
    expect(after.indexOf('implement')).toBe(before.indexOf('implement') - 1);
  });

  it('adds a lane with a fresh id and stops at the lane limit', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));
    const count = () => view.container.querySelectorAll('[data-lane-row]').length;
    const start = count();

    // Act
    await click(buttonSaying(view, 'Add lane'));

    // Assert
    expect(count()).toBe(start + 1);
    for (let index = count(); index < 16; index += 1) await click(buttonSaying(view, 'Add lane'));
    expect(count()).toBe(16);
    expect(buttonSaying(view, 'Add lane').disabled).toBe(true);
    const ids = [...view.container.querySelectorAll('[data-lane-row]')].map(row => row.getAttribute('data-lane-row'));
    expect(new Set(ids).size).toBe(16);
  });

  it('discards the draft back to the saved lanes', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));
    await type(byLabel(view, 'Name of lane implement'), 'Build');

    // Act
    await click(buttonSaying(view, 'Discard changes'));

    // Assert
    expect((byLabel(view, 'Name of lane implement') as HTMLInputElement).value).toBe('Implement');
    expect(buttonSaying(view, 'Save lanes').disabled).toBe(true);
  });

  it('shows a workflow that skips a lane differently from one that walks it', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));

    // Act
    const skipped = byLabel(view, 'quick walks Plan/Design');
    const walked = byLabel(view, 'quick walks Review/CI');

    // Assert
    expect(skipped.getAttribute('aria-pressed')).toBe('false');
    expect(skipped.className).toContain('line-through');
    expect(walked.className).not.toContain('line-through');
    expect(byLabel(view, 'design-first walks Plan/Design').getAttribute('aria-pressed')).toBe('true');
  });

  it('lets a workflow skip a lane', async () => {
    // Arrange
    const actions = recorder();
    const view = await show(editor(laneSetFor(), actions));
    const chip = byLabel(view, 'quick walks Review/CI');
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    // Act
    await click(chip);
    await click(buttonSaying(view, 'Save lanes'));

    // Assert
    expect(byLabel(view, 'quick walks Review/CI').getAttribute('aria-pressed')).toBe('false');
    const call = actions.calls[0] as { save: { layout: { variants: Record<string, string[]> } } };
    expect(call.save.layout.variants.quick).not.toContain('review');
  });
});

describe('live validation', () => {
  it('names a problem as it appears and blocks saving until it is fixed', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));

    // Act
    await type(byLabel(view, 'Name of lane implement'), '');

    // Assert
    expect(problems(view).length).toBeGreaterThan(0);
    expect(buttonSaying(view, 'Save lanes').disabled).toBe(true);
    expect(byLabel(view, 'Name of lane implement').getAttribute('aria-invalid')).toBe('true');

    await type(byLabel(view, 'Name of lane implement'), 'Build');
    expect(view.container.querySelector('[data-lane-problems]')).toBeNull();
    expect(buttonSaying(view, 'Save lanes').disabled).toBe(false);
  });

  it('refuses a stale-after that is not a duration', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));

    // Act
    await type(byLabel(view, 'Stale after for Implement'), 'soon');

    // Assert
    expect(problems(view).length).toBeGreaterThan(0);
    expect(byLabel(view, 'Stale after for Implement').getAttribute('aria-invalid')).toBe('true');
    expect(buttonSaying(view, 'Save lanes').disabled).toBe(true);
  });
});

describe('deleting a lane', () => {
  it('needs a lane for its cards before it will delete', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));

    // Act
    await click(byLabel(view, 'Delete Implement'));

    // Assert
    const prompt = must(view.container.querySelector('[data-lane-delete="implement"]'), 'the delete prompt');
    const confirm = must(
      [...prompt.querySelectorAll('button')].find(node => node.textContent === 'Delete lane'),
      'the delete button',
    );
    expect(confirm.disabled).toBe(true);
    const targets = [...prompt.querySelectorAll('option')].map(option => option.value);
    expect(targets).not.toContain('implement');
    expect(targets).toContain('review');

    await choose(byLabel(view, 'Where its cards go'), 'review');
    expect(confirm.disabled).toBe(false);
  });

  it('removes the lane, sends where its cards go, and closes the prompt', async () => {
    // Arrange
    const actions = recorder();
    const view = await show(editor(laneSetFor(), actions));
    await click(byLabel(view, 'Delete Implement'));
    await choose(byLabel(view, 'Where its cards go'), 'review');

    // Act
    await click(buttonSaying(view, 'Delete lane'));
    await click(buttonSaying(view, 'Save lanes'));

    // Assert
    expect(view.container.querySelector('[data-lane-delete]')).toBeNull();
    expect(view.container.querySelector('[data-lane-row="implement"]')).toBeNull();
    const call = actions.calls[0] as { save: { relocate: Record<string, string> } };
    expect(call.save.relocate).toEqual({ implement: 'review' });
  });

  it('keeps the lane when the prompt is cancelled', async () => {
    // Arrange
    const view = await show(editor(laneSetFor()));
    await click(byLabel(view, 'Delete Implement'));

    // Act
    await click(buttonSaying(view, 'Cancel'));

    // Assert
    expect(view.container.querySelector('[data-lane-delete]')).toBeNull();
    expect(view.container.querySelector('[data-lane-row="implement"]')).not.toBeNull();
  });

  it('does not offer to delete the only lane', async () => {
    // Arrange
    const only = { ...laneSetFor(), lanes: [laneSetFor().lanes[0] as LaneSet['lanes'][number]], variants: {} };

    // Act
    const view = await show(editor(only));

    // Assert
    expect((byLabel(view, `Delete ${only.lanes[0]?.name}`) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('an unconfirmed set', () => {
  it('says who proposed it and accepts it as it stands', async () => {
    // Arrange
    const actions = recorder();
    const view = await show(editor(proposed(), actions));

    // Act
    const banner = must(view.container.querySelector('[data-lane-banner="unconfirmed"]'), 'the banner');
    await click(must(banner.querySelector('button'), 'Accept'));

    // Assert
    expect(banner.textContent).toContain('Proposed by Denisha · not confirmed yet');
    expect(actions.calls).toEqual([{ accept: 1, projectId: PROJECT }]);
    expect(view.container.textContent).toContain('Version 1 · proposed');
  });

  it('will not accept while there are unsaved edits', async () => {
    // Arrange
    const view = await show(editor(proposed()));

    // Act
    await type(byLabel(view, 'Name of lane implement'), 'Build');

    // Assert
    expect(buttonSaying(view, 'Accept').disabled).toBe(true);
  });
});

describe('a ferret’s change waiting for the owner', () => {
  const waiting = (): LaneSet => {
    const live = laneSetFor();
    return {
      ...live,
      pending: {
        version: live.version + 1,
        baseVersion: live.version,
        proposedBy: 'mvuc7tsf-0c3d50df',
        lanes: live.lanes.map(lane => (lane.id === 'implement' ? { ...lane, name: 'Build' } : lane)),
        variants: live.variants,
        doneLane: live.doneLane,
        notGoodLane: live.notGoodLane,
        relocate: {},
      },
    };
  };

  it('says who proposed it, that the board keeps its lanes, and accepts the proposal by its own version', async () => {
    // Arrange
    const actions = recorder();
    const view = await show(editor(waiting(), actions));

    // Act
    const banner = must(view.container.querySelector('[data-lane-banner="pending"]'), 'the banner');
    await click(must(banner.querySelector('button'), 'Accept'));

    // Assert
    expect(banner.textContent).toContain('Proposed by Denisha, waiting for you');
    expect(banner.textContent).toContain('Build');
    expect(banner.textContent).toContain('the board keeps the lanes below until you accept');
    expect(view.container.querySelector('[data-lane-banner="unconfirmed"]')).toBeNull();
    expect(actions.calls).toEqual([{ accept: 2, projectId: PROJECT }]);
  });

  it('shows no banner when nothing waits', async () => {
    const view = await show(editor(laneSetFor()));

    expect(view.container.querySelector('[data-lane-banner="pending"]')).toBeNull();
  });
});

describe('a refused write', () => {
  it('says what happened and offers Reload when the lanes moved on', async () => {
    // Arrange
    const actions = recorder({ code: 'version-conflict', message: 'moved' });
    let reloads = 0;
    const view = await show(
      editor(laneSetFor(), actions, () => {
        reloads += 1;
      }),
    );
    await type(byLabel(view, 'Name of lane implement'), 'Build');

    // Act
    await click(buttonSaying(view, 'Save lanes'));

    // Assert
    expect(view.container.querySelector('[data-lane-failure]')?.textContent).toContain('These lanes changed');
    await click(buttonSaying(view, 'Reload'));
    expect(reloads).toBe(1);
    expect(buttonSaying(view, 'Save lanes').disabled).toBe(false);
  });

  it('shows the refusal as the daemon worded it when it has no sentence of its own, and clears it on the next edit', async () => {
    // Arrange
    const actions = recorder({ code: null, message: 'the daemon said no' });
    const view = await show(editor(proposed(), actions));

    // Act
    await click(buttonSaying(view, 'Accept'));

    // Assert
    expect(view.container.querySelector('[data-lane-failure]')?.textContent).toBe('the daemon said no');
    expect(view.container.querySelector('[data-lane-failure] button')).toBeNull();

    await type(byLabel(view, 'Name of lane implement'), 'Build');
    expect(view.container.querySelector('[data-lane-failure]')).toBeNull();
  });
});

describe('the lane editor page', () => {
  const pageFor = (
    lanes: (() => Promise<readonly BoardProject[] | null>) | undefined,
    projectId: string,
    port = fakePort({ projects: lanes === undefined ? undefined : async () => await lanes() }),
  ): ReactElement => {
    const store = {
      board: new DaemonBoardStore(port, fakeEnvironment()),
      attention: { respond: async () => undefined },
    } as unknown as AppStore;
    return (
      <StoreProvider store={store}>
        <RouterProvider>
          <LaneEditorPage callsigns={new Map()} connection={laptop} projectId={projectId} />
        </RouterProvider>
      </StoreProvider>
    );
  };

  const settle = async (): Promise<void> => {
    await interact(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
  };

  it('shows the project’s editor once its lanes are read', async () => {
    // Act
    const view = await show(pageFor(async () => [projectOf(proposed())], PROJECT));
    await settle();

    // Assert
    expect(view.container.querySelector(`[data-lane-page="${PROJECT}"]`)).not.toBeNull();
    expect(view.container.querySelector('h1')?.textContent).toBe('Lanes · ferretry');
    expect(view.container.querySelector('[data-lane-banner="unconfirmed"]')).not.toBeNull();
  });

  it('offers the template picker for a project with no lanes', async () => {
    // Act
    const view = await show(pageFor(async () => [projectOf(null)], PROJECT));
    await settle();

    // Assert
    expect(view.container.querySelectorAll('[data-lane-template]')).toHaveLength(6);
  });

  it('says so while the lanes are being read', async () => {
    // Act
    const view = await show(pageFor(() => new Promise(() => undefined), PROJECT));

    // Assert
    expect(view.container.textContent).toContain('Loading lanes…');
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('says so when the machine does not serve board lanes', async () => {
    // Act
    const view = await show(pageFor(async () => null, PROJECT));
    await settle();

    // Assert
    expect(view.container.textContent).toContain('This machine does not serve board lanes yet.');
  });

  it('says so when the read failed', async () => {
    // Act
    const view = await show(
      pageFor(async () => {
        throw new Error('offline');
      }, PROJECT),
    );
    await settle();

    // Assert
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not read this machine’s lanes',
    );
  });

  it('says so when the machine has no project with that id', async () => {
    // Act
    const view = await show(pageFor(async () => [projectOf(proposed())], '00000000-0000-4000-8000-0000000000ff'));
    await settle();

    // Assert
    expect(view.container.querySelector('[data-lane-page-missing]')).not.toBeNull();
  });

  it('sends Back to the project, or to the projects list for the Unfiled board', async () => {
    // Arrange
    const view = await show(pageFor(async () => [projectOf(proposed())], PROJECT));
    await settle();

    // Act
    await click(buttonSaying(view, 'Back'));

    // Assert
    expect(window.location.pathname).toBe(`/d/${encodeURIComponent(laptop.daemonId)}/projects/${PROJECT}`);

    // Act
    const unfiled = await show(pageFor(async () => [projectOf(proposed())], 'unfiled'));
    await settle();
    await click(buttonSaying(unfiled, 'Back'));

    // Assert
    expect(window.location.pathname).toBe(`/d/${encodeURIComponent(laptop.daemonId)}/projects`);
  });
});
