import { describe, expect, it } from 'bun:test';
import type { FleetCredentialList, FleetCredentialView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import { AddLoginStep, addLoginFlowInput } from '../../../../../src/features/fleet/credentials/add-login.tsx';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { useMachineData } from '../../../../../src/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../../src/features/fleet/shell/apply-change-panel.tsx';
import { MachineStepper } from '../../../../../src/features/fleet/shell/machine-stepper.tsx';
import {
  currentFlow,
  openSubStepper,
  type StepperState,
  startStepper,
} from '../../../../../src/features/fleet/shell/stepper-model.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  CREDENTIALS,
  claudeFlow,
  credential,
  machine,
  READS,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';

const CHANGES = 'POST /v1/fleet/proposals';
const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;
const LOGIN = 'POST /v1/fleet/login';
const FLOW = '/v1/fleet/login/flow-1';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

// One act per slice: a state change inside an act only commits (and so re-arms the poll) when that act ends.
const wait = async (ms: number): Promise<void> => {
  for (let elapsed = 0; elapsed < ms; elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
};

const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

const text = (container: HTMLElement, selector: string): string | undefined =>
  container.querySelector(selector)?.textContent ?? undefined;

const step = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-add-login-step]')?.getAttribute('data-add-login-step');

const submit = (container: HTMLElement): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'the submit button');

const next = (container: HTMLElement): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>('[data-step-next]'), 'the Next button');

const only = (calls: readonly Call[], key: string): Call[] =>
  calls.filter(call => `${call.method} ${call.path}` === key);

const withoutEmail = (id: string, harness: 'claude' | 'codex'): FleetCredentialView => {
  const fresh = { ...credential({ id, harness }) };
  delete fresh.email;
  return fresh;
};

const listOf = (credentials: readonly FleetCredentialView[]): FleetCredentialList => ({
  ...CREDENTIALS,
  credentials: [...credentials],
});

const PARENT = {
  kind: 'add-runtime',
  title: 'Add a runtime',
  steps: [
    { id: 'credential', label: 'Credential' },
    { id: 'done', label: 'Done', final: true },
  ],
  leave: { question: 'Stop adding a runtime?', consequence: 'No runtime is created.', stopLabel: 'Stop' },
} as const;

interface HostProps {
  readonly initial: StepperState;
  readonly harness?: 'claude' | 'codex';
  readonly tool: ReturnType<typeof machine> | null;
  readonly createClient: () => Promise<FleetClient>;
  readonly added: { id: string; next: StepperState | null }[];
  readonly pollMs?: number;
}

function Host({ initial, harness, tool, createClient, added, pollMs }: HostProps) {
  const [state, setState] = useState<StepperState>(initial);
  const [done, setDone] = useState(false);
  const { data, reload } = useMachineData(STUDIO, createClient);
  const changes = useAccountChanges({ connection: STUDIO, createClient });
  if (done) return <p data-done="">added</p>;
  return (
    <MachineStepper
      state={state}
      onChange={nextState => {
        if (nextState !== null) setState(nextState);
      }}
      machineName="studio-mac"
      online
      onRetry={() => undefined}
    >
      <AddLoginStep
        state={state}
        onChange={setState}
        onAdded={(id, parent) => {
          added.push({ id, next: parent });
          if (parent === null) setDone(true);
          else setState(parent);
        }}
        {...(harness === undefined ? {} : { harness })}
        machine={tool}
        machineName="studio-mac"
        connection={STUDIO}
        createClient={createClient}
        data={data}
        reload={reload}
        changes={changes}
        {...(pollMs === undefined ? {} : { pollMs })}
      />
    </MachineStepper>
  );
}

interface World {
  readonly existing: readonly FleetCredentialView[];
  readonly fresh: FleetCredentialView;
  readonly routes?: Record<string, unknown>;
  /** A staged change this answers with a refusal instead of staging. */
  readonly refuse?: (change: { kind: string; id: string }) => Error | undefined;
}

const open = async (world: World, props: Partial<Pick<HostProps, 'initial' | 'harness' | 'tool' | 'pollMs'>> = {}) => {
  const calls: Call[] = [];
  const added: HostProps['added'] = [];
  const made = { value: false };
  const client = scripted(
    {
      ...READS(),
      'GET /v1/fleet/credentials': () => listOf(made.value ? [...world.existing, world.fresh] : world.existing),
      [CHANGES]: (call: Call) => {
        const change = (call.body as { change: { kind: string; id: string } }).change;
        const refusal = world.refuse?.(change);
        if (refusal !== undefined) return refusal;
        if (change.kind === 'credential.add') made.value = true;
        return stagedFrom(call);
      },
      [APPLY]: APPLIED,
      ...world.routes,
    },
    calls,
  );
  const createClient = async (): Promise<FleetClient> => client;
  const view = await mount(
    <Host
      initial={
        props.initial ?? startStepper(addLoginFlowInput(props.harness === undefined ? {} : { harness: props.harness }))
      }
      tool={props.tool === undefined ? machine() : props.tool}
      createClient={createClient}
      added={added}
      {...(props.harness === undefined ? {} : { harness: props.harness })}
      {...(props.pollMs === undefined ? {} : { pollMs: props.pollMs })}
    />,
  );
  await settle();
  return { view, calls, added };
};

const changeBodies = (calls: readonly Call[]): unknown[] =>
  only(calls, CHANGES).map(call => (call.body as { change: unknown }).change);

describe('addLoginFlowInput', () => {
  it('has Choose tool and Sign in, or only Sign in when opened for a known tool', () => {
    expect(addLoginFlowInput().steps.map(candidate => candidate.label)).toEqual(['Choose tool', 'Sign in']);
    expect(addLoginFlowInput({ harness: 'codex' }).steps.map(candidate => candidate.label)).toEqual(['Sign in']);
    expect(addLoginFlowInput().leave).toEqual({
      question: 'Stop adding a login?',
      consequence: 'No new login is added. One you already signed in with is kept.',
      stopLabel: 'Stop',
    });
  });
});

describe('AddLoginStep · Choose tool', () => {
  it('offers both tools, disables the one that is not installed, and needs a choice before Next', async () => {
    const codexMissing = machine({
      tools: [
        { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
        { harness: 'codex', label: 'Codex', installed: false },
      ],
    });
    const { view } = await open(
      { existing: CREDENTIALS.credentials, fresh: credential({ id: 'claude' }) },
      { tool: codexMissing },
    );
    expect(step(view.container)).toBe('tool');
    expect(text(view.container, 'p')).toBe('Which tool do you want to sign in to on studio-mac?');
    expect(text(view.container, '[data-stepper-position]')).toBe('Choose tool · 1 of 2');
    expect(text(view.container, '[data-add-login-tool="claude"]')).toContain('Claude Code');
    expect(text(view.container, '[data-add-login-tool="claude"]')).toContain('Installed');
    expect(text(view.container, '[data-add-login-tool="codex"]')).toContain(
      'Not installed on studio-mac · install it in Settings',
    );
    const [claude, codex] = Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(claude?.disabled).toBe(false);
    expect(codex?.disabled).toBe(true);
    expect(next(view.container).disabled).toBe(true);
    await click(claude ?? null, 'the Claude radio');
    expect(claude?.checked).toBe(true);
    expect(next(view.container).disabled).toBe(false);
    await click(next(view.container), 'Next');
    expect(step(view.container)).toBe('start');
    expect(text(view.container, '[data-stepper-position]')).toBe('Sign in · 2 of 2');
    expect(text(view.container, '[data-add-login-step="start"] p')).toBe(
      'Sign in to Claude Code. The login is kept on studio-mac.',
    );
    await view.unmount();
  });

  it('a machine that has not answered with its setup has no tool installed', async () => {
    const { view } = await open({ existing: [], fresh: credential({ id: 'claude' }) }, { tool: null });
    const radios = Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map(radio => radio.disabled)).toEqual([true, true]);
    expect(view.container.textContent).toContain('Not installed on studio-mac');
    expect(next(view.container).disabled).toBe(true);
    await view.unmount();
  });
});

describe('AddLoginStep · Sign in', () => {
  it('makes the login, signs it in with the same click, and finishes when no other login has its email', async () => {
    const fresh = credential({ id: 'claude', email: 'new@example.com' });
    const { view, calls, added } = await open({
      existing: CREDENTIALS.credentials,
      fresh,
      routes: {
        [LOGIN]: claudeFlow('awaiting-code', 'claude'),
        [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete', 'claude') },
      },
    });
    await click(view.container.querySelector('[data-add-login-tool="claude"] input'), 'the Claude radio');
    await click(next(view.container), 'Next');
    expect(submit(view.container).textContent).toBe('Sign in to Claude Code');
    await click(submit(view.container), 'Sign in to Claude Code');

    expect(changeBodies(calls)).toEqual([{ kind: 'credential.add', id: 'claude', harness: 'claude' }]);
    expect(only(calls, APPLY)).toHaveLength(1);
    expect(only(calls, 'GET /v1/fleet/credentials').length).toBeGreaterThanOrEqual(2);
    expect(only(calls, LOGIN)[0]?.body).toEqual({ credentialId: 'claude' });
    expect(step(view.container)).toBe('signin');
    expect(text(view.container, '[data-add-login-step="signin"] p')).toBe(
      'Sign in to Claude Code. The login is kept on studio-mac.',
    );
    expect(view.container.querySelector('[data-claude-login="awaiting-code"]')).not.toBeNull();
    expect(view.container.textContent).toContain('https://claude.ai/oauth/authorize?code=true');

    await type(must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the code field'), 'code-from-page');
    await click(
      Array.from(view.container.querySelectorAll('button')).find(button => button.textContent === 'Finish sign-in') ??
        null,
      'Finish sign-in',
    );
    expect(only(calls, `POST ${FLOW}`)[0]?.body).toEqual({ code: 'code-from-page' });
    expect(step(view.container)).toBe('signed-in');
    expect(text(view.container, '[role="status"]')).toBe('Signed in to Claude Code as new@example.com');
    expect(added).toEqual([]);

    await click(next(view.container), 'Next');
    expect(added).toEqual([{ id: 'claude', next: null }]);
    expect(view.container.querySelector('[data-done]')).not.toBeNull();
    await view.unmount();
  });

  it('opened for one tool inside Add a runtime, it skips Choose tool and hands the parent back with the login saved', async () => {
    const fresh = withoutEmail('codex-2', 'codex');
    const initial = openSubStepper(startStepper(PARENT), addLoginFlowInput({ harness: 'codex' }));
    let reads = 0;
    const { view, calls, added } = await open(
      {
        existing: CREDENTIALS.credentials,
        fresh,
        routes: {
          [LOGIN]: {
            harness: 'codex',
            flowId: 'flow-1',
            credentialId: 'codex-2',
            identity: 'codex:new',
            startedAt: '2026-10-13T08:00:00.000Z',
            expiresAt: '2026-10-13T08:10:00.000Z',
            state: 'awaiting-approval',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: '0IER-FFQW6',
          },
          [`GET ${FLOW}`]: () => {
            reads += 1;
            return {
              harness: 'codex',
              flowId: 'flow-1',
              credentialId: 'codex-2',
              identity: 'codex:new',
              startedAt: '2026-10-13T08:00:00.000Z',
              expiresAt: '2026-10-13T08:10:00.000Z',
              state: 'complete',
            };
          },
        },
      },
      { initial, harness: 'codex', pollMs: 5 },
    );
    expect(step(view.container)).toBe('start');
    expect(text(view.container, '[data-stepper-position]')).toBe('Sign in · 1 of 1');
    expect(submit(view.container).textContent).toBe('Sign in to Codex');
    await click(submit(view.container), 'Sign in to Codex');
    expect(changeBodies(calls)).toEqual([{ kind: 'credential.add', id: 'codex-2', harness: 'codex' }]);
    expect(view.container.querySelector('[data-codex-login="awaiting-approval"]')).not.toBeNull();
    await wait(60);
    expect(reads).toBe(1);
    expect(step(view.container)).toBe('signed-in');
    expect(text(view.container, '[role="status"]')).toBe('Signed in to Codex as Codex login');

    await click(next(view.container), 'Next');
    expect(added).toHaveLength(1);
    expect(added[0]?.id).toBe('codex-2');
    const parent = must(added[0]?.next, 'the parent flow');
    expect(currentFlow(parent).kind).toBe('add-runtime');
    expect(currentFlow(parent).saved).toEqual(['Codex login']);
    await view.unmount();
  });

  it('says a login that could not be made, and makes nothing', async () => {
    const { view, calls } = await open(
      {
        existing: CREDENTIALS.credentials,
        fresh: credential({ id: 'claude' }),
        routes: {
          [CHANGES]: new FyHttpError(
            'Account setup changes are switched off on this machine for now.',
            409,
            'fleet_change_disabled',
          ),
        },
      },
      { harness: 'claude' },
    );
    await click(submit(view.container), 'Sign in to Claude Code');
    expect(step(view.container)).toBe('start');
    expect(text(view.container, '[data-change-refusal]')).toBe(
      'Account setup changes are switched off on this machine for now.',
    );
    expect(only(calls, APPLY)).toHaveLength(0);
    expect(only(calls, LOGIN)).toHaveLength(0);
    expect(text(view.container, '[data-stepper-position]')).toBe('Sign in · 1 of 1');
    await view.unmount();
  });

  it('a sign-in that will not start leaves the login made and starts from its own panel', async () => {
    let answer: unknown = new FyHttpError(
      'Claude Code is not installed on studio-mac.',
      409,
      'fleet_login_unavailable',
    );
    const { view, calls } = await open(
      {
        existing: CREDENTIALS.credentials,
        fresh: credential({ id: 'claude', email: 'new@example.com' }),
        routes: { [LOGIN]: () => answer },
      },
      { harness: 'claude' },
    );
    await click(submit(view.container), 'Sign in to Claude Code');
    expect(step(view.container)).toBe('signin');
    expect(text(view.container, '[data-add-login-step="signin"] > p[role="alert"]')).toBe(
      'Claude Code is not installed on studio-mac.',
    );
    expect(view.container.querySelector('[data-credential-sign-in="start"]')).not.toBeNull();

    answer = claudeFlow('awaiting-code', 'claude');
    await click(
      view.container.querySelector('[data-credential-sign-in="start"] [data-change-submit]'),
      'its own start',
    );
    expect(only(calls, LOGIN)).toHaveLength(2);
    expect(only(calls, LOGIN)[1]?.body).toEqual({ credentialId: 'claude' });
    expect(view.container.querySelector('[data-claude-login="awaiting-code"]')).not.toBeNull();
    expect(changeBodies(calls)).toHaveLength(1);
    await view.unmount();
  });
});

describe('AddLoginStep · Label (E26)', () => {
  const signedIn = async (world: World, props: Parameters<typeof open>[1] = {}) => {
    const routes = {
      [LOGIN]: claudeFlow('awaiting-code', 'claude'),
      [`POST ${FLOW}`]: { outcome: 'accepted', flow: claudeFlow('complete', 'claude') },
      ...world.routes,
    };
    const opened = await open({ ...world, routes }, { harness: 'claude', ...props });
    await click(submit(opened.view.container), 'Sign in to Claude Code');
    await type(must(opened.view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the code field'), 'a-code');
    await click(
      Array.from(opened.view.container.querySelectorAll('button')).find(
        button => button.textContent === 'Finish sign-in',
      ) ?? null,
      'Finish sign-in',
    );
    return opened;
  };

  it('asks for two different labels when this email already has a login, and saves both', async () => {
    const fresh = credential({ id: 'claude' });
    const { view, calls, added } = await signedIn({ existing: CREDENTIALS.credentials, fresh });
    expect(step(view.container)).toBe('signed-in');
    expect(text(view.container, '[role="status"]')).toBe('Signed in to Claude Code as you@example.com');
    await click(next(view.container), 'Next');

    expect(step(view.container)).toBe('label');
    expect(text(view.container, '[data-stepper-position]')).toBe('Label · 2 of 2');
    expect(text(view.container, '[data-add-login-step="label"] > p')).toBe(
      'You already have a Claude Code login for you@example.com. Label both so you can tell them apart.',
    );
    const older = must(view.container.querySelector<HTMLInputElement>('#add-login-label-old'), 'the old label');
    const newer = must(view.container.querySelector<HTMLInputElement>('#add-login-label-new'), 'the new label');
    expect(older.value).toBe('personal');
    expect(newer.value).toBe('work');
    expect(view.container.textContent).toContain('Used by 3 runtimes.');
    expect(view.container.querySelector('[data-add-login-label-error]')).toBeNull();
    expect(submit(view.container).textContent).toBe('Save labels');

    await type(newer, 'personal');
    expect(text(view.container, '[data-add-login-label-error]')).toBe('Use two different labels.');
    expect(submit(view.container).disabled).toBe(true);
    await type(newer, '   ');
    expect(text(view.container, '[data-add-login-label-error]')).toBe('Give each login a label.');
    await type(older, 'home');
    await type(newer, ' side ');
    expect(view.container.querySelector('[data-add-login-label-error]')).toBeNull();
    expect(submit(view.container).disabled).toBe(false);

    await click(submit(view.container), 'Save labels');
    expect(changeBodies(calls).slice(1)).toEqual([
      { kind: 'credential.label', id: 'claude-personal', label: 'home' },
      { kind: 'credential.label', id: 'claude', label: 'side' },
    ]);
    expect(added).toEqual([{ id: 'claude', next: null }]);
    await view.unmount();
  });

  it('a twin already labelled work leaves the new login to be "side"; an unlabelled twin is "personal"', async () => {
    const labelled = await signedIn({
      existing: [credential({ id: 'claude-work', label: 'work' })],
      fresh: credential({ id: 'claude' }),
    });
    await click(next(labelled.view.container), 'Next');
    expect(must(labelled.view.container.querySelector<HTMLInputElement>('#add-login-label-old'), 'old').value).toBe(
      'work',
    );
    expect(must(labelled.view.container.querySelector<HTMLInputElement>('#add-login-label-new'), 'new').value).toBe(
      'side',
    );
    expect(labelled.view.container.textContent).toContain('Used by 0 runtimes.');
    await labelled.view.unmount();

    const bare = await signedIn({
      existing: [credential({ id: 'claude-old', usedBy: ['claude-old'] })],
      fresh: credential({ id: 'claude' }),
    });
    await click(next(bare.view.container), 'Next');
    expect(must(bare.view.container.querySelector<HTMLInputElement>('#add-login-label-old'), 'old').value).toBe(
      'personal',
    );
    expect(must(bare.view.container.querySelector<HTMLInputElement>('#add-login-label-new'), 'new').value).toBe('work');
    expect(bare.view.container.textContent).toContain('Used by 1 runtime.');
    await bare.view.unmount();
  });

  it('a label that is refused stays on the step with the refusal, whichever of the two it was', async () => {
    const existing = [credential({ id: 'claude-personal', label: 'personal', usedBy: ['claude-default'] })];
    let refuseId: string | null = 'claude-personal';
    const { view, calls, added } = await signedIn({
      existing,
      fresh: credential({ id: 'claude' }),
      refuse: change =>
        change.kind === 'credential.label' && change.id === refuseId
          ? new FyHttpError(`Could not label ${change.id}.`, 409, 'fleet_change_refused')
          : undefined,
    });
    await click(next(view.container), 'Next');
    await click(submit(view.container), 'Save labels');
    expect(step(view.container)).toBe('label');
    expect(text(view.container, '[data-change-refusal]')).toBe('Could not label claude-personal.');
    expect(only(calls, APPLY)).toHaveLength(1);

    refuseId = 'claude';
    await click(submit(view.container), 'Save labels');
    expect(text(view.container, '[data-change-refusal]')).toBe('Could not label claude.');
    expect(added).toEqual([]);
    await view.unmount();
  });
});
