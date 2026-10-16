import { describe, expect, it } from 'bun:test';
import {
  type FleetCredentialList,
  FleetCredentialListSchema,
  FleetLayeredProfileCatalogSchema,
  type FleetMachineView,
  FleetRuntimeCatalogSchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import {
  AddRuntime,
  type AddRuntimeDraft,
  addRuntimeFlowInput,
  EMPTY_ADD_RUNTIME,
  type ProfileBuilder,
  type ProfileBuilderStepProps,
} from '../../../../../src/features/fleet/runtimes/add-runtime.tsx';
import type { MachineData } from '../../../../../src/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../../src/features/fleet/shell/apply-change-panel.tsx';
import {
  goToStep,
  returnToParent,
  type StepperState,
  saveForReuse,
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
  DATA,
  machine,
  PROFILES,
  profile,
  READS,
  RUNTIMES,
  runtime,
  STUDIO,
  scripted,
  stagedFrom,
  withStatus,
} from '../account-support.ts';

const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;

const credentialsOf = (...items: ReturnType<typeof credential>[]): FleetCredentialList =>
  FleetCredentialListSchema.parse({ format: 2, machine: 'studio-mac', credentials: items });

const NO_LOGINS: MachineData = { ...DATA, credentials: credentialsOf() };
const NO_PROFILES: MachineData = {
  ...DATA,
  profiles: FleetLayeredProfileCatalogSchema.parse({ ...PROFILES, profiles: [] }),
};
const SIGN_IN_NEEDED: MachineData = {
  ...DATA,
  credentials: credentialsOf(
    credential({ id: 'claude-work', label: 'work', ...withStatus('needs_sign_in'), usedBy: ['claude-work'] }),
    CREDENTIALS.credentials[0] as ReturnType<typeof credential>,
  ),
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 4; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const waitFor = async (container: ParentNode, selector: string): Promise<Element> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = container.querySelector(selector);
    if (found !== null) return found;
    await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
  }
  throw new Error(`expected ${selector} to appear`);
};

const click = async (container: ParentNode, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
};

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const text = (container: ParentNode, selector: string): string =>
  must(container.querySelector(selector), selector).textContent ?? '';

const stepAt = (step: string): StepperState => goToStep(startStepper(addRuntimeFlowInput()), step);

interface HostOptions {
  readonly data?: MachineData;
  /** What the next re-read answers. */
  readonly after?: MachineData;
  readonly routes?: Record<string, unknown>;
  readonly calls?: Call[];
  readonly machine?: FleetMachineView | null;
  readonly online?: boolean;
  readonly profileBuilder?: ProfileBuilder;
  readonly state?: StepperState;
  readonly draft?: Partial<AddRuntimeDraft>;
  readonly finishes?: (string | null)[];
  readonly reloads?: string[];
}

const mountHost = async (options: HostOptions = {}) => {
  const client: FleetClient = scripted(options.routes ?? READS(), options.calls);
  const createClient = async (): Promise<FleetClient> => client;
  const initial = options.data ?? DATA;
  const startState = options.state ?? startStepper(addRuntimeFlowInput());
  const startDraft: AddRuntimeDraft = { ...EMPTY_ADD_RUNTIME, ...options.draft };

  function Host() {
    const [state, setState] = useState<StepperState | null>(startState);
    const [draft, setDraft] = useState<AddRuntimeDraft>(startDraft);
    const [data, setData] = useState<MachineData>(initial);
    const changes = useAccountChanges({ connection: STUDIO, createClient });
    if (state === null) return <p data-left="">left</p>;
    return (
      <>
        <AddRuntime
          state={state}
          onState={setState}
          draft={draft}
          onDraft={setDraft}
          data={data}
          reload={async () => {
            options.reloads?.push('reload');
            const next = options.after ?? data;
            setData(next);
            return next;
          }}
          changes={changes}
          machine={options.machine === undefined ? machine() : options.machine}
          machineName="studio-mac"
          online={options.online ?? true}
          checking={false}
          onRetry={() => undefined}
          connection={STUDIO}
          createClient={createClient}
          {...(options.profileBuilder === undefined ? {} : { profileBuilder: options.profileBuilder })}
          onFinish={open => options.finishes?.push(open)}
          pollMs={5}
        />
        <pre data-draft="">{JSON.stringify(draft)}</pre>
      </>
    );
  }

  const view = await mount(<Host />);
  await settle();
  return view;
};

const draftOf = (container: ParentNode): AddRuntimeDraft => JSON.parse(text(container, '[data-draft]'));

const flowName = (container: ParentNode): string | null | undefined =>
  container.querySelector('[data-machine-stepper]')?.getAttribute('data-machine-stepper');

const NOT_INSTALLED_CODEX = machine({
  tools: [
    { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: false },
  ],
});

describe('Add runtime: the flow', () => {
  it('is Credential → Profile → Name → Done, and leaving it stops with no runtime', async () => {
    expect(addRuntimeFlowInput().steps.map(step => step.label)).toEqual(['Credential', 'Profile', 'Name', 'Done']);
    const view = await mountHost();
    expect(text(view.container, '#machine-stepper-title')).toBe('Add a runtime');
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 1 of 3 · Credential');
    await click(view.container, '[data-stepper-cancel]');
    expect(text(view.container, '[data-stepper-confirm]')).toContain('Stop adding a runtime?');
    expect(text(view.container, '[data-stepper-confirm]')).toContain('No runtime is created.');
    await click(view.container, '[data-stepper-stop]');
    expect(view.container.querySelector('[data-left]')).not.toBeNull();
    await view.unmount();
  });

  it('pauses while the machine is offline, keeping the step', async () => {
    const view = await mountHost({ online: false });
    expect(view.container.querySelector('[data-add-runtime-step]')).toBeNull();
    expect(text(view.container, '[data-stepper-paused]')).toContain('studio-mac is asleep or offline');
    await view.unmount();
  });
});

describe('Add runtime: Credential', () => {
  it('lists the logins, claude first, with their status and use; Next waits for a pick', async () => {
    const view = await mountHost();
    const rows = [...view.container.querySelectorAll('[data-add-runtime-credential]')];
    expect(rows.map(row => row.getAttribute('data-add-runtime-credential'))).toEqual([
      'claude-personal',
      'claude-work',
      'codex',
    ]);
    expect(text(view.container, '[data-add-runtime-credential="claude-personal"]')).toContain('you@example.com');
    expect(text(view.container, '[data-add-runtime-credential="claude-personal"]')).toContain('personal');
    expect(text(view.container, '[data-add-runtime-credential="claude-personal"]')).toContain('Claude Code');
    expect(text(view.container, '[data-add-runtime-credential="claude-personal"]')).toContain('Ready');
    expect(text(view.container, '[data-add-runtime-credential="claude-personal"]')).toContain('used by 3 runtimes');
    expect(text(view.container, '[data-add-runtime-credential="codex"]')).toContain('used by 1 runtime');
    expect(text(view.container, '[data-add-runtime-credential="claude-work"]')).toContain('Refresh due');
    expect(text(view.container, '[data-add-runtime-step="credential"] p')).toBe('Which login should this runtime use?');
    const next = must(view.container.querySelector<HTMLButtonElement>('[data-step-next]'), 'next');
    expect(next.disabled).toBe(true);
    expect(next.textContent).toBe('Next');
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    expect(draftOf(view.container).credentialId).toBe('claude-personal');
    expect(next.disabled).toBe(false);
    await click(view.container, '[data-step-next]');
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 2 of 3 · Profile');
    await view.unmount();
  });

  it('picking another login clears what was chosen after it; picking the same one keeps it', async () => {
    const view = await mountHost({
      draft: { credentialId: 'claude-personal', profile: 'Review', name: 'claude-review-2', addAnother: true },
    });
    const radio = must(
      view.container.querySelector<HTMLInputElement>('[data-add-runtime-credential="claude-personal"] input'),
      'radio',
    );
    expect(radio.checked).toBe(true);
    const props = must(
      Object.keys(radio).find(key => key.startsWith('__reactProps')),
      'react props',
    );
    await interact(() => (radio as unknown as Record<string, { onChange: () => void }>)[props]?.onChange());
    expect(draftOf(view.container).profile).toBe('Review');
    await click(view.container, '[data-add-runtime-credential="codex"] input');
    expect(draftOf(view.container)).toMatchObject({
      credentialId: 'codex',
      profile: null,
      name: '',
      addAnother: false,
    });
    await view.unmount();
  });

  it('says on the login when its tool is not installed here', async () => {
    const view = await mountHost({ machine: NOT_INSTALLED_CODEX });
    expect(text(view.container, '[data-add-runtime-credential="codex"]')).toContain('Codex isn’t installed here');
    expect(text(view.container, '[data-add-runtime-credential="claude-personal"]')).not.toContain('installed here');
    await view.unmount();
  });

  it('E13: a login that needs sign-in can be signed in here, or later', async () => {
    const reloads: string[] = [];
    const view = await mountHost({
      data: SIGN_IN_NEEDED,
      reloads,
      routes: {
        ...READS(SIGN_IN_NEEDED),
        'POST /v1/fleet/login': claudeFlow('awaiting-code', 'claude-work'),
        'GET /v1/fleet/login/flow-1': claudeFlow('complete', 'claude-work'),
      },
    });
    expect(view.container.querySelector('[data-credential-sign-in]')).toBeNull();
    await click(view.container, '[data-add-runtime-credential="claude-work"] input');
    expect(text(view.container, '[data-credential-sign-in="start"]')).toContain('Sign in to Claude Code');
    expect(text(view.container, '[data-step-next]')).toBe('Next, sign in later');
    await click(view.container, '[data-credential-sign-in="start"] [data-change-submit]');
    await waitFor(view.container, '[data-credential-sign-in="complete"]');
    expect(reloads).toEqual(['reload']);
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    expect(text(view.container, '[data-step-next]')).toBe('Next');
    expect(view.container.querySelector('[data-credential-sign-in]')).toBeNull();
    await view.unmount();
  });

  it('"+ Add a new login" opens Add a login on the Choose tool step, and Back returns here', async () => {
    const view = await mountHost();
    expect(text(view.container, '[data-add-row="login"]')).toBe('Add a new login');
    await click(view.container, '[data-add-row="login"]');
    expect(flowName(view.container)).toBe('add-login');
    expect(text(view.container, '[data-add-login-step="tool"] p')).toBe(
      'Which tool do you want to sign in to on studio-mac?',
    );
    expect(draftOf(view.container).loginHarness).toBeNull();
    await click(view.container, '[data-stepper-back]');
    expect(flowName(view.container)).toBe('add-runtime');
    expect(view.container.querySelector('[data-add-runtime-step="credential"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('Add runtime: no logins (E12)', () => {
  it('asks for a login first, with one button per tool, and nothing to go Next to', async () => {
    const view = await mountHost({ data: NO_LOGINS, machine: NOT_INSTALLED_CODEX });
    expect(text(view.container, '[data-add-runtime-step="no-logins"] h4')).toBe('Add a login first');
    expect(text(view.container, '[data-add-runtime-step="no-logins"] p')).toBe(
      'A runtime needs a login to Claude Code or Codex. You don’t have one on studio-mac yet. Pick which one to sign in to.',
    );
    const claude = must(
      view.container.querySelector<HTMLButtonElement>('[data-add-runtime-login="claude"]'),
      'claude button',
    );
    expect(claude.textContent).toContain('Sign in to Claude Code');
    expect(claude.textContent).toContain('Installed on studio-mac');
    expect(claude.disabled).toBe(false);
    const codex = must(
      view.container.querySelector<HTMLButtonElement>('[data-add-runtime-login="codex"]'),
      'codex button',
    );
    expect(codex.textContent).toContain('Sign in to Codex');
    expect(codex.textContent).toContain('Not installed on studio-mac · install it in Settings');
    expect(codex.disabled).toBe(true);
    expect(must(view.container.querySelector<HTMLButtonElement>('[data-step-next]'), 'next').disabled).toBe(true);
    await view.unmount();
  });

  it('signs in to a tool in place and comes back with the new login picked, saved for reuse', async () => {
    const created: MachineData = {
      ...DATA,
      credentials: credentialsOf(credential({ id: 'claude', email: 'new@example.com' })),
    };
    const calls: Call[] = [];
    const reloads: string[] = [];
    const view = await mountHost({
      data: NO_LOGINS,
      after: created,
      calls,
      reloads,
      routes: {
        ...READS(NO_LOGINS),
        'POST /v1/fleet/proposals': (call: Call) => stagedFrom(call),
        [APPLY]: APPLIED,
        'POST /v1/fleet/login': claudeFlow('awaiting-code', 'claude'),
        'GET /v1/fleet/login/flow-1': claudeFlow('complete', 'claude'),
      },
    });
    await click(view.container, '[data-add-runtime-login="claude"]');
    expect(flowName(view.container)).toBe('add-login');
    expect(draftOf(view.container).loginHarness).toBe('claude');
    expect(text(view.container, '[data-add-login-step="start"] p')).toBe(
      'Sign in to Claude Code. The login is kept on studio-mac.',
    );
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-login-step="signed-in"]');
    expect(calls.find(call => call.path === '/v1/fleet/proposals')?.body).toEqual({
      change: { kind: 'credential.add', id: 'claude', harness: 'claude' },
    });
    await click(view.container, '[data-step-next]');
    expect(flowName(view.container)).toBe('add-runtime');
    expect(draftOf(view.container)).toMatchObject({ credentialId: 'claude', profile: null, name: '' });
    expect(
      must(view.container.querySelector<HTMLInputElement>('[data-add-runtime-credential="claude"] input'), 'new login')
        .checked,
    ).toBe(true);

    await click(view.container, '[data-step-next]');
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    await click(view.container, '[data-step-next]');
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-step="done"]');
    expect(text(view.container, '[data-add-runtime-saved]')).toBe('Also saved for reuse: Claude Code login.');
    expect(text(view.container, '[data-add-runtime-step="done"] [role="status"]')).toContain(
      'Claude Code · new@example.com · Claude hooks profile.',
    );
    await view.unmount();
  });
});

describe('Add runtime: Profile', () => {
  const profileStep = { state: stepAt('profile') };

  it('lists the profiles with their size; Next waits for a pick and carries a suggested name on', async () => {
    const view = await mountHost({ ...profileStep, draft: { credentialId: 'claude-personal' } });
    expect(text(view.container, '[data-add-runtime-step="profile"] p')).toBe(
      'Which profile should it use with you@example.com on Claude Code?',
    );
    const names = [...view.container.querySelectorAll('[data-add-runtime-profile]')].map(row =>
      row.getAttribute('data-add-runtime-profile'),
    );
    expect(names).toEqual(['Default', 'Claude hooks', 'Agent work', 'Review']);
    expect(text(view.container, '[data-add-runtime-profile="Default"]')).toContain('2 parts');
    expect(view.container.querySelector('[data-add-runtime-profile="Default"] [data-tone="warn"]')).toBeNull();
    expect(view.container.querySelector('[data-profile-unavailable]')).toBeNull();
    const next = must(view.container.querySelector<HTMLButtonElement>('[data-step-next]'), 'next');
    expect(next.disabled).toBe(true);
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    expect(next.disabled).toBe(false);
    await click(view.container, '[data-step-next]');
    expect(draftOf(view.container).name).toBe('claude-claude-hooks');
    expect(text(view.container, '[data-stepper-position]')).toBe('Step 3 of 3 · Name');
    await view.unmount();
  });

  it('keeps a name already chosen when Next is pressed again', async () => {
    const view = await mountHost({
      ...profileStep,
      draft: { credentialId: 'claude-personal', profile: 'Claude hooks', name: 'mine' },
    });
    await click(view.container, '[data-step-next]');
    expect(draftOf(view.container).name).toBe('mine');
    await view.unmount();
  });

  it('E14: a profile that does not apply to the login’s tool is disabled, with the machine’s reason; partial fits carry notes', async () => {
    const view = await mountHost({ ...profileStep, draft: { credentialId: 'codex' } });
    const hooks = must(
      view.container.querySelector<HTMLInputElement>('[data-add-runtime-profile="Claude hooks"] input'),
      'hooks radio',
    );
    expect(hooks.disabled).toBe(true);
    expect(text(view.container, '[data-profile-unavailable]')).toBe(
      'Only Claude settings. Nothing here applies on Codex.',
    );
    const notes = [...view.container.querySelectorAll('[data-add-runtime-profile="Default"] [data-tone="warn"]')];
    expect(notes.map(note => note.textContent)).toEqual([
      'Claude settings will be skipped on Codex',
      'Partly supported on Codex',
    ]);
    expect(text(view.container, '[data-add-runtime-profile="Default"]')).toContain('3 parts');
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    expect(draftOf(view.container).profile).toBeNull();
    await view.unmount();
  });

  it("P7: offers Generic and this login's own profiles first; the other tool's and a mixed one wait below, disabled, saying why", async () => {
    const scoped: MachineData = {
      ...DATA,
      profiles: FleetLayeredProfileCatalogSchema.parse({
        ...PROFILES,
        profiles: [
          profile({ name: 'Codex work', scope: { kind: 'scoped', scope: 'codex' } }),
          profile({ name: 'Old mix', scope: { kind: 'mixed', sentence: "Profile Old mix can't be both." } }),
          profile({ name: 'Claude work', scope: { kind: 'scoped', scope: 'claude' } }),
        ],
      }),
    };
    const view = await mountHost({ ...profileStep, data: scoped, draft: { credentialId: 'claude-personal' } });
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-add-runtime-profile]')];
    expect(rows.map(row => row.dataset.addRuntimeProfile)).toEqual(['Claude work', 'Codex work', 'Old mix']);
    expect(text(view.container, '[data-add-runtime-profile="Claude work"]')).toContain('Claude only');
    const codex = must(
      view.container.querySelector<HTMLInputElement>('[data-add-runtime-profile="Codex work"] input'),
      'codex',
    );
    expect(codex.disabled).toBe(true);
    expect(text(view.container, '[data-add-runtime-profile="Codex work"] [data-profile-unavailable]')).toBe(
      'Codex only — this login is Claude Code',
    );
    expect(text(view.container, '[data-add-runtime-profile="Old mix"] [data-profile-unavailable]')).toBe(
      "Profile Old mix can't be both.",
    );
    await view.unmount();
  });

  it('says so when the machine has no profiles', async () => {
    const view = await mountHost({ ...profileStep, data: NO_PROFILES, draft: { credentialId: 'claude-personal' } });
    expect(text(view.container, '[data-add-runtime-step="profile"]')).toContain(
      'There are no profiles on studio-mac yet.',
    );
    expect(view.container.querySelector('[data-add-runtime-profile]')).toBeNull();
    expect(view.container.querySelector('[data-add-row="profile"]')).toBeNull();
    await view.unmount();
  });

  it('E15: the same login and profile can be added again anyway, or another profile picked', async () => {
    const view = await mountHost({ ...profileStep, draft: { credentialId: 'claude-personal' } });
    await click(view.container, '[data-add-runtime-profile="Review"] input');
    const duplicate = must(view.container.querySelector('[data-add-runtime-duplicate]'), 'duplicate');
    expect(duplicate.textContent).toContain('claude-review already uses this login and profile.');
    expect(duplicate.textContent).toContain('Add another anyway?');
    const next = must(view.container.querySelector<HTMLButtonElement>('[data-step-next]'), 'next');
    expect(next.disabled).toBe(true);

    await click(view.container, '[data-duplicate-no]');
    expect(draftOf(view.container).profile).toBeNull();
    expect(view.container.querySelector('[data-add-runtime-duplicate]')).toBeNull();

    await click(view.container, '[data-add-runtime-profile="Review"] input');
    await click(view.container, '[data-duplicate-ok]');
    expect(draftOf(view.container).addAnother).toBe(true);
    expect(text(view.container, '[data-add-runtime-duplicate]')).toContain('OK, you’ll get a second one');
    expect(view.container.querySelector('[data-duplicate-ok]')).toBeNull();
    expect(next.disabled).toBe(false);
    await click(view.container, '[data-step-next]');
    expect(draftOf(view.container).name).toBe('claude-review-2');
    await view.unmount();
  });

  it('no "+ Build a new profile" row is offered without a builder', async () => {
    const view = await mountHost({ ...profileStep, draft: { credentialId: 'claude-personal' } });
    expect(view.container.querySelector('[data-add-row="profile"]')).toBeNull();
    await view.unmount();
  });

  it('"+ Build a new profile" opens the injected builder for this login’s tool and comes back with the profile picked', async () => {
    const seen: ProfileBuilderStepProps[] = [];
    const asked: (string | undefined)[] = [];
    const builder: ProfileBuilder = {
      kind: 'build-profile',
      flowInput: ({ harness }) => {
        asked.push(harness);
        return {
          kind: 'build-profile',
          title: 'Build a profile',
          steps: [{ id: 'only', label: 'Only' }],
          leave: { question: 'Stop building?', consequence: 'No profile is made.', stopLabel: 'Stop' },
        };
      },
      Step: props => {
        seen.push(props);
        return (
          <button type="button" data-built="" onClick={() => props.onBuilt('Fresh', returnToParent(props.state))}>
            Built
          </button>
        );
      },
    };
    const after: MachineData = {
      ...DATA,
      profiles: FleetLayeredProfileCatalogSchema.parse({
        ...PROFILES,
        profiles: [...PROFILES.profiles, profile({ name: 'Fresh' })],
      }),
    };
    const reloads: string[] = [];
    const view = await mountHost({
      ...profileStep,
      draft: { credentialId: 'codex', profile: 'Default', name: 'x', addAnother: true },
      profileBuilder: builder,
      after,
      reloads,
    });
    expect(text(view.container, '[data-add-row="profile"]')).toBe('Build a new profile');
    await click(view.container, '[data-add-row="profile"]');
    expect(asked).toEqual(['codex']);
    expect(flowName(view.container)).toBe('build-profile');
    const props = must(seen[0], 'builder props');
    expect(props.harness).toBe('codex');
    expect(props.openedFromAddRuntime).toBe(true);
    expect(props.machineName).toBe('studio-mac');
    expect(props.machine?.name).toBe('studio-mac');
    expect(props.connection).toBe(STUDIO);

    await click(view.container, '[data-built]');
    expect(reloads).toEqual(['reload']);
    expect(flowName(view.container)).toBe('add-runtime');
    expect(draftOf(view.container)).toMatchObject({ profile: 'Fresh', name: '', addAnother: false });
    expect(
      must(view.container.querySelector<HTMLInputElement>('[data-add-runtime-profile="Fresh"] input'), 'fresh radio')
        .checked,
    ).toBe(true);
    await view.unmount();
  });
});

describe('Add runtime: Name', () => {
  const nameStep = {
    state: stepAt('name'),
    draft: { credentialId: 'claude-personal', profile: 'Claude hooks', name: 'claude-claude-hooks' },
  };
  const input = (container: ParentNode) =>
    must(container.querySelector<HTMLInputElement>('#add-runtime-name'), 'name input');
  const submit = (container: ParentNode) =>
    must(container.querySelector<HTMLButtonElement>('[data-change-submit]'), 'submit');

  it('shows the login and profile chosen, the suggested name, and the agent choice', async () => {
    const view = await mountHost(nameStep);
    expect(text(view.container, '[data-add-runtime-step="name"] .kt-panel')).toContain('you@example.com');
    expect(text(view.container, '[data-add-runtime-step="name"] .kt-panel')).toContain(
      'Claude Code · Claude hooks profile',
    );
    expect(input(view.container).value).toBe('claude-claude-hooks');
    expect(view.container.querySelector('[data-runtime-name-problem]')).toBeNull();
    expect(text(view.container, '[data-add-runtime-step="name"]')).toContain(
      'Letters, digits and dashes. You type this to launch it.',
    );
    expect(text(view.container, '[data-add-runtime-agent]')).toContain('Ferretry launches this as an agent');
    expect(text(view.container, '[data-add-runtime-agent]')).toContain(
      'Adds Ferretry’s fixed layer last: no trust or onboarding prompts, and the machine’s agent permissions.',
    );
    expect(submit(view.container).textContent).toBe('Create runtime');
    expect(submit(view.container).disabled).toBe(false);
    await view.unmount();
  });

  it('E16: an invalid name says why, offers one that works, and cannot be created until fixed', async () => {
    const view = await mountHost(nameStep);
    await type(input(view.container), 'bad name!');
    expect(text(view.container, '[data-runtime-name-problem]')).toContain('Use only letters, digits and dashes.');
    expect(input(view.container).getAttribute('aria-invalid')).toBe('true');
    expect(submit(view.container).disabled).toBe(true);
    expect(text(view.container, '[data-runtime-name-suggestion]')).toBe('Use bad-name');
    await click(view.container, '[data-runtime-name-suggestion]');
    expect(input(view.container).value).toBe('bad-name');
    expect(view.container.querySelector('[data-runtime-name-problem]')).toBeNull();
    expect(submit(view.container).disabled).toBe(false);
    await view.unmount();
  });

  it('E16: a name already taken offers the next free one', async () => {
    const view = await mountHost(nameStep);
    await type(input(view.container), 'claude-default');
    expect(text(view.container, '[data-runtime-name-problem]')).toContain(
      'claude-default is already a runtime on studio-mac.',
    );
    expect(text(view.container, '[data-runtime-name-suggestion]')).toBe('Use claude-default-2');
    await click(view.container, '[data-runtime-name-suggestion]');
    expect(input(view.container).value).toBe('claude-default-2');
    await view.unmount();
  });

  it('an empty name asks for one and offers nothing; spaces typed around a name are trimmed', async () => {
    const view = await mountHost(nameStep);
    await type(input(view.container), '');
    expect(text(view.container, '[data-runtime-name-problem]')).toContain('Give the runtime a name.');
    expect(view.container.querySelector('[data-runtime-name-suggestion]')).toBeNull();
    expect(submit(view.container).disabled).toBe(true);
    await type(input(view.container), '  spaced  ');
    expect(input(view.container).value).toBe('spaced');
    await view.unmount();
  });

  it('creates the runtime with exactly what was chosen, including agent and add-another', async () => {
    const calls: Call[] = [];
    const reloads: string[] = [];
    const view = await mountHost({
      ...nameStep,
      draft: { ...nameStep.draft, addAnother: true },
      calls,
      reloads,
      routes: { ...READS(), 'POST /v1/fleet/proposals': (call: Call) => stagedFrom(call), [APPLY]: APPLIED },
    });
    await click(view.container, '[data-add-runtime-agent] input');
    expect(draftOf(view.container).agent).toBe(true);
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-step="done"]');
    expect(calls.find(call => call.path === '/v1/fleet/proposals')?.body).toEqual({
      change: {
        kind: 'runtime.put',
        name: 'claude-claude-hooks',
        credential: 'claude-personal',
        profile: 'Claude hooks',
        agent: true,
        create: true,
        addAnother: true,
      },
    });
    expect(reloads).toEqual(['reload']);
    expect(draftOf(view.container).made).toBe('claude-claude-hooks');
    expect(text(view.container, '[data-stepper-position]')).toBe('Add a runtime · done');
    await view.unmount();
  });

  it('sends no add-another when it was not asked for, and no agent unless ticked', async () => {
    const calls: Call[] = [];
    const view = await mountHost({
      ...nameStep,
      calls,
      routes: { ...READS(), 'POST /v1/fleet/proposals': (call: Call) => stagedFrom(call), [APPLY]: APPLIED },
    });
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-step="done"]');
    expect(calls.find(call => call.path === '/v1/fleet/proposals')?.body).toEqual({
      change: {
        kind: 'runtime.put',
        name: 'claude-claude-hooks',
        credential: 'claude-personal',
        profile: 'Claude hooks',
        agent: false,
        create: true,
      },
    });
    await view.unmount();
  });

  it('a refusal is one sentence on the same step, and nothing moves on until it works', async () => {
    let refuse = true;
    const view = await mountHost({
      ...nameStep,
      routes: {
        ...READS(),
        'POST /v1/fleet/proposals': (call: Call) =>
          refuse
            ? new FyHttpError('This change conflicts with the setup on this machine.', 409, 'fleet_change_conflict')
            : stagedFrom(call),
        [APPLY]: APPLIED,
      },
    });
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-change-refusal]');
    expect(text(view.container, '[data-change-refusal]')).toBe('This change conflicts with the setup on this machine.');
    expect(view.container.querySelector('[data-add-runtime-step="name"]')).not.toBeNull();
    expect(draftOf(view.container).made).toBeNull();
    refuse = false;
    await click(view.container, '[data-change-submit]');
    await waitFor(view.container, '[data-add-runtime-step="done"]');
    await view.unmount();
  });
});

describe('Add runtime: Done', () => {
  const doneStep = {
    state: stepAt('done'),
    draft: { credentialId: 'claude-personal', profile: 'Claude hooks', made: 'claude-claude-hooks' },
  };
  const withMade = (credentialId: string, status?: 'needs_sign_in'): MachineData => ({
    ...(status === undefined ? DATA : SIGN_IN_NEEDED),
    runtimes: FleetRuntimeCatalogSchema.parse({
      ...RUNTIMES,
      runtimes: [
        ...RUNTIMES.runtimes,
        runtime({
          name: 'claude-claude-hooks',
          profile: 'Claude hooks',
          credential: { id: credentialId, store: 'host', status: status ?? 'ready' },
        }),
      ],
    }),
  });

  it('says the runtime is ready, with its login and profile, and offers Back to Runtimes and Open', async () => {
    const finishes: (string | null)[] = [];
    const view = await mountHost({ ...doneStep, data: withMade('claude-personal'), finishes });
    expect(text(view.container, '[data-add-runtime-step="done"] [role="status"]')).toContain(
      'claude-claude-hooks is ready to launch',
    );
    expect(text(view.container, '[data-add-runtime-step="done"] [role="status"]')).toContain(
      'Claude Code · you@example.com · Claude hooks profile.',
    );
    expect(view.container.querySelector('[data-add-runtime-saved]')).toBeNull();
    expect(view.container.querySelector('[data-stepper-back]')).toBeNull();
    expect(text(view.container, '[data-add-runtime-finish="list"]')).toBe('Back to Runtimes');
    expect(text(view.container, '[data-add-runtime-finish="open"]')).toBe('Open claude-claude-hooks');
    await click(view.container, '[data-add-runtime-finish="list"]');
    await click(view.container, '[data-add-runtime-finish="open"]');
    expect(finishes).toEqual([null, 'claude-claude-hooks']);
    await view.unmount();
  });

  it('says to sign in before launching when the runtime’s login needs it', async () => {
    const view = await mountHost({
      ...doneStep,
      draft: { ...doneStep.draft, credentialId: 'claude-work' },
      data: withMade('claude-work', 'needs_sign_in'),
    });
    expect(text(view.container, '[data-add-runtime-step="done"] [role="status"]')).toContain(
      'Claude hooks profile. Sign in before you launch.',
    );
    await view.unmount();
  });

  it('lists what was saved for reuse along the way', async () => {
    const view = await mountHost({
      ...doneStep,
      state: saveForReuse(saveForReuse(stepAt('done'), 'Profile Fresh'), 'Claude Code login'),
      data: withMade('claude-personal'),
    });
    expect(text(view.container, '[data-add-runtime-saved]')).toBe(
      'Also saved for reuse: Profile Fresh, Claude Code login.',
    );
    await view.unmount();
  });

  it('still reads when the login is no longer there to name', async () => {
    const view = await mountHost({ state: stepAt('done'), draft: { profile: 'Claude hooks', made: 'gone' } });
    expect(text(view.container, '[data-add-runtime-step="done"] [role="status"]')).toContain('gone is ready to launch');
    expect(text(view.container, '[data-add-runtime-step="done"] [role="status"] p:last-child')).toBe(
      'Claude hooks profile.',
    );
    await view.unmount();
  });
});
