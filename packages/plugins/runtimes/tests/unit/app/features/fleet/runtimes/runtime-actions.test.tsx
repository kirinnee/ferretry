import { afterEach, describe, expect, it } from 'bun:test';
import type { MachineView, RunningSession } from '../../../../../../contract/index.ts';
import type { MoveConversation } from '../../../../../../app/features/fleet/runtimes/runtime-actions-model.ts';
import { interact, type Mounted, mount as mountView, must, pressKey } from '../../../../support/dom.ts';
import { chooseRuntimeAction, menuButton, openRuntimeMenu } from './runtime-menu-support.tsx';
import {
  type Call,
  CHANGE_ID,
  LANDED_FILE,
  machine,
  machineWith,
  READS,
  ROLLBACK_INCOMPLETE,
  ROLLED_BACK,
  type Route,
  scripted,
  stagedFrom,
  UNRESTORED_PATH,
} from '../account-support.ts';

const PROPOSE = 'POST /v1/runtimes/proposals';
const MOVE = 'POST /v1/ferrets/:ferretId/move';
const APPLY = `POST /v1/runtimes/proposals/${CHANGE_ID}/apply`;
/** The route key a call is recorded under: the template the half called, its parameter beside it. */
const APPLY_CALL = 'POST /v1/runtimes/proposals/:proposalId/apply';
const COMMITTED = {
  outcome: 'applied',
  apply: {
    outcome: 'committed',
    result: { accountCount: 4, operationCount: 3, manifestPath: '/m.json', prunedWrappers: [], sharedHistory: [] },
  },
};

/** Every view a test mounted: an open dialog left behind would answer a later test's Escape or Close. */
const mounted: Mounted[] = [];

const mount = async (element: Parameters<typeof mountView>[0]): Promise<Mounted> => {
  const view = await mountView(element);
  mounted.push(view);
  return view;
};

afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  window.location.hash = '';
  window.history.pushState({}, '', '/');
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (container: ParentNode, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
  await settle();
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const choose = async (select: HTMLSelectElement, value: string): Promise<void> => {
  await interact(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const text = (container: ParentNode, selector: string): string =>
  must(container.querySelector(selector), selector).textContent ?? '';

const proposed = (calls: readonly Call[]): unknown[] =>
  calls
    .filter(call => call.route === 'POST /v1/runtimes/proposals')
    .map(call => (call.body as { change: unknown }).change);

const FERRETS: readonly RunningSession[] = [
  { id: 's-1', name: 'Fisher', harness: 'claude-code' },
  { id: 's-2', name: 'Otter', harness: 'claude-code' },
];

/** A dry run of a removal that lists the ferrets on it, and its own consequence sentence. */
const removalStaged =
  (running: readonly RunningSession[] = FERRETS) =>
  (call: Call) => ({
    ...stagedFrom(call),
    summary: 'Remove runtime',
    consequences: [
      running.length === 0
        ? 'Nothing is running on it. Its past sessions stay in history.'
        : `${String(running.length)} ferrets are running on it. They keep running, but restarting them later needs another runtime. Its past sessions stay in history.`,
    ],
    preview: {
      kind: 'apply',
      operations: [],
      documents: [],
      runtimes: [],
      ...(running.length === 0 ? {} : { runningSessions: running }),
    },
  });

type MoveCall = [sessionId: string, runtime: string, conversation: MoveConversation];

interface TabOptions {
  readonly routes?: Record<string, Route>;
  readonly machine?: MachineView | null;
  readonly calls?: Call[];
  /** Offer the move of a ferret, answering with this (an Error refuses). */
  readonly move?: (call: MoveCall) => unknown;
  readonly moves?: MoveCall[];
  readonly refreshes?: string[];
}

const open = async (options: TabOptions = {}) => {
  const { RuntimesTab } = await import('../../../../../../app/features/fleet/runtimes/runtimes-tab.tsx');
  const client = scripted({ ...READS(), ...options.routes }, options.calls);
  const move = options.move;
  const moveFerret =
    move === undefined
      ? undefined
      : async (...call: MoveCall): Promise<void> => {
          options.moves?.push(call);
          const answer = move(call);
          if (answer instanceof Error) throw answer;
        };
  const view = await mount(
    <RuntimesTab
      client={client}
      moveFerret={moveFerret}
      machineName="studio-mac"
      machine={options.machine === undefined ? machine() : options.machine}
      online
      checking={false}
      onRetry={() => options.refreshes?.push('retry')}
      onRefresh={() => options.refreshes?.push('refresh')}
      pollMs={5}
    />,
  );
  await settle();
  return view;
};

const page = async (name: string, options: TabOptions = {}) => {
  window.location.hash = `#machines/studio-mac/runtimes/${name}`;
  return await open(options);
};

const renameInput = (container: ParentNode): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>('[data-runtime-rename-input]'), 'rename input');

const submit = (container: ParentNode): HTMLButtonElement =>
  must(
    [...container.querySelectorAll<HTMLButtonElement>('[data-runtime-dialog] [data-change-submit]')].at(-1),
    'submit',
  );

describe('Runtime actions: the buttons', () => {
  it('puts a ⋯ menu on every runtime row, with Rename and a destructive Remove inside', async () => {
    // Act
    const view = await open();

    // Assert
    expect(view.container.querySelectorAll('[data-runtime-card] [data-runtime-actions]')).toHaveLength(5);
    expect(view.container.querySelector('[data-runtime-card] [data-runtime-rename]')).toBeNull();
    const trigger = menuButton(view.container, 'codex-default');
    expect(trigger.getAttribute('aria-label')).toBe('Actions for codex-default');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const items = await openRuntimeMenu(view.container, 'codex-default');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(items.get('rename')?.textContent).toBe('Rename');
    expect(items.get('remove')?.textContent).toBe('Remove');
    expect(items.get('remove')?.className).toContain('text-err');
    expect(items.has('make-default')).toBe(false);
    expect(view.container.querySelector('[data-runtime-actions-refused]')).toBeNull();
  });

  it('opens the menu from the keyboard, moves with the arrows and closes on Escape with focus back on the button', async () => {
    // Arrange
    const view = await open();
    const trigger = menuButton(view.container, 'codex-default');

    // Act
    await interact(() => trigger.focus());
    await interact(() => trigger.click());
    await settle();
    const first = must(document.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]'), 'first item');
    expect(document.activeElement).toBe(first);
    await interact(() => pressKey(first, 'ArrowDown'));
    expect(document.activeElement?.getAttribute('data-menu-key')).toBe('remove');
    await interact(() => pressKey(document.activeElement as HTMLElement, 'Escape'));
    await settle();

    // Assert
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('puts both on a runtime’s own page too', async () => {
    // Act
    const view = await page('claude-agent');

    // Assert
    expect(view.container.querySelector('[data-runtime-page] [data-runtime-rename="claude-agent"]')).not.toBeNull();
    expect(view.container.querySelector('[data-runtime-page] [data-runtime-remove="claude-agent"]')).not.toBeNull();
  });

  it('disables both, with the reason, when this device may not change the fleet', async () => {
    // Arrange
    const refused = { 'GET /v1/runtimes/machine': machineWith({ mayApply: false, applyRefusal: 'not-granted' }) };

    // Act + Assert — the list first: the page below moves the location every mounted tab follows.
    const list = await open({ routes: refused });
    const trigger = menuButton(list.container, 'codex-default');
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toStartWith('The operator of this machine switched off');
    expect(text(list.container, '[data-runtime-actions-refused]')).toStartWith('Rename and Remove are off here: ');
    await list.unmount();
    mounted.splice(mounted.indexOf(list), 1);
    const detail = await page('claude-agent', { routes: refused });
    expect(must(detail.container.querySelector<HTMLButtonElement>('[data-runtime-remove]'), 'remove').disabled).toBe(
      true,
    );
    expect(detail.container.querySelector('[data-runtime-page] [data-runtime-actions-refused]')).not.toBeNull();
  });
});

describe('Runtime actions: Rename', () => {
  it('opens prefilled with the current name, saying nothing restarts', async () => {
    // Arrange
    const view = await open();

    // Act
    await chooseRuntimeAction(view.container, 'codex-default', 'rename');

    // Assert
    expect(text(view.container, '[data-runtime-dialog="rename"] h2')).toBe('Rename codex-default');
    expect(renameInput(view.container).value).toBe('codex-default');
    expect(text(view.container, '[data-runtime-rename-notes]')).toContain(
      'Running ferrets keep working — nothing restarts.',
    );
    expect(text(view.container, '[data-runtime-rename-notes]')).toContain('--agent codex-default still works');
    expect(submit(view.container).disabled).toBe(true);
  });

  it('checks the new name as it is typed, offering one that fits', async () => {
    // Arrange
    const view = await open();
    await chooseRuntimeAction(view.container, 'codex-default', 'rename');

    // Act + Assert
    await type(renameInput(view.container), 'claude-agent');
    expect(text(view.container, '[data-runtime-rename-problem]')).toContain(
      'claude-agent is already a runtime on studio-mac.',
    );
    expect(submit(view.container).disabled).toBe(true);
    await type(renameInput(view.container), 'My Codex');
    expect(text(view.container, '[data-runtime-rename-problem]')).toContain('Use only letters, digits and dashes.');
    await click(view.container, '[data-runtime-rename-suggestion]');
    expect(renameInput(view.container).value).toBe('my-codex');
    expect(submit(view.container).disabled).toBe(false);
    expect(submit(view.container).textContent).toBe('Rename to my-codex');
  });

  it('renames through one reviewed change and follows the runtime to its new page', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await page('codex-default', { calls, routes: { [PROPOSE]: stagedFrom, [APPLY]: COMMITTED } });
    await click(view.container, '[data-runtime-page] [data-runtime-rename]');
    await type(renameInput(view.container), 'codex-work');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(proposed(calls)).toEqual([{ kind: 'runtime.rename', name: 'codex-default', to: 'codex-work' }]);
    expect(calls.some(call => call.route === APPLY_CALL)).toBe(true);
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes/codex-work');
  });

  it('keeps the dialog open with the daemon’s refusal', async () => {
    // Arrange
    const refusal = Object.assign(new Error('old-name is already a runtime on studio-mac. Use old-name-2?'), {
      name: 'FyHttpError',
      status: 409,
      code: 'fleet_change_refused',
    });
    const view = await open({ routes: { [PROPOSE]: refusal } });
    await chooseRuntimeAction(view.container, 'codex-default', 'rename');
    await type(renameInput(view.container), 'old-name');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(view.container.querySelector('[data-runtime-dialog="rename"]')).not.toBeNull();
    expect(view.container.querySelector('[data-runtime-dialog] [data-change-refusal]')).not.toBeNull();
  });

  it('R3-M1: a rolled-back rename keeps the dialog open and names the file that stayed', async () => {
    // Arrange
    const view = await page('codex-default', { routes: { [PROPOSE]: stagedFrom, [APPLY]: ROLLED_BACK } });
    await click(view.container, '[data-runtime-page] [data-runtime-rename]');
    await type(renameInput(view.container), 'codex-work');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    const alert = must(view.container.querySelector('[data-runtime-dialog] [data-change-refusal]'), 'alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toStartWith('This change was not applied: the fleet apply failed and was rolled back.');
    expect(alert.textContent).toContain(LANDED_FILE);
    expect(view.container.querySelector('[data-runtime-dialog="rename"]')).not.toBeNull();
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes/codex-default');
  });

  it('R3-M1: a rollback-incomplete rename keeps the dialog open and names the paths left partly changed', async () => {
    // Arrange
    const view = await page('codex-default', { routes: { [PROPOSE]: stagedFrom, [APPLY]: ROLLBACK_INCOMPLETE } });
    await click(view.container, '[data-runtime-page] [data-runtime-rename]');
    await type(renameInput(view.container), 'codex-work');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    const said = text(view.container, '[data-runtime-dialog] [data-change-refusal]');
    expect(said).toContain('needs a look');
    expect(said).toContain(UNRESTORED_PATH);
    expect(said).toContain(LANDED_FILE);
    expect(view.container.querySelector('[data-runtime-dialog="rename"]')).not.toBeNull();
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes/codex-default');
  });

  it('R3-M1: a rolled-back removal keeps the dialog open, names the file that stayed, and removes nothing from the list', async () => {
    // Arrange
    const refreshes: string[] = [];
    const view = await page('codex-default', {
      refreshes,
      routes: { [PROPOSE]: removalStaged([]), [APPLY]: ROLLED_BACK },
    });
    await click(view.container, '[data-runtime-page] [data-runtime-remove]');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    const alert = must(view.container.querySelector('[data-runtime-dialog] [data-change-refusal]'), 'alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain(LANDED_FILE);
    expect(view.container.querySelector('[data-runtime-dialog]')).not.toBeNull();
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes/codex-default');
    expect(refreshes).not.toContain('refresh');
  });

  it('R3-M1: a rollback-incomplete removal keeps the dialog open and names the paths left partly changed', async () => {
    // Arrange
    const view = await page('codex-default', {
      routes: { [PROPOSE]: removalStaged([]), [APPLY]: ROLLBACK_INCOMPLETE },
    });
    await click(view.container, '[data-runtime-page] [data-runtime-remove]');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    const said = text(view.container, '[data-runtime-dialog] [data-change-refusal]');
    expect(said).toContain(UNRESTORED_PATH);
    expect(said).toContain(LANDED_FILE);
    expect(view.container.querySelector('[data-runtime-dialog]')).not.toBeNull();
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes/codex-default');
  });

  it('closes on Cancel and on Escape, changing nothing', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await open({ calls });

    // Act + Assert
    await chooseRuntimeAction(view.container, 'codex-default', 'rename');
    await click(view.container, '[data-runtime-dialog-cancel]');
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
    await chooseRuntimeAction(view.container, 'codex-default', 'rename');
    await interact(() => pressKey(must(view.container.querySelector('[data-runtime-dialog]'), 'dialog'), 'Escape'));
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
    expect(proposed(calls)).toEqual([]);
  });
});

describe('Runtime actions: Remove', () => {
  it('shows the impact from a dry run first: who is running on it, and that they keep running', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await open({ calls, routes: { [PROPOSE]: removalStaged() } });

    // Act
    await chooseRuntimeAction(view.container, 'codex-default', 'remove');

    // Assert
    expect(proposed(calls)).toEqual([{ kind: 'runtime.remove', name: 'codex-default' }]);
    expect(text(view.container, '[data-runtime-dialog="remove"] h2')).toBe('Remove codex-default?');
    expect(text(view.container, '[data-runtime-remove-impact]')).toContain(
      '2 ferrets are running on it. They keep running, but restarting them later needs another runtime.',
    );
    expect([...view.container.querySelectorAll('[data-runtime-running] li')].map(row => row.textContent)).toEqual([
      'FisherClaude Code',
      'OtterClaude Code',
    ]);
    expect(text(view.container, '[data-runtime-move-plan]')).toBe('They keep running until they end.');
    expect(submit(view.container).textContent).toBe('Remove codex-default');
    expect(submit(view.container).getAttribute('data-variant')).toBe('danger');
    expect(calls.some(call => call.route.endsWith('/apply'))).toBe(false);
  });

  it('removes exactly the change it previewed', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await open({ calls, routes: { [PROPOSE]: removalStaged([]), [APPLY]: COMMITTED } });
    await chooseRuntimeAction(view.container, 'codex-default', 'remove');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(proposed(calls)).toHaveLength(1);
    expect(calls.filter(call => call.route === APPLY_CALL)).toHaveLength(1);
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
  });

  it('leaves the runtime page once its runtime is removed', async () => {
    // Arrange
    const view = await page('codex-default', { routes: { [PROPOSE]: removalStaged([]), [APPLY]: COMMITTED } });
    await click(view.container, '[data-runtime-page] [data-runtime-remove]');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes');
  });

  it('R-0355 offers the move by default, and sends each ferret through Ferrets’ declared move route', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await open({
      calls,
      routes: { [PROPOSE]: removalStaged(), [APPLY]: COMMITTED, [MOVE]: { id: 's-1' } },
    });
    await chooseRuntimeAction(view.container, 'claude-work', 'remove');

    // Act
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'move target'),
      'codex-default',
    );
    await interact(() => submit(view.container).click());
    await settle();

    // Assert — one move per ferret, then the removal is staged afresh
    expect(calls.filter(call => call.route === MOVE).map(call => [call.params, call.body])).toEqual([
      [
        { ferretId: 's-1' },
        { agent: 'codex-default', allowContextDowngrade: false, forceInflight: false, conversation: 'convert' },
      ],
      [
        { ferretId: 's-2' },
        { agent: 'codex-default', allowContextDowngrade: false, forceInflight: false, conversation: 'convert' },
      ],
    ]);
    expect(proposed(calls)).toHaveLength(2);
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
  });

  it('R-0355 shows a refusal from Ferrets’ move as the sentence it gave, and removes nothing', async () => {
    // Arrange — Ferrets' resume and launch ports may still refuse (unbound); the dialog says so as it says any refusal.
    const calls: Call[] = [];
    const refusal = Object.assign(new Error('refused'), {
      status: 409,
      code: 'move_refused',
      message: 'Ferrets cannot start a ferret on another runtime yet.',
    });
    const view = await open({
      calls,
      routes: { [PROPOSE]: removalStaged(), [APPLY]: COMMITTED, [MOVE]: refusal },
    });
    await chooseRuntimeAction(view.container, 'claude-work', 'remove');
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'move target'),
      'claude-review',
    );

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(calls.some(call => call.route.endsWith('/apply'))).toBe(false);
    expect(text(view.container, '[data-runtime-move-failed]')).toContain(
      '2 ferrets could not be moved, so claude-work was not removed.',
    );
    expect(text(view.container, '[data-runtime-move-failed]')).toContain(
      'Fisher: Ferrets cannot start a ferret on another runtime yet.',
    );
  });

  it('moves every ferret to the picked runtime, carrying each conversation, before it removes', async () => {
    // Arrange
    const calls: Call[] = [];
    const moves: MoveCall[] = [];
    const view = await open({
      calls,
      moves,
      move: () => ({}),
      routes: { [PROPOSE]: removalStaged(), [APPLY]: COMMITTED },
    });
    await chooseRuntimeAction(view.container, 'claude-work', 'remove');
    const select = must(view.container.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'move target');

    // Act
    expect([...select.options].map(option => option.value)).toEqual([
      '',
      'claude-default',
      'claude-agent',
      'claude-review',
      'codex-default',
    ]);
    await choose(select, 'codex-default');
    expect(text(view.container, '[data-runtime-move-plan]')).toBe(
      '2 ferrets restart on codex-default first, each with its conversation, then the runtime is removed.',
    );
    expect(submit(view.container).textContent).toBe('Move 2 ferrets to codex-default and remove claude-work');
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(moves.map(([id, runtime, conversation]) => [id, runtime, conversation])).toEqual([
      ['s-1', 'codex-default', 'convert'],
      ['s-2', 'codex-default', 'convert'],
    ]);
    expect(proposed(calls)).toEqual([
      { kind: 'runtime.remove', name: 'claude-work' },
      { kind: 'runtime.remove', name: 'claude-work' },
    ]);
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
  });

  it('resumes a ferret moved to a runtime on the same CLI', async () => {
    // Arrange
    const moves: MoveCall[] = [];
    const view = await open({
      moves,
      move: () => ({}),
      routes: { [PROPOSE]: removalStaged([FERRETS[0] as RunningSession]), [APPLY]: COMMITTED },
    });
    await chooseRuntimeAction(view.container, 'claude-work', 'remove');

    // Act
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'move target'),
      'claude-review',
    );
    expect(submit(view.container).textContent).toBe('Move 1 ferret to claude-review and remove claude-work');
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(moves.map(call => call[2])).toEqual(['resume']);
  });

  it('removes nothing while a ferret it was asked to move is still on it', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await open({
      calls,
      move: ([id]) => (id === 's-2' ? new Error('The session is mid-turn.') : {}),
      routes: { [PROPOSE]: removalStaged(), [APPLY]: COMMITTED },
    });
    await chooseRuntimeAction(view.container, 'claude-work', 'remove');
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'move target'),
      'claude-review',
    );

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(calls.some(call => call.route.endsWith('/apply'))).toBe(false);
    expect(text(view.container, '[data-runtime-move-failed]')).toContain(
      'One ferret could not be moved, so claude-work was not removed.',
    );
    expect(text(view.container, '[data-runtime-move-failed]')).toContain('Otter');
    expect(submit(view.container).textContent).toBe('Remove claude-work');
  });

  it('asks for another default first when it is the machine’s default runtime', async () => {
    // Arrange
    const calls: Call[] = [];
    const refreshes: string[] = [];
    const view = await open({
      calls,
      refreshes,
      machine: machine({ defaultRuntime: 'claude-agent' }),
      routes: {
        [PROPOSE]: (call: Call) =>
          (call.body as { change: { kind: string } }).change.kind === 'runtime.remove'
            ? removalStaged([])(call)
            : stagedFrom(call),
        [APPLY]: COMMITTED,
      },
    });
    await chooseRuntimeAction(view.container, 'claude-agent', 'remove');

    // Assert — nothing is staged until a default is picked; only agent runtimes are offered.
    expect(text(view.container, '[data-runtime-remove-default]')).toBe(
      'claude-agent is studio-mac’s default runtime for new agents. Pick another default first.',
    );
    expect(proposed(calls)).toEqual([]);
    expect(view.container.querySelector('[data-runtime-default-picker]')).toBeNull();
    expect(text(view.container, '[data-runtime-remove-no-default]')).toBe(
      'There is no other agent runtime to make the default. Add one first.',
    );
    expect(refreshes).toEqual([]);
  });

  it('makes the picked runtime the default, then shows what removing this one does', async () => {
    // Arrange
    const calls: Call[] = [];
    const refreshes: string[] = [];
    const view = await open({
      calls,
      refreshes,
      routes: {
        [PROPOSE]: (call: Call) =>
          (call.body as { change: { kind: string } }).change.kind === 'runtime.remove'
            ? removalStaged([])(call)
            : stagedFrom(call),
        [APPLY]: COMMITTED,
        'GET /v1/runtimes': {
          format: 'present',
          runtimes: [...(READS()['GET /v1/runtimes'] as { runtimes: unknown[] }).runtimes].map(entry => ({
            ...(entry as object),
            agent: true,
          })),
        },
      },
    });
    await chooseRuntimeAction(view.container, 'claude-default', 'remove');
    expect(text(view.container, '[data-runtime-dialog] [data-change-submit]')).toBe('Make codex-default the default');

    // Act
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('[data-runtime-default-picker]'), 'picker'),
      'claude-agent',
    );
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(proposed(calls)).toEqual([
      {
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: 'claude-agent',
        agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
        browserMode: 'headless',
        browserProxy: null,
        browserPorts: 'random',
        browserFirewallFailure: 'warn',
        autoResume: true,
        agendaMode: false,
        publicUsageFeed: false,
      },
      { kind: 'runtime.remove', name: 'claude-default' },
    ]);
    expect(refreshes).toEqual(['refresh']);
    expect(text(view.container, '[data-runtime-remove-impact]')).toBe(
      'Nothing is running on it. Its past sessions stay in history.',
    );
  });

  it('R3-M1: a rolled-back default change stays on the pick step and names the file that stayed', async () => {
    // Arrange
    const refreshes: string[] = [];
    const view = await open({
      refreshes,
      routes: {
        [PROPOSE]: (call: Call) =>
          (call.body as { change: { kind: string } }).change.kind === 'runtime.remove'
            ? removalStaged([])(call)
            : stagedFrom(call),
        [APPLY]: ROLLED_BACK,
        'GET /v1/runtimes': {
          format: 'present',
          runtimes: [...(READS()['GET /v1/runtimes'] as { runtimes: unknown[] }).runtimes].map(entry => ({
            ...(entry as object),
            agent: true,
          })),
        },
      },
    });
    await chooseRuntimeAction(view.container, 'claude-default', 'remove');
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('[data-runtime-default-picker]'), 'picker'),
      'claude-agent',
    );

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(text(view.container, '[data-runtime-dialog] [data-change-refusal]')).toContain(LANDED_FILE);
    expect(view.container.querySelector('[data-runtime-default-picker]')).not.toBeNull();
    expect(view.container.querySelector('[data-runtime-remove-impact]')).toBeNull();
    expect(refreshes).not.toContain('refresh');
  });

  it('says why when the dry run itself is refused', async () => {
    // Arrange
    const view = await open({ routes: { [PROPOSE]: new Error('the machine is asleep') } });

    // Act
    await chooseRuntimeAction(view.container, 'codex-default', 'remove');

    // Assert
    expect(view.container.querySelector('[data-runtime-remove-refused]')).not.toBeNull();
    await click(view.container, '[data-runtime-dialog-cancel]');
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
  });
});
