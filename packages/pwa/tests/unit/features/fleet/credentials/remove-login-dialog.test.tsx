import { afterEach, describe, expect, it } from 'bun:test';
import type { FleetCredentialList, FleetMachineView, FleetRunningSession, IFyApiClient } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { CredentialsTab } from '../../../../../src/features/fleet/credentials/credentials-tab.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  CREDENTIALS,
  credential,
  DATA,
  machine,
  machineWith,
  NOW,
  READS,
  RUNTIMES,
  runtime,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';

const CHANGES = 'POST /v1/fleet/proposals';
const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;
const LIST = 'GET /v1/fleet/credentials';
const HASH = '#machines/studio-mac/credentials';

afterEach(() => {
  window.location.hash = '';
});

const OLD = credential({ id: 'kirin-old', label: 'old', usedBy: ['claude-agent', 'claude-review'] });
const WORK = credential({ id: 'kirin-work', label: 'work' });
const SPARE = credential({ id: 'kirin-spare', label: 'spare' });
const CODEX = credential({ id: 'codex', harness: 'codex', store: 'host', usedBy: ['codex-default'] });
const HOST = credential({
  id: 'claude-personal',
  store: 'host',
  usedBy: ['claude-default'],
  signOut: { available: true, sentence: 'Sign out?', runtimesAffected: 1, signsOutTerminal: true },
});

const logins: FleetCredentialList = { ...CREDENTIALS, credentials: [HOST, CODEX, OLD, WORK, SPARE] };

const onOld = (name: string, extra: Parameters<typeof runtime>[0] extends infer T ? Partial<T> : never = {}) =>
  runtime({
    name,
    credential: { id: 'kirin-old', store: 'ferretry', label: 'old', status: 'ready' },
    agent: true,
    ...extra,
  });

const data = {
  ...DATA,
  credentials: logins,
  runtimes: {
    ...RUNTIMES,
    runtimes: [
      runtime({ name: 'claude-default', agent: true }),
      runtime({
        name: 'codex-default',
        harness: 'codex',
        credential: { id: 'codex', store: 'host', status: 'ready' },
      }),
      onOld('claude-agent'),
      onOld('claude-review'),
    ],
  },
};

const FERRETS: readonly FleetRunningSession[] = [
  { id: 's-1', name: 'Fisher', harness: 'claude', runtime: 'claude-agent' },
  { id: 's-2', name: 'Otter', harness: 'claude', runtime: 'claude-agent' },
  { id: 's-3', name: 'Stoat', harness: 'claude', runtime: 'claude-review' },
];

/** The daemon's dry run, in the words it would use, with the ferrets tagged by runtime. */
const staged =
  (running: readonly FleetRunningSession[] = []) =>
  (call: Call) => ({
    ...stagedFrom(call),
    summary: 'Remove login',
    consequences: ['Removing kirin-old forgets it.'],
    preview: {
      kind: 'apply',
      operations: [],
      documents: [],
      runtimes: [],
      ...(running.length === 0 ? {} : { runningSessions: running }),
    },
  });

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const choose = async (select: HTMLSelectElement | null, value: string): Promise<void> => {
  const target = must(select, 'a select');
  await interact(() => {
    target.value = value;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};

const bodies = (calls: readonly Call[]): unknown[] =>
  calls
    .filter(call => `${call.method} ${call.path}` === CHANGES)
    .map(call => (call.body as { change: unknown }).change);

type MigrateCall = Parameters<IFyApiClient['migrate']>;

interface Options {
  readonly routes?: Record<string, unknown>;
  readonly machine?: FleetMachineView;
  readonly migrate?: (call: MigrateCall) => unknown;
  readonly migrations?: MigrateCall[];
}

const open = async (hash: string, options: Options = {}) => {
  window.location.hash = hash;
  const calls: Call[] = [];
  const base = scripted({ ...READS(data), [CHANGES]: staged(), [APPLY]: APPLIED, ...options.routes }, calls);
  const migrate = options.migrate;
  const client: FleetClient =
    migrate === undefined
      ? base
      : {
          ...base,
          migrate: async (...call: MigrateCall) => {
            options.migrations?.push(call);
            const answer = migrate(call);
            if (answer instanceof Error) throw answer;
            return answer as never;
          },
        };
  const view = await mount(
    <CredentialsTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={options.machine ?? machine()}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={async () => client}
      now={() => NOW}
    />,
  );
  await settle();
  return { view, calls };
};

const dialog = (container: ParentNode): HTMLElement =>
  must(container.querySelector<HTMLElement>('[data-runtime-dialog="remove-login"]'), 'the remove dialog');

const text = (container: ParentNode, selector: string): string =>
  must(container.querySelector(selector), selector).textContent ?? '';

const submit = (container: ParentNode): HTMLButtonElement =>
  must(dialog(container).querySelector<HTMLButtonElement>('[data-change-submit]'), 'the confirm button');

const openFor = async (container: ParentNode, id: string): Promise<void> => {
  await click(container.querySelector(`[data-credential-remove="${id}"]`), `Remove ${id}`);
};

describe('Remove a login · the buttons', () => {
  it('puts a danger Remove on every login row and on the login’s own page', async () => {
    const list = await open(HASH);
    for (const id of ['kirin-old', 'kirin-work', 'codex', 'claude-personal']) {
      const remove = must(list.view.container.querySelector(`[data-credential-remove="${id}"]`), id);
      expect(remove.getAttribute('data-variant')).toBe('danger');
      expect(remove.getAttribute('aria-label')).toBe(`Remove ${id}`);
    }
    await list.view.unmount();

    const detail = await open(`${HASH}/kirin-old`);
    expect(
      detail.view.container.querySelector('[data-credential-remove-zone] [data-credential-remove]'),
    ).not.toBeNull();
    expect(text(detail.view.container, '[data-credential-remove-zone]')).toContain(
      'Sign out keeps the login but it needs sign-in again. Remove deletes it.',
    );
    await detail.view.unmount();
  });

  it('disables Remove, with the reason, when this device may not change the fleet', async () => {
    const refused = machineWith({ mayApply: false, applyRefusal: 'not-granted' });
    const list = await open(HASH, { machine: refused, routes: { 'GET /v1/fleet/machine': refused } });
    const remove = must(list.view.container.querySelector<HTMLButtonElement>('[data-credential-remove]'), 'remove');
    expect(remove.disabled).toBe(true);
    expect(remove.title.length).toBeGreaterThan(0);
    await list.view.unmount();

    const detail = await open(`${HASH}/kirin-old`, { machine: refused, routes: { 'GET /v1/fleet/machine': refused } });
    expect(text(detail.view.container, '[data-credential-remove-refused]')).toStartWith('Remove is off here: ');
    await detail.view.unmount();
  });
});

describe('Remove a login · one nobody uses', () => {
  it('says so, stages a bare removal and confirms by name', async () => {
    const { view, calls } = await open(HASH);
    await openFor(view.container, 'kirin-spare');

    expect(text(dialog(view.container), '[data-login-remove-used]')).toBe('Not used by any runtime.');
    expect(dialog(view.container).querySelector('[data-login-remove-runtime]')).toBeNull();
    expect(bodies(calls)).toEqual([{ kind: 'credential.remove', id: 'kirin-spare' }]);
    expect(submit(view.container).textContent).toBe('Remove kirin-spare');
    expect(text(dialog(view.container), '[data-login-remove-difference]')).toBe(
      'Sign out keeps the login but it needs sign-in again. Remove deletes it.',
    );

    await click(submit(view.container), 'confirm');
    expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/apply'))).toHaveLength(1);
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
    expect(calls.filter(call => `${call.method} ${call.path}` === LIST).length).toBeGreaterThanOrEqual(2);
    await view.unmount();
  });

  it('does nothing on Cancel', async () => {
    const { view, calls } = await open(HASH);
    await openFor(view.container, 'kirin-spare');
    await click(dialog(view.container).querySelector('[data-runtime-dialog-cancel]'), 'cancel');
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0);
    await view.unmount();
  });

  it('shows the daemon’s refusal in the dialog and removes nothing', async () => {
    const { view, calls } = await open(HASH, {
      routes: { [CHANGES]: new FyHttpError('Remove login: kirin-spare is in use.', 409, 'fleet_change_refused') },
    });
    await openFor(view.container, 'kirin-spare');
    expect(dialog(view.container).textContent).toContain('Remove login: kirin-spare is in use.');
    expect(submit(view.container).disabled).toBe(true);
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0);
    await view.unmount();
  });
});

describe('Remove a login · used by 2 runtimes', () => {
  it('lists them and the ferrets, and defaults every runtime to switching to a compatible login', async () => {
    const { view, calls } = await open(HASH, { routes: { [CHANGES]: staged(FERRETS) } });
    await openFor(view.container, 'kirin-old');
    const body = dialog(view.container);

    expect(text(body, '[data-login-remove-used]')).toBe('Used by 2 runtimes: claude-agent, claude-review');
    for (const name of ['claude-agent', 'claude-review']) {
      expect(body.querySelector<HTMLInputElement>(`[data-login-remove-switch="${name}"]`)?.checked).toBe(true);
      const target = must(body.querySelector<HTMLSelectElement>(`[data-login-remove-target="${name}"]`), name);
      expect([...target.options].map(option => option.value)).toEqual(['claude-personal', 'kirin-work', 'kirin-spare']);
    }
    expect(submit(view.container).textContent).toBe('Switch 2 runtimes to claude-personal and remove kirin-old');
    expect(bodies(calls).at(-1)).toEqual({
      kind: 'credential.remove',
      id: 'kirin-old',
      switchRuntimes: { 'claude-agent': 'claude-personal', 'claude-review': 'claude-personal' },
    });
    await view.unmount();
  });

  it('applies the switch as one change to the login picked', async () => {
    const { view, calls } = await open(HASH, { routes: { [CHANGES]: staged(FERRETS) } });
    await openFor(view.container, 'kirin-old');
    await choose(dialog(view.container).querySelector('[data-login-remove-target="claude-agent"]'), 'kirin-work');
    await choose(dialog(view.container).querySelector('[data-login-remove-target="claude-review"]'), 'kirin-work');

    expect(submit(view.container).textContent).toBe('Switch 2 runtimes to kirin-work and remove kirin-old');
    await click(submit(view.container), 'confirm');
    expect(bodies(calls).at(-1)).toEqual({
      kind: 'credential.remove',
      id: 'kirin-old',
      switchRuntimes: { 'claude-agent': 'kirin-work', 'claude-review': 'kirin-work' },
    });
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
    expect(view.container.querySelector('[data-runtime-dialog]')).toBeNull();
    await view.unmount();
  });

  it('removes the runtime too when that is chosen, and names it on the button', async () => {
    const { view, calls } = await open(HASH, { routes: { [CHANGES]: staged(FERRETS) } });
    await openFor(view.container, 'kirin-old');
    await click(dialog(view.container).querySelector('[data-login-remove-runtime-too="claude-review"]'), 'remove');

    expect(submit(view.container).textContent).toBe(
      'Switch 1 runtime to claude-personal, remove 1 runtime and remove kirin-old',
    );
    expect(bodies(calls).at(-1)).toEqual({
      kind: 'credential.remove',
      id: 'kirin-old',
      switchRuntimes: { 'claude-agent': 'claude-personal' },
      removeRuntimes: ['claude-review'],
    });

    await click(dialog(view.container).querySelector('[data-login-remove-runtime-too="claude-agent"]'), 'remove');
    expect(submit(view.container).textContent).toBe('Remove 2 runtimes and remove kirin-old');
    await view.unmount();
  });

  it('asks for a new default when the default runtime is removed, and sends it', async () => {
    const { view, calls } = await open(HASH, {
      machine: machine({ defaultRuntime: 'claude-agent' }),
      routes: { [CHANGES]: staged(FERRETS) },
    });
    await openFor(view.container, 'kirin-old');
    expect(dialog(view.container).querySelector('[data-login-remove-default]')).toBeNull();

    await click(dialog(view.container).querySelector('[data-login-remove-runtime-too="claude-agent"]'), 'remove');
    const picker = must(
      dialog(view.container).querySelector<HTMLSelectElement>('[data-login-remove-default-picker]'),
      'default picker',
    );
    expect([...picker.options].map(option => option.value)).toEqual(['claude-default', 'claude-review']);
    expect(bodies(calls).at(-1)).toMatchObject({ removeRuntimes: ['claude-agent'], defaultRuntime: 'claude-default' });

    await choose(picker, 'claude-review');
    expect(bodies(calls).at(-1)).toMatchObject({ defaultRuntime: 'claude-review' });
    await view.unmount();
  });

  it('refuses to go on when the default is removed and no other agent runtime could take over', async () => {
    const lonely = {
      ...data,
      runtimes: {
        ...RUNTIMES,
        runtimes: [
          onOld('claude-agent'),
          runtime({
            name: 'codex-default',
            harness: 'codex',
            credential: { id: 'codex', store: 'host', status: 'ready' },
          }),
        ],
      },
    };
    const { view } = await open(HASH, {
      machine: machine({ defaultRuntime: 'claude-agent' }),
      routes: { ...READS(lonely), [CHANGES]: staged() },
    });
    await openFor(view.container, 'kirin-old');
    await click(dialog(view.container).querySelector('[data-login-remove-runtime-too="claude-agent"]'), 'remove');

    expect(text(dialog(view.container), '[data-login-remove-invalid]')).toContain('no other agent runtime');
    expect(submit(view.container).disabled).toBe(true);
    await view.unmount();
  });

  it('shows the daemon’s refusal of the plan and removes nothing', async () => {
    const { view, calls } = await open(HASH, {
      routes: {
        [CHANGES]: new FyHttpError(
          'claude-agent cannot move to kirin-work: it drives another tool.',
          409,
          'fleet_change_refused',
        ),
      },
    });
    await openFor(view.container, 'kirin-old');
    expect(dialog(view.container).textContent).toContain('it drives another tool');
    expect(submit(view.container).disabled).toBe(true);
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0);
    await view.unmount();
  });

  it('with no compatible login to switch to, offers only removing the runtime', async () => {
    const alone = { ...data, credentials: { ...CREDENTIALS, credentials: [OLD, CODEX] } };
    const { view } = await open(HASH, { routes: { ...READS(alone), [CHANGES]: staged() } });
    await openFor(view.container, 'kirin-old');
    const body = dialog(view.container);
    expect(body.querySelector<HTMLInputElement>('[data-login-remove-switch="claude-agent"]')?.disabled).toBe(true);
    expect(body.querySelector<HTMLInputElement>('[data-login-remove-runtime-too="claude-agent"]')?.checked).toBe(true);
    expect(text(body, '[data-login-remove-no-target]')).toContain('no other Claude Code login');
    await view.unmount();
  });
});

describe('Remove a login · the ferrets on a runtime that goes', () => {
  it('moves them first, to the runtime chosen, then removes', async () => {
    const migrations: MigrateCall[] = [];
    const { view, calls } = await open(HASH, {
      routes: { [CHANGES]: staged(FERRETS) },
      migrate: () => ({}),
      migrations,
    });
    await openFor(view.container, 'kirin-old');
    await click(dialog(view.container).querySelector('[data-login-remove-runtime-too="claude-agent"]'), 'remove');

    const ferrets = dialog(view.container).querySelectorAll('[data-login-remove-ferrets] li');
    expect(ferrets).toHaveLength(2);
    await choose(dialog(view.container).querySelector('[data-runtime-move-target]'), 'claude-default');
    expect(submit(view.container).textContent).toContain('Move 2 ferrets to claude-default');

    await click(submit(view.container), 'confirm');
    expect(migrations.map(call => [call[0], call[1]])).toEqual([
      ['s-1', 'claude-default'],
      ['s-2', 'claude-default'],
    ]);
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
    await view.unmount();
  });

  it('stops before removing anything when a ferret cannot be moved', async () => {
    const { view, calls } = await open(HASH, {
      routes: { [CHANGES]: staged(FERRETS) },
      migrate: ([id]) => (id === 's-2' ? new Error('Otter is mid-answer.') : {}),
    });
    await openFor(view.container, 'kirin-old');
    await click(dialog(view.container).querySelector('[data-login-remove-runtime-too="claude-agent"]'), 'remove');
    await choose(dialog(view.container).querySelector('[data-runtime-move-target]'), 'claude-default');
    await click(submit(view.container), 'confirm');

    expect(text(dialog(view.container), '[data-runtime-move-failed]')).toContain('Otter');
    expect(text(dialog(view.container), '[data-runtime-move-failed]')).toContain('kirin-old was not removed');
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0);
    await view.unmount();
  });
});

describe('Remove a login · signing it out first', () => {
  it('is offered only for a login Ferretry keeps a sign-in for', async () => {
    const { view } = await open(HASH);
    await openFor(view.container, 'kirin-spare');
    expect(dialog(view.container).querySelector('[data-login-remove-sign-out]')).not.toBeNull();
    await click(dialog(view.container).querySelector('[data-runtime-dialog-cancel]'), 'cancel');
    await openFor(view.container, 'claude-personal');
    expect(dialog(view.container).querySelector('[data-login-remove-sign-out]')).toBeNull();
    await view.unmount();
  });

  it('signs out, then removes, and the button says both', async () => {
    const { view, calls } = await open(HASH, {
      routes: { [APPLY]: { outcome: 'signed-out', credential: { ...SPARE } } },
    });
    await openFor(view.container, 'kirin-spare');
    await click(dialog(view.container).querySelector('[data-login-remove-sign-out]'), 'sign out first');
    expect(submit(view.container).textContent).toBe('Sign out and remove kirin-spare');

    await click(submit(view.container), 'confirm');
    expect(bodies(calls).filter(change => (change as { kind: string }).kind === 'credential.signout')).toEqual([
      { kind: 'credential.signout', id: 'kirin-spare' },
    ]);
    expect(bodies(calls).at(-1)).toEqual({ kind: 'credential.remove', id: 'kirin-spare' });
    await view.unmount();
  });

  it('keeps the login when the tool would not sign out', async () => {
    const { view, calls } = await open(HASH, {
      routes: {
        [APPLY]: { outcome: 'sign-out-failed', reason: 'Claude would not sign out.', credential: { ...SPARE } },
      },
    });
    await openFor(view.container, 'kirin-spare');
    await click(dialog(view.container).querySelector('[data-login-remove-sign-out]'), 'sign out first');
    await click(submit(view.container), 'confirm');

    expect(text(dialog(view.container), '[data-login-remove-note]')).toBe(
      'kirin-spare was not removed: Claude would not sign out.',
    );
    expect(bodies(calls).some(change => (change as { kind: string }).kind === 'credential.remove')).toBe(true);
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
    await view.unmount();
  });
});
