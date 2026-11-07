import { describe, expect, it } from 'bun:test';
import type { ChangeResult, StageResult } from '../../../../../../app/features/fleet/shell/apply-change.ts';
import {
  type AccountChanges,
  ChangeApplyPanel,
  useAccountChanges,
} from '../../../../../../app/features/fleet/shell/apply-change-panel.tsx';
import type { RuntimesClient } from '../../../../../../app/lib/client.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { APPLIED, CHANGE_ID, machine, machineWith, scripted, stagedFrom } from '../account-support.ts';

const CHANGE = {
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
} as const;
const MACHINE = 'GET /v1/runtimes/machine';
const PROPOSE = 'POST /v1/runtimes/proposals';
const APPLY = `POST /v1/runtimes/proposals/${CHANGE_ID}/apply`;
const STAGED = stagedFrom({ body: { change: CHANGE } });

const refusal = (message: string, status: number, code: string): Error =>
  Object.assign(new Error(message), { name: 'DaemonCallError', status, code });

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

describe('ChangeApplyPanel', () => {
  it('submits at once when nothing is owed, and waits while authority is being read', async () => {
    let sent = 0;
    const reading = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={null}
        busy={false}
        refusal={null}
        submitLabel="Create runtime"
        onSubmit={() => {
          sent += 1;
        }}
      />,
    );
    expect(reading.container.querySelector('[data-change-apply]')?.getAttribute('data-change-apply')).toBe('reading');
    expect((reading.container.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await reading.unmount();

    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={{ kind: 'open' }}
        busy={false}
        refusal="The setup changed since this was staged."
        submitLabel="Create runtime"
        onSubmit={() => {
          sent += 1;
        }}
      />,
    );
    expect(view.container.querySelector('[data-change-step-up]')).toBeNull();
    expect(view.container.querySelector('[data-change-refusal]')?.textContent).toBe(
      'The setup changed since this was staged.',
    );
    await click(view.container.querySelector('[data-change-submit]'), 'submit');
    expect(sent).toBe(1);
    await view.unmount();
  });

  it('says the passkey will be asked for, in plain words, and still submits', async () => {
    let sent = 0;
    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={{ kind: 'step-up' }}
        busy={false}
        refusal={null}
        submitLabel="Sign out"
        variant="danger"
        onSubmit={() => {
          sent += 1;
        }}
      />,
    );
    const note = view.container.querySelector('[data-change-step-up]')?.textContent ?? '';
    expect(note).toBe('studio-mac will ask you to confirm with your passkey when you save.');
    expect(note.toLowerCase()).not.toContain('password');
    const submit = must(view.container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'submit');
    expect(submit.disabled).toBe(false);
    await click(submit, 'submit');
    expect(sent).toBe(1);
    await view.unmount();

    const busy = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
        authority={{ kind: 'step-up' }}
        busy
        busyLabel="Signing out…"
        refusal={null}
        submitLabel="Sign out"
        onSubmit={() => undefined}
      />,
    );
    expect(busy.container.querySelector('[data-change-submit]')?.textContent).toBe('Signing out…');
    expect((busy.container.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await busy.unmount();
  });

  it('a grant refusal says why, in the shared words, and offers no button that works', async () => {
    const view = await mount(
      <ChangeApplyPanel
        machineName="studio-mac"
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

function HookHost({ client, probe }: { readonly client: RuntimesClient; readonly probe: Probe }) {
  const changes = useAccountChanges({ client });
  probe.current = changes;
  return (
    <p data-authority={changes.authority?.kind ?? 'reading'} data-busy={String(changes.busy)}>
      {changes.refusal ?? ''}
    </p>
  );
}

const hookView = async (client: RuntimesClient) => {
  const probe: Probe = { current: null };
  const view = await mount(<HookHost client={client} probe={probe} />);
  await settle();
  return { view, probe, hooks: () => must(probe.current, 'hook') };
};

describe('useAccountChanges', () => {
  it('reads authority, applies a change and keeps nothing to show when it worked', async () => {
    const client = scripted({ [MACHINE]: machine(), [PROPOSE]: stagedFrom, [APPLY]: APPLIED });
    const { view, hooks } = await hookView(client);
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('open');
    let result: ChangeResult | undefined;
    await interact(async () => {
      result = await hooks().apply(CHANGE);
    });
    expect(result).toMatchObject({ kind: 'applied', outcome: APPLIED });
    expect(view.container.querySelector('p')?.textContent).toBe('');
    expect(view.container.querySelector('[data-busy]')?.getAttribute('data-busy')).toBe('false');
    await view.unmount();
  });

  it('shows a refusal, clears it, and stages then applies separately', async () => {
    const off = refusal(
      'Account setup changes are switched off on this machine for now.',
      409,
      'fleet_change_disabled',
    );
    let stageAnswer: unknown = off;
    const client = scripted({ [MACHINE]: machine(), [PROPOSE]: () => stageAnswer, [APPLY]: APPLIED });
    const { view, hooks } = await hookView(client);
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
      if (staged?.kind !== 'staged') throw new Error('not staged');
      applied = await hooks().applyStaged(staged.staged);
    });
    expect(applied).toMatchObject({ kind: 'applied' });
    await view.unmount();
  });

  it('reads a step-up-required machine as the step-up authority and still applies', async () => {
    const client = scripted({
      [MACHINE]: machineWith({ mayApply: false, applyRefusal: 'step-up-required' }),
      [PROPOSE]: stagedFrom,
      [APPLY]: APPLIED,
    });
    const { view, hooks } = await hookView(client);
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('step-up');
    let result: ChangeResult | undefined;
    await interact(async () => {
      result = await hooks().apply(CHANGE);
    });
    expect(result).toMatchObject({ kind: 'applied' });
    await view.unmount();
  });

  it('shows a sentence the caller worded where a refusal shows', async () => {
    const { view, hooks } = await hookView(scripted({ [MACHINE]: machine() }));
    await interact(() => hooks().refuse('Claude didn’t accept that code.'));
    expect(view.container.querySelector('p')?.textContent).toBe('Claude didn’t accept that code.');
    await view.unmount();
  });

  it('an unreachable machine reads as unreadable authority and a refused change', async () => {
    const { view, hooks } = await hookView(scripted({}));
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('unreadable');
    let result: ChangeResult | undefined;
    await interact(async () => {
      result = await hooks().apply(CHANGE);
    });
    expect(result).toMatchObject({ kind: 'refused' });
    expect(view.container.querySelector('p')?.textContent).toContain('didn’t answer');
    await view.unmount();
  });

  it('starts over for another machine’s client, and can apply before authority landed', async () => {
    const probe: Probe = { current: null };
    let release: (answer: unknown) => void = () => undefined;
    const slowMachine = new Promise<unknown>(resolve => {
      release = resolve;
    });
    const studio = scripted({ [MACHINE]: () => slowMachine, [PROPOSE]: stagedFrom, [APPLY]: APPLIED });
    const other = scripted({ [MACHINE]: machine(), [PROPOSE]: stagedFrom, [APPLY]: APPLIED });
    const view = await mount(<HookHost client={studio} probe={probe} />);
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('reading');
    await view.render(<HookHost client={other} probe={probe} />);
    release(machineWith({ mayApply: false, applyRefusal: 'not-granted' }));
    await settle();
    // The first machine's late answer never lands on the second.
    expect(view.container.querySelector('[data-authority]')?.getAttribute('data-authority')).toBe('open');
    await view.unmount();

    const early: Probe = { current: null };
    const pending = await mount(<HookHost client={other} probe={early} />);
    let result: ChangeResult | undefined;
    await interact(async () => {
      result = await must(early.current, 'hook').apply(CHANGE);
    });
    expect(result).toMatchObject({ kind: 'applied' });
    await pending.unmount();
  });
});
