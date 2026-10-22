import { afterEach, describe, expect, it } from 'bun:test';
import type { FleetMachineView, FleetRunningSession, IFyApiClient } from '@ferretry/protocol';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { RuntimesTab } from '../../../../../src/features/fleet/runtimes/runtimes-tab.tsx';
import { interact, type Mounted, mount as mountView, must, pressKey } from '../../../../support/dom.ts';
import {
  type Call,
  CHANGE_ID,
  machine,
  machineWith,
  READS,
  type Route,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';

const PROPOSE = 'POST /v1/fleet/proposals';
const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;
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
  calls.filter(call => call.path === '/v1/fleet/proposals').map(call => (call.body as { change: unknown }).change);

const FERRETS: readonly FleetRunningSession[] = [
  { id: 's-1', name: 'Fisher', harness: 'claude' },
  { id: 's-2', name: 'Otter', harness: 'claude' },
];

/** A dry run of a removal that lists the ferrets on it, and its own consequence sentence. */
const removalStaged =
  (running: readonly FleetRunningSession[] = FERRETS) =>
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

type MigrateCall = Parameters<IFyApiClient['migrate']>;

interface TabOptions {
  readonly routes?: Record<string, Route>;
  readonly machine?: FleetMachineView | null;
  readonly calls?: Call[];
  /** Offer `migrate` on the client, answering with this (an Error refuses). */
  readonly migrate?: (call: MigrateCall) => unknown;
  readonly migrations?: MigrateCall[];
  readonly refreshes?: string[];
}

const open = async (options: TabOptions = {}) => {
  const scriptedClient = scripted({ ...READS(), ...options.routes }, options.calls);
  const migrate = options.migrate;
  const client: FleetClient =
    migrate === undefined
      ? scriptedClient
      : {
          ...scriptedClient,
          migrate: async (...call: MigrateCall) => {
            options.migrations?.push(call);
            const answer = migrate(call);
            if (answer instanceof Error) throw answer;
            return answer as never;
          },
        };
  const view = await mount(
    <RuntimesTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={options.machine === undefined ? machine() : options.machine}
      online
      checking={false}
      onRetry={() => options.refreshes?.push('retry')}
      onRefresh={() => options.refreshes?.push('refresh')}
      createClient={async () => client}
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
  it('puts Rename and a destructive Remove on every runtime row', async () => {
    // Act
    const view = await open();

    // Assert
    expect(view.container.querySelectorAll('[data-runtime-actions]')).toHaveLength(5);
    const remove = must(view.container.querySelector('[data-runtime-remove="codex-default"]'), 'remove');
    expect(remove.getAttribute('data-variant')).toBe('danger');
    expect(remove.getAttribute('aria-label')).toBe('Remove codex-default');
    expect(text(view.container, '[data-runtime-rename="codex-default"]')).toBe('Rename');
    expect(view.container.querySelector('[data-runtime-actions-refused]')).toBeNull();
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
    const refused = { 'GET /v1/fleet/machine': machineWith({ mayApply: false, applyRefusal: 'not-granted' }) };

    // Act + Assert — the list first: the page below moves the location every mounted tab follows.
    const list = await open({ routes: refused });
    const rename = must(list.container.querySelector<HTMLButtonElement>('[data-runtime-rename]'), 'rename');
    expect(rename.disabled).toBe(true);
    expect(rename.title.length).toBeGreaterThan(0);
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
    await click(view.container, '[data-runtime-rename="codex-default"]');

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
    await click(view.container, '[data-runtime-rename="codex-default"]');

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
    expect(calls.some(call => call.path === `/v1/fleet/proposals/${CHANGE_ID}/apply`)).toBe(true);
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
    await click(view.container, '[data-runtime-rename="codex-default"]');
    await type(renameInput(view.container), 'old-name');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(view.container.querySelector('[data-runtime-dialog="rename"]')).not.toBeNull();
    expect(view.container.querySelector('[data-runtime-dialog] [data-change-refusal]')).not.toBeNull();
  });

  it('closes on Cancel and on Escape, changing nothing', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await open({ calls });

    // Act + Assert
    await click(view.container, '[data-runtime-rename="codex-default"]');
    await click(view.container, '[data-runtime-dialog-cancel]');
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
    await click(view.container, '[data-runtime-rename="codex-default"]');
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
    await click(view.container, '[data-runtime-remove="codex-default"]');

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
    expect(calls.some(call => call.path.endsWith('/apply'))).toBe(false);
  });

  it('removes exactly the change it previewed', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await open({ calls, routes: { [PROPOSE]: removalStaged([]), [APPLY]: COMMITTED } });
    await click(view.container, '[data-runtime-remove="codex-default"]');

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(proposed(calls)).toHaveLength(1);
    expect(calls.filter(call => call.path === `/v1/fleet/proposals/${CHANGE_ID}/apply`)).toHaveLength(1);
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

  it('offers no move when the client cannot move a ferret', async () => {
    // Act
    const view = await open({ routes: { [PROPOSE]: removalStaged() } });
    await click(view.container, '[data-runtime-remove="codex-default"]');

    // Assert
    expect(view.container.querySelector('[data-runtime-move-target]')).toBeNull();
    expect(view.container.querySelector('[data-runtime-running]')).not.toBeNull();
  });

  it('moves every ferret to the picked runtime, carrying each conversation, before it removes', async () => {
    // Arrange
    const calls: Call[] = [];
    const migrations: MigrateCall[] = [];
    const view = await open({
      calls,
      migrations,
      migrate: () => ({}),
      routes: { [PROPOSE]: removalStaged(), [APPLY]: COMMITTED },
    });
    await click(view.container, '[data-runtime-remove="claude-work"]');
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
    expect(migrations.map(([id, agent, , , , , conversation]) => [id, agent, conversation])).toEqual([
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
    const migrations: MigrateCall[] = [];
    const view = await open({
      migrations,
      migrate: () => ({}),
      routes: { [PROPOSE]: removalStaged([FERRETS[0] as FleetRunningSession]), [APPLY]: COMMITTED },
    });
    await click(view.container, '[data-runtime-remove="claude-work"]');

    // Act
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'move target'),
      'claude-review',
    );
    expect(submit(view.container).textContent).toBe('Move 1 ferret to claude-review and remove claude-work');
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(migrations.map(call => call[6])).toEqual(['resume']);
  });

  it('removes nothing while a ferret it was asked to move is still on it', async () => {
    // Arrange
    const calls: Call[] = [];
    const view = await open({
      calls,
      migrate: ([id]) => (id === 's-2' ? new Error('The session is mid-turn.') : {}),
      routes: { [PROPOSE]: removalStaged(), [APPLY]: COMMITTED },
    });
    await click(view.container, '[data-runtime-remove="claude-work"]');
    await choose(
      must(view.container.querySelector<HTMLSelectElement>('[data-runtime-move-target]'), 'move target'),
      'claude-review',
    );

    // Act
    await interact(() => submit(view.container).click());
    await settle();

    // Assert
    expect(calls.some(call => call.path.endsWith('/apply'))).toBe(false);
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
    await click(view.container, '[data-runtime-remove="claude-agent"]');

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
        'GET /v1/fleet/runtimes': {
          format: 'version-2',
          runtimes: [...(READS()['GET /v1/fleet/runtimes'] as { runtimes: unknown[] }).runtimes].map(entry => ({
            ...(entry as object),
            agent: true,
          })),
        },
      },
    });
    await click(view.container, '[data-runtime-remove="claude-default"]');
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
        agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
      },
      { kind: 'runtime.remove', name: 'claude-default' },
    ]);
    expect(refreshes).toEqual(['refresh']);
    expect(text(view.container, '[data-runtime-remove-impact]')).toBe(
      'Nothing is running on it. Its past sessions stay in history.',
    );
  });

  it('says why, and offers no move, when the machine cannot be reached once the dialog opens', async () => {
    // Arrange
    let reachable = true;
    const client = scripted(READS());
    const view = await mount(
      <RuntimesTab
        connection={STUDIO}
        machineName="studio-mac"
        machine={machine()}
        online
        checking={false}
        onRetry={() => undefined}
        createClient={async () => {
          if (!reachable) throw new Error('the machine went to sleep');
          return client;
        }}
        pollMs={60_000}
      />,
    );
    await settle();
    reachable = false;

    // Act
    await click(view.container, '[data-runtime-remove="codex-default"]');

    // Assert
    expect(view.container.querySelector('[data-runtime-remove-refused]')).not.toBeNull();
    expect(view.container.querySelector('[data-runtime-move-target]')).toBeNull();
  });

  it('says why when the dry run itself is refused', async () => {
    // Arrange
    const view = await open({ routes: { [PROPOSE]: new Error('the machine is asleep') } });

    // Act
    await click(view.container, '[data-runtime-remove="codex-default"]');

    // Assert
    expect(view.container.querySelector('[data-runtime-remove-refused]')).not.toBeNull();
    await click(view.container, '[data-runtime-dialog-cancel]');
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
  });
});
