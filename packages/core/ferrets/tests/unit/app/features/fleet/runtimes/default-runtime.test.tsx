import { afterEach, describe, expect, it } from 'bun:test';
import type { FleetMachineView, FleetRuntimeCatalog } from '@ferretry/protocol';
import { RuntimesTab } from '../../../../../../app/features/fleet/runtimes/runtimes-tab.tsx';
import { interact, type Mounted, mount as mountView, must } from '../../../../support/dom.ts';
import {
  type Call,
  CHANGE_ID,
  machine,
  READS,
  type Route,
  runtime,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';
import { chooseRuntimeAction, menuButton, openRuntimeMenu } from './runtime-menu-support.ts';

const PROPOSE = 'POST /v1/fleet/proposals';
const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;
const COMMITTED = {
  outcome: 'applied',
  apply: {
    outcome: 'committed',
    result: { accountCount: 4, operationCount: 3, manifestPath: '/m.json', prunedWrappers: [], sharedHistory: [] },
  },
};

const mounted: Mounted[] = [];

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

const choose = async (select: HTMLSelectElement, value: string): Promise<void> => {
  await interact(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};

const AGENTS: FleetRuntimeCatalog = {
  format: 'version-2',
  runtimes: [
    runtime({ name: 'claude-default', agent: true }),
    runtime({
      name: 'claude-work',
      agent: true,
      credential: { id: 'claude-work', store: 'ferretry', label: 'work', status: 'needs_sign_in' },
    }),
    runtime({
      name: 'claude-atomi',
      agent: true,
      disabled: { source: 'runtime', until: '2026-11-04T00:00:00.000Z' },
    }),
    runtime({
      name: 'codex-kirin',
      agent: true,
      harness: 'codex',
      credential: { id: 'codex', store: 'host', status: 'ready' },
    }),
    runtime({ name: 'claude-plain' }),
  ],
};

interface Options {
  readonly runtimes?: FleetRuntimeCatalog;
  readonly machine?: FleetMachineView | null;
  readonly routes?: Record<string, Route>;
  readonly calls?: Call[];
  readonly refreshes?: string[];
}

const open = async (options: Options = {}) => {
  const shown = options.machine === undefined ? machine() : options.machine;
  const client = scripted(
    {
      ...READS(),
      'GET /v1/fleet/runtimes': options.runtimes ?? AGENTS,
      ...(shown === null ? {} : { 'GET /v1/fleet/machine': shown }),
      [PROPOSE]: stagedFrom,
      [APPLY]: COMMITTED,
      ...options.routes,
    },
    options.calls,
  );
  const view = await mountView(
    <RuntimesTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={shown}
      online
      checking={false}
      onRetry={() => options.refreshes?.push('retry')}
      onRefresh={() => options.refreshes?.push('refresh')}
      createClient={async () => client}
      pollMs={5}
    />,
  );
  mounted.push(view);
  await settle();
  return view;
};

const select = (container: ParentNode): HTMLSelectElement =>
  must(container.querySelector<HTMLSelectElement>('[data-default-runtime-select]'), 'default runtime select');

const optionTexts = (container: ParentNode): string[] =>
  [...select(container).options].map(option => option.textContent ?? '');

const machineChanges = (calls: readonly Call[]): unknown[] =>
  calls.filter(call => call.path === '/v1/fleet/proposals').map(call => (call.body as { change: unknown }).change);

describe('Default for new agents on the Runtimes tab', () => {
  it('is one labelled row: a select of the agent runtimes, each with its state in words, and the hint', async () => {
    const view = await open();

    const control = must(view.container.querySelector('[data-default-runtime]'), 'control');
    expect(control.querySelector('label')?.textContent).toBe('Default for new agents');
    expect(control.querySelector('[data-default-runtime-hint]')?.textContent).toBe(
      'Used when a start names no runtime.',
    );
    expect(optionTexts(view.container)).toEqual([
      'claude-default · ready',
      'claude-work · needs sign-in',
      'claude-atomi · switched off until 4 Nov 2026',
      'codex-kirin · ready',
    ]);
    expect(select(view.container).value).toBe('claude-default');
    expect(view.container.querySelector('[data-change-apply]')).toBeNull();
  });

  it('marks a switched-off runtime in words and does not let it be picked, unless it is already the default', async () => {
    const view = await open();
    const off = (container: ParentNode) =>
      [...select(container).options].filter(option => option.disabled).map(option => option.value);
    expect(off(view.container)).toEqual(['claude-atomi']);

    const held = await open({ machine: machine({ defaultRuntime: 'claude-atomi' }) });
    expect(off(held.container)).toEqual([]);
    expect(select(held.container).value).toBe('claude-atomi');
  });

  it('names a CLI that is not installed', async () => {
    const view = await open({
      machine: machine({
        tools: [
          { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
          { harness: 'codex', label: 'Codex', installed: false },
        ],
      }),
    });

    expect(optionTexts(view.container)).toContain('codex-kirin · Codex not installed');
  });

  it('says there is no agent runtime yet when none of the runtimes is one', async () => {
    const view = await open({ runtimes: { format: 'version-2', runtimes: [runtime({ name: 'claude-plain' })] } });

    expect(must(view.container.querySelector('[data-default-runtime-empty]'), 'empty').textContent).toContain(
      'has no agent runtime yet',
    );
    expect(view.container.querySelector('[data-default-runtime-select]')).toBeNull();
  });

  it('is not shown while the machine has not answered', async () => {
    const view = await open({ machine: null });

    expect(view.container.querySelector('[data-default-runtime]')).toBeNull();
    expect(view.container.querySelector('[data-runtime-default-badge]')).toBeNull();
  });

  it('changing the select shows the apply panel, and saving writes only the default runtime', async () => {
    const calls: Call[] = [];
    const refreshes: string[] = [];
    const view = await open({ calls, refreshes });

    await choose(select(view.container), 'codex-kirin');

    expect(must(view.container.querySelector('[data-default-runtime-undo]'), 'keep').textContent).toBe(
      'Keep claude-default',
    );
    expect(must(view.container.querySelector('[data-change-submit]'), 'save').textContent).toBe('Save default runtime');
    await click(view.container, '[data-change-submit]');

    expect(machineChanges(calls)).toEqual([
      {
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: 'codex-kirin',
        agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
      },
    ]);
    expect(refreshes).toEqual(['refresh']);
    expect(view.container.querySelector('[data-default-runtime-undo]')).toBeNull();
  });

  it('Keep puts the select back and sends nothing', async () => {
    const calls: Call[] = [];
    const view = await open({ calls });
    await choose(select(view.container), 'claude-work');

    await click(view.container, '[data-default-runtime-undo]');

    expect(select(view.container).value).toBe('claude-default');
    expect(view.container.querySelector('[data-change-apply]')).toBeNull();
    expect(machineChanges(calls)).toEqual([]);
  });

  it('a machine with no default shows "automatic", and Keep returns to it', async () => {
    const view = await open({ machine: machine({ defaultRuntime: null }) });

    expect(optionTexts(view.container)[0]).toBe('automatic');
    expect(view.container.querySelector('[data-runtime-default-badge]')).toBeNull();
    await choose(select(view.container), 'claude-default');
    expect(must(view.container.querySelector('[data-default-runtime-undo]'), 'keep').textContent).toBe(
      'Keep automatic',
    );
    await click(view.container, '[data-default-runtime-undo]');
    expect(select(view.container).value).toBe('');
  });

  it('a refused save says why and keeps the pick', async () => {
    const view = await open({ routes: { [PROPOSE]: new Error('unreachable') } });
    await choose(select(view.container), 'claude-work');

    await click(view.container, '[data-change-submit]');

    expect(must(view.container.querySelector('[data-change-refusal]'), 'refusal').textContent).toContain(
      'didn’t answer',
    );
    expect(select(view.container).value).toBe('claude-work');
  });
});

describe('The Default badge and Make default on the runtimes list', () => {
  it('badges only the default runtime’s row', async () => {
    const view = await open();

    const badges = [...view.container.querySelectorAll('[data-runtime-default-badge]')];
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe('Default');
    expect(
      view.container.querySelector('[data-runtime-card="claude-default"] [data-runtime-default-badge]'),
    ).not.toBeNull();
  });

  it('puts the Default and Not agent badges after the name, wrapping under it instead of cutting it, and badges no switched-off runtime', async () => {
    const view = await open();
    const card = (name: string) =>
      must(view.container.querySelector<HTMLElement>(`[data-runtime-card="${name}"]`), name);
    const badgesOn = (name: string, badge: string): HTMLElement => {
      const element = must(card(name).querySelector<HTMLElement>(`[${badge}]`), badge);
      const nameRow = must(card(name).querySelector<HTMLElement>('[data-runtime-name]'), 'name').parentElement;
      // The badge shares the name's own row, and follows it.
      expect(element.parentElement).toBe(nameRow);
      expect(nameRow?.firstElementChild?.hasAttribute('data-runtime-name')).toBe(true);
      expect(nameRow?.hasAttribute('data-runtime-name-row')).toBe(true);
      expect(nameRow?.className).toContain('flex-wrap');
      return element;
    };
    expect(badgesOn('claude-default', 'data-runtime-default-badge').textContent).toBe('Default');
    expect(badgesOn('claude-plain', 'data-runtime-kind-badge').textContent).toBe('Not agent');
    // A switched-off runtime carries no badge: the off switch and the off note already say it.
    expect(card('claude-atomi').querySelector('[data-runtime-disabled-badge]')).toBeNull();
    expect(card('claude-atomi').textContent).not.toMatch(/disabled/i);
    // The badge wraps under the name before the name is ever cut: the name never shrinks or truncates.
    for (const runtime of ['claude-default', 'claude-atomi', 'claude-plain']) {
      const name = must(card(runtime).querySelector('[data-runtime-name]'), 'name');
      expect(name.className).toContain('shrink-0');
      expect(name.className).toContain('max-w-full');
      expect(name.className).toContain('break-words');
      expect(name.className).not.toContain('truncate');
      expect(name.className).not.toContain('ellipsis');
    }
    expect(card('claude-default').querySelector('[data-runtime-default-badge]')?.className).toContain('shrink-0');
    // The details are one truncated line, whole in its tooltip.
    const details = must(card('claude-default').querySelector<HTMLElement>('[data-runtime-details]'), 'details');
    expect(details.className).toContain('truncate');
    expect(details.getAttribute('title')).toBe(details.textContent ?? '');
    // The off note appears only for a switched-off runtime.
    expect(card('claude-work').querySelector('[data-disable-note]')).toBeNull();
    expect(card('claude-atomi').querySelector('[data-disable-note]')).not.toBeNull();
  });

  it('offers Make default in the ⋯ menu of each non-default agent runtime, not on the default, a plain runtime or a switched-off one', async () => {
    const view = await open();

    for (const name of ['claude-default', 'claude-plain', 'claude-atomi'])
      expect((await openRuntimeMenu(view.container, name)).has('make-default')).toBe(false);
    for (const name of ['claude-work', 'codex-kirin'])
      expect((await openRuntimeMenu(view.container, name)).get('make-default')?.textContent).toContain('Make default');
  });

  it('keeps every action behind one ⋯ button named by aria-label, so a card stays two lines', async () => {
    const view = await open();

    const card = must(view.container.querySelector('[data-runtime-card="claude-work"]'), 'card');
    const buttons = card.querySelectorAll('[data-runtime-actions]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Actions for claude-work');
    expect(card.querySelector('[data-runtime-rename], [data-runtime-remove], [data-runtime-make-default]')).toBeNull();
  });

  it('Make default fills the select and shows the same apply panel; saving writes that runtime', async () => {
    const calls: Call[] = [];
    const view = await open({ calls });

    await chooseRuntimeAction(view.container, 'claude-work', 'make-default');

    expect(select(view.container).value).toBe('claude-work');
    expect(must(view.container.querySelector('[data-default-runtime-undo]'), 'keep').textContent).toBe(
      'Keep claude-default',
    );
    await click(view.container, '[data-change-submit]');
    expect(machineChanges(calls)).toEqual([
      expect.objectContaining({ kind: 'machine.settings', defaultRuntime: 'claude-work' }),
    ]);
  });

  it('is disabled, with the reason, when this device may not change the fleet', async () => {
    const view = await open({
      machine: machine({ authority: { mayApply: false, applyRefusal: 'not-granted' } }),
    });

    const button = menuButton(view.container, 'claude-work');
    expect(button.disabled).toBe(true);
    expect(button.title.length).toBeGreaterThan(0);
  });
});
