import { afterEach, describe, expect, it } from 'bun:test';
import { AgentsTab } from '../../../../../../app/features/fleet/machine/agents-tab.tsx';
import type { MachineView } from '../../../../../../contract/index.ts';
import { interact, type Mounted, mount as mountView, must } from '../../../../support/dom.ts';
import {
  type Call,
  CHANGE_ID,
  machine,
  machineWith,
  READS,
  type Route,
  scripted,
  stagedFrom,
} from '../account-support.ts';

const PROPOSE = 'POST /v1/runtimes/proposals';
const APPLY = `POST /v1/runtimes/proposals/${CHANGE_ID}/apply`;
const COMMITTED = {
  outcome: 'applied',
  apply: {
    outcome: 'committed',
    result: { accountCount: 4, operationCount: 3, manifestPath: '/m.json', prunedWrappers: [], sharedHistory: [] },
  },
};
const FILE = 'GET /v1/config/file';
const WRITE = 'PUT /v1/config/file';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (container: ParentNode, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
  await settle();
};

interface Options {
  readonly machine?: MachineView | null;
  readonly routes?: Record<string, Route>;
  readonly calls?: Call[];
  readonly refreshes?: string[];
}

const open = async (options: Options = {}) => {
  const shown = options.machine === undefined ? machine() : options.machine;
  const client = scripted(
    {
      ...READS(),
      ...(shown === null ? {} : { 'GET /v1/runtimes/machine': shown }),
      [FILE]: { path: 'conversation.yaml', exists: false, text: '', etag: 'etag-1' },
      [WRITE]: { path: 'conversation.yaml', etag: 'etag-2', outcome: 'applied' },
      [PROPOSE]: stagedFrom,
      [APPLY]: COMMITTED,
      ...options.routes,
    },
    options.calls,
  );
  const view = await mountView(
    <AgentsTab
      client={client}
      machineName="studio-mac"
      machine={shown}
      online
      checking={false}
      onRetry={() => options.refreshes?.push('retry')}
      onRefresh={() => options.refreshes?.push('refresh')}
    />,
  );
  mounted.push(view);
  await settle();
  return view;
};

const UNCHANGED = {
  kind: 'machine.settings',
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
};

const changes = (calls: readonly Call[]): unknown[] =>
  calls.filter(call => call.route === PROPOSE).map(call => (call.body as { change: unknown }).change);

const section = (container: ParentNode, name: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-setup-section="${name}"]`), name);

const flip = async (container: ParentNode, row: string): Promise<void> =>
  click(container, `[data-setting-row="${row}"] [role="switch"]`);

describe('the Agents tab', () => {
  it('draws the five agent settings in v4’s order, in v4’s words', async () => {
    const view = await open();

    const order = [...view.container.querySelectorAll('[data-setup-section]')].map(el =>
      el.getAttribute('data-setup-section'),
    );
    expect(order).toEqual(['agent-permissions', 'agent-control', 'auto-resume', 'agenda-mode', 'conversations']);
    expect(
      [...section(view.container, 'agent-permissions').querySelectorAll('[role="radiogroup"] label')].map(
        el => el.textContent,
      ),
    ).toEqual(['Auto mode', 'Skip all checks']);
    expect(
      [...section(view.container, 'agent-control').querySelectorAll('[data-setting-row]')].map(el =>
        el.getAttribute('data-setting-row'),
      ),
    ).toEqual(['Terminals', 'Browsers', 'Files', 'Ferretry settings', 'Page scripts']);
    expect(section(view.container, 'auto-resume').textContent).toContain('Resume ferrets after a restart');
    expect(section(view.container, 'agenda-mode').textContent).toContain('Agenda mode for new ferrets');
    expect(section(view.container, 'conversations').textContent).toContain('Keep in sync');
  });

  it('says it is waiting while the machine has not answered', async () => {
    const view = await open({ machine: null });
    expect(must(view.container.querySelector('[data-agents-waiting]'), 'waiting').textContent).toBe(
      'studio-mac’s agent settings show once it answers.',
    );
    expect(view.container.querySelector('[data-setup-section]')).toBeNull();
  });

  it('saving permissions sends every machine setting together, and says what running sessions keep', async () => {
    const calls: Call[] = [];
    const refreshes: string[] = [];
    const view = await open({ calls, refreshes, machine: machine({ runningSessions: 2 }) });

    await click(view.container, '[role="radiogroup"] input[value="skip"]');
    expect(must(view.container.querySelector('[data-agent-permissions-detail]'), 'detail').textContent).toBe(
      'Agents never stop to ask. They can change any file and run any command on studio-mac.',
    );
    expect(must(view.container.querySelector('[data-change-submit]'), 'save').textContent).toBe(
      'Save agent permissions',
    );
    await click(view.container, '[data-change-submit]');

    expect(changes(calls)).toEqual([{ ...UNCHANGED, agentPermissions: 'skip' }]);
    expect(refreshes).toEqual(['refresh']);
  });

  it('Keep puts the permissions back and sends nothing', async () => {
    const calls: Call[] = [];
    const view = await open({ calls });
    await click(view.container, '[role="radiogroup"] input[value="skip"]');
    expect(must(view.container.querySelector('[data-agent-permissions-undo]'), 'keep').textContent).toBe(
      'Keep Auto mode',
    );
    await click(view.container, '[data-agent-permissions-undo]');
    expect(view.container.querySelector('[data-change-apply]')).toBeNull();
    expect(changes(calls)).toEqual([]);
  });

  it('turning a control on saves the whole agentControl set; the i button opens the full explanation', async () => {
    const calls: Call[] = [];
    const view = await open({ calls });

    await click(view.container, '[data-setting-row="Page scripts"] [data-setting-info]');
    expect(must(view.container.querySelector('[data-setting-explanation]'), 'explanation').textContent).toContain(
      'your sign-ins to every site',
    );
    await flip(view.container, 'Page scripts');
    expect(must(view.container.querySelector('[data-change-submit]'), 'save').textContent).toBe(
      'Save what agents may control',
    );
    await click(view.container, '[data-change-submit]');

    expect(changes(calls)).toEqual([{ ...UNCHANGED, agentControl: { ...UNCHANGED.agentControl, pageScripts: true } }]);
  });

  it('auto-resume saves, and shows the last pass with what it could not resume', async () => {
    const calls: Call[] = [];
    const view = await open({
      calls,
      machine: machine({
        lastAutoResume: {
          at: '2026-10-13T07:00:00.000Z',
          resumed: 3,
          skipped: [{ sessionId: 'sess-9', reason: 'its folder is gone' }],
        },
      } as unknown as Partial<MachineView>),
    });

    expect(must(view.container.querySelector('[data-auto-resume-summary]'), 'summary').textContent).toContain(
      'Resumed 3 ferrets after restart',
    );
    expect(must(view.container.querySelector('[data-auto-resume-skipped]'), 'skipped').textContent).toBe(
      'Couldn’t auto-resume sess-9: its folder is gone',
    );
    await flip(view.container, 'Resume ferrets after a restart');
    await click(view.container, '[data-change-submit]');
    expect(changes(calls)).toEqual([{ ...UNCHANGED, autoResume: false }]);
  });

  it('agenda mode saves on its own', async () => {
    const calls: Call[] = [];
    const view = await open({ calls });
    await flip(view.container, 'Agenda mode for new ferrets');
    expect(must(view.container.querySelector('[data-change-submit]'), 'save').textContent).toBe('Save agenda mode');
    await click(view.container, '[data-change-submit]');
    expect(changes(calls)).toEqual([{ ...UNCHANGED, agendaMode: true }]);
  });

  it('a caller who may not change settings is told so and cannot save (loosening stays the owner’s)', async () => {
    const calls: Call[] = [];
    const view = await open({
      calls,
      machine: machineWith({ mayApply: false, applyRefusal: 'not-granted' }),
    });
    await click(view.container, '[role="radiogroup"] input[value="skip"]');
    expect(view.container.querySelector('[data-change-grant-refused]')).not.toBeNull();
    expect(must(view.container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'save').disabled).toBe(true);
    expect(changes(calls)).toEqual([]);
  });

  it('a refusal from the daemon shows where the change is made, and nothing refreshes', async () => {
    const refreshes: string[] = [];
    const view = await open({ refreshes, routes: { [PROPOSE]: new Error('The machine said no.') } });
    await flip(view.container, 'Agenda mode for new ferrets');
    await click(view.container, '[data-change-submit]');
    expect(must(view.container.querySelector('[data-change-refusal]'), 'alert').textContent).toContain('said no');
    expect(refreshes).toEqual([]);
  });
});

describe('Conversations › Keep in sync', () => {
  const writes = (calls: readonly Call[]) => calls.filter(call => call.route === WRITE).map(call => call.body);

  it('reads conversation.yaml: on when the file says nothing', async () => {
    const view = await open();
    const toggle = must(
      view.container.querySelector<HTMLElement>('[data-setting-row="Keep in sync"] [role="switch"]'),
      'toggle',
    );
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('shows off when the file says keepInSync: false, and turning it on rewrites only that key', async () => {
    const calls: Call[] = [];
    const view = await open({
      calls,
      routes: { [FILE]: { path: 'conversation.yaml', exists: true, text: '# mine\nkeepInSync: false\n', etag: 'e-7' } },
    });
    const toggle = (): HTMLElement =>
      must(view.container.querySelector<HTMLElement>('[data-setting-row="Keep in sync"] [role="switch"]'), 'toggle');
    expect(toggle().getAttribute('aria-checked')).toBe('false');

    await interact(() => toggle().click());
    await settle();

    expect(writes(calls)).toEqual([{ path: 'conversation.yaml', text: '# mine\nkeepInSync: true\n', etag: 'e-7' }]);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('turning it off writes keepInSync: false against the etag it read', async () => {
    const calls: Call[] = [];
    const view = await open({ calls });
    await flip(view.container, 'Keep in sync');
    const [body] = writes(calls) as { path: string; text: string; etag: string }[];
    expect(body?.path).toBe('conversation.yaml');
    expect(body?.etag).toBe('etag-1');
    expect(body?.text).toContain('keepInSync: false');
  });

  it('says so when the daemon holds the edit, and when it refuses it', async () => {
    const held = await open({ routes: { [WRITE]: { path: 'conversation.yaml', etag: 'e', outcome: 'pending' } } });
    await flip(held.container, 'Keep in sync');
    expect(must(held.container.querySelector('[data-keep-in-sync-note]'), 'note').textContent).toBe(
      'Saved, but not in effect until you confirm it.',
    );
    const refused = await open({ routes: { [WRITE]: new Error('Not allowed.') } });
    await flip(refused.container, 'Keep in sync');
    const note = refused.container.querySelectorAll('[data-keep-in-sync-note]');
    expect(note[note.length - 1]?.textContent).toContain('Not allowed.');
  });
});
