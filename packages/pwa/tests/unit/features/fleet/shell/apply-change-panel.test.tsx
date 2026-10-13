import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-api.ts';
import type { ChangeResult, StageResult } from '../../../../../src/features/fleet/shell/apply-change.ts';
import {
  type AccountChanges,
  ChangeApplyPanel,
  useAccountChanges,
} from '../../../../../src/features/fleet/shell/apply-change-panel.tsx';
import { type DaemonConnection, daemonConnection } from '../../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  APPLY_PATH,
  type Call,
  OUTCOME,
  permissions,
  STAGED,
  scriptedClient,
  UNLOCK_TOKEN,
  UNLOCKED,
} from './change-support.ts';

const CHANGE = { kind: 'machine.settings', agentPermissions: 'auto' } as const;
const PASSWORD = 'correct-horse-battery';
const NOW = () => Date.parse('2026-10-13T08:00:00.000Z');
const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceToken: 't' });
const OTHER = daemonConnection({ daemonId: 'other', baseUrl: 'https://other.example.test', deviceToken: 'u' });

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

describe('ChangeApplyPanel', () => {
  it('shows only the machine’s reason while it does not accept changes', async () => {
    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        changes={{ available: false, reason: 'Account setup changes are switched off on this machine for now.' }}
        authority={{ kind: 'open' }}
        busy={false}
        refusal={null}
        submitLabel="Create runtime"
        onSubmit={() => undefined}
      >
        <button type="button" data-extra="">
          Back to Runtimes
        </button>
      </ChangeApplyPanel>,
    );
    expect(view.container.querySelector('[data-change-unavailable]')?.textContent).toBe(
      'Account setup changes are switched off on this machine for now.',
    );
    expect(view.container.querySelector('[data-change-submit]')).toBeNull();
    expect(view.container.querySelector('[data-extra]')).not.toBeNull();
    await view.unmount();

    const bare = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        changes={{ available: false, reason: 'Off.' }}
        authority={null}
        busy={false}
        refusal={null}
        submitLabel="Go"
        onSubmit={() => undefined}
      />,
    );
    expect(bare.container.querySelector('[data-change-apply]')?.children).toHaveLength(1);
    await bare.unmount();
  });

  it('submits at once when nothing is owed, and waits while authority is being read', async () => {
    const sent: (string | undefined)[] = [];
    const reading = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        changes={null}
        authority={null}
        busy={false}
        refusal={null}
        submitLabel="Create runtime"
        onSubmit={value => sent.push(value)}
      />,
    );
    expect(reading.container.querySelector('[data-change-apply]')?.getAttribute('data-change-apply')).toBe('reading');
    expect((reading.container.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await reading.unmount();

    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        changes={{ available: true }}
        authority={{ kind: 'open' }}
        busy={false}
        refusal="The setup changed since this was staged."
        submitLabel="Create runtime"
        onSubmit={value => sent.push(value)}
      />,
    );
    expect(view.container.querySelector('[data-change-password]')).toBeNull();
    expect(view.container.querySelector('[data-change-refusal]')?.textContent).toBe(
      'The setup changed since this was staged.',
    );
    await click(view.container.querySelector('[data-change-submit]'), 'submit');
    expect(sent).toEqual([undefined]);
    await view.unmount();
  });

  it('asks for the password when owed, sends it once, and clears the field first', async () => {
    const sent: (string | undefined)[] = [];
    function Host() {
      const [busy] = useState(false);
      return (
        <ChangeApplyPanel
          machineName="studio-mac"
          changes={{ available: true }}
          authority={{ kind: 'confirm' }}
          busy={busy}
          refusal={null}
          submitLabel="Sign out"
          variant="danger"
          onSubmit={value => sent.push(value)}
        />
      );
    }
    const view = await mount(<Host />);
    const field = must(view.container.querySelector<HTMLInputElement>('[data-change-password]'), 'password');
    expect(view.container.textContent).toContain('used once and not stored');
    const submit = must(view.container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'submit');
    expect(submit.disabled).toBe(true);
    await click(submit, 'submit');
    expect(sent).toEqual([]);
    await type(field, PASSWORD);
    expect(submit.disabled).toBe(false);
    await click(submit, 'submit');
    expect(sent).toEqual([PASSWORD]);
    expect(field.value).toBe('');
    await view.unmount();

    const locked = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        changes={null}
        authority={{ kind: 'locked', alsoConfirms: false }}
        busy
        busyLabel="Signing out…"
        refusal={null}
        submitLabel="Sign out"
        onSubmit={() => undefined}
      />,
    );
    expect(locked.container.textContent).toContain('before it accepts changes from here');
    expect(locked.container.querySelector('[data-change-submit]')?.textContent).toBe('Signing out…');
    await locked.unmount();
  });

  it('a grant refusal says why, in the shared words, and offers no button that works', async () => {
    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        changes={{ available: true }}
        authority={{ kind: 'refused', refusal: 'not-granted' }}
        busy={false}
        refusal={null}
        submitLabel="Create runtime"
        disabled
        onSubmit={() => undefined}
      />,
    );
    expect(view.container.querySelector('[data-change-grant-refused]')?.textContent?.length).toBeGreaterThan(0);
    expect((view.container.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await view.unmount();
  });
});

interface Probe {
  current: AccountChanges | null;
}

function HookHost({
  connection,
  factory,
  probe,
}: {
  readonly connection: DaemonConnection;
  readonly factory: (connection: DaemonConnection) => Promise<FleetClient>;
  readonly probe: Probe;
}) {
  const changes = useAccountChanges({ connection, createClient: factory, now: NOW });
  probe.current = changes;
  return (
    <p data-authority={changes.authority?.kind ?? 'reading'} data-busy={String(changes.busy)}>
      {changes.refusal ?? ''}
    </p>
  );
}

const hookView = async (factory: (connection: DaemonConnection) => Promise<FleetClient>) => {
  const probe: Probe = { current: null };
  const view = await mount(<HookHost connection={STUDIO} factory={factory} probe={probe} />);
  await settle();
  return { view, probe, hooks: () => must(probe.current, 'hook') };
};

describe('useAccountChanges', () => {
  it('reads authority, applies a change and keeps nothing to show when it worked', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      { '/v1/fleet/permissions': permissions(), '/v1/fleet/changes': STAGED, [APPLY_PATH]: OUTCOME },
      calls,
    );
    const { view, hooks } = await hookView(async () => client);
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('open');
    let result: ChangeResult | undefined;
    await interact(async () => {
      result = await hooks().apply(CHANGE);
    });
    expect(result).toMatchObject({ kind: 'applied', outcome: OUTCOME });
    expect(view.container.querySelector('p')?.textContent).toBe('');
    expect(view.container.querySelector('[data-busy]')?.getAttribute('data-busy')).toBe('false');
    await view.unmount();
  });

  it('shows a refusal, clears it, and stages then applies separately', async () => {
    const off = new FyHttpError(
      'Account setup changes are switched off on this machine for now.',
      409,
      'fleet_change_disabled',
    );
    let stageAnswer: unknown = off;
    const client = scriptedClient({
      '/v1/fleet/permissions': permissions(),
      '/v1/fleet/changes': () => stageAnswer,
      [APPLY_PATH]: OUTCOME,
    });
    const { view, hooks } = await hookView(async () => client);
    await interact(async () => {
      await hooks().apply(CHANGE);
    });
    expect(view.container.querySelector('p')?.textContent).toBe(
      'Account setup changes are switched off on this machine for now.',
    );
    await interact(() => hooks().clear());
    expect(view.container.querySelector('p')?.textContent).toBe('');
    stageAnswer = STAGED;
    let staged: StageResult | undefined;
    await interact(async () => {
      staged = await hooks().stage(CHANGE);
    });
    expect(staged).toMatchObject({ kind: 'staged' });
    let applied: ChangeResult | undefined;
    await interact(async () => {
      applied = await hooks().applyStaged(STAGED);
    });
    expect(applied).toMatchObject({ kind: 'applied' });
    await view.unmount();
  });

  it('a locked browser unlocks once, then asks again what it may do', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      {
        '/v1/fleet/permissions': (call: Call) =>
          call.headers['x-ferretry-operator-unlock'] === UNLOCK_TOKEN
            ? permissions()
            : permissions({ mayApply: false, applyRefusal: 'locked' }),
        '/v1/grants/unlock': UNLOCKED,
        '/v1/fleet/changes': STAGED,
        [APPLY_PATH]: OUTCOME,
      },
      calls,
    );
    const { view, hooks } = await hookView(async () => client);
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('locked');
    await interact(async () => {
      await hooks().apply(CHANGE, PASSWORD);
    });
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('open');
    calls.length = 0;
    await interact(async () => {
      await hooks().apply(CHANGE);
    });
    // The held unlock rides along; nothing is minted again.
    expect(calls.map(call => call.path)).toEqual(['/v1/fleet/changes', APPLY_PATH]);
    expect(calls[0]?.headers['x-ferretry-operator-unlock']).toBe(UNLOCK_TOKEN);
    await view.unmount();
  });

  it('authorizes a guarded act, and shows a sentence the caller worded', async () => {
    const client = scriptedClient({ '/v1/fleet/permissions': permissions({ confirmation: 'operator-password' }) });
    const { view, hooks } = await hookView(async () => client);
    let answer: unknown;
    await interact(async () => {
      answer = await hooks().authorize(PASSWORD);
    });
    expect(answer).toEqual({ kind: 'authorized', operatorPassword: PASSWORD, held: null });
    await interact(() => hooks().refuse('Claude didn’t accept that code.'));
    expect(view.container.querySelector('p')?.textContent).toBe('Claude didn’t accept that code.');
    await view.unmount();
  });

  it('an unreachable machine reads as unreadable authority and a refused change', async () => {
    const { view, hooks } = await hookView(async () => Promise.reject(new Error('no carrier')));
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('unreadable');
    let result: ChangeResult | undefined;
    await interact(async () => {
      result = await hooks().apply(CHANGE);
    });
    expect(result).toMatchObject({ kind: 'refused', passwordRejected: false });
    expect(view.container.querySelector('p')?.textContent).toContain('didn’t answer');
    await view.unmount();
  });

  it('starts over for another machine, and reads authority itself if asked before it landed', async () => {
    const probe: Probe = { current: null };
    let release: (client: FleetClient) => void = () => undefined;
    const slow = new Promise<FleetClient>(resolve => {
      release = resolve;
    });
    const client = scriptedClient({
      '/v1/fleet/permissions': permissions(),
      '/v1/fleet/changes': STAGED,
      [APPLY_PATH]: OUTCOME,
    });
    const view = await mount(<HookHost connection={STUDIO} factory={() => slow} probe={probe} />);
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('reading');
    await view.render(<HookHost connection={OTHER} factory={async () => client} probe={probe} />);
    release(client);
    await settle();
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('open');
    await view.unmount();

    const early: Probe = { current: null };
    const pending = await mount(<HookHost connection={STUDIO} factory={async () => client} probe={early} />);
    let result: ChangeResult | undefined;
    await interact(async () => {
      result = await must(early.current, 'hook').apply(CHANGE);
    });
    expect(result).toMatchObject({ kind: 'applied' });
    await pending.unmount();
  });
});
