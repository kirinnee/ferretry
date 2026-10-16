import { describe, expect, it } from 'bun:test';
import type { FleetCredentialView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import { AddLoginStep, addLoginFlowInput } from '../../../../../src/features/fleet/credentials/add-login.tsx';
import { secretRef } from '../../../../../src/features/fleet/credentials/environment-model.ts';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { useMachineData } from '../../../../../src/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../../src/features/fleet/shell/apply-change-panel.tsx';
import { MachineStepper } from '../../../../../src/features/fleet/shell/machine-stepper.tsx';
import { type StepperState, startStepper } from '../../../../../src/features/fleet/shell/stepper-model.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  CREDENTIALS,
  credential,
  machine,
  READS,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';
import { ENVIRONMENT, FOUNDRY, PRESETS } from './environment-support.ts';

const CHANGES = 'POST /v1/fleet/proposals';
const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;
const PRESETS_READ = 'GET /v1/fleet/presets';
const SECRETS = 'GET /v1/secrets';
const STORE = 'POST /v1/secrets';

const secretList = (names: readonly string[]) => ({
  v: 1,
  health: 'ready',
  secrets: names.map(name => ({ name, createdAt: '2026-10-16T08:00:00.000Z', updatedAt: '2026-10-16T08:00:00.000Z' })),
  references: [],
});

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const type = async (field: Element | null, value: string): Promise<void> => {
  const input = must(field as HTMLInputElement | null, 'a field');
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const choose = async (select: Element | null, value: string): Promise<void> => {
  const element = must(select as HTMLSelectElement | null, 'the select');
  await interact(() => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

function Host({
  initial,
  harness,
  createClient,
  added,
}: {
  readonly initial: StepperState;
  readonly harness?: 'claude' | 'codex';
  readonly createClient: () => Promise<FleetClient>;
  readonly added: string[];
}) {
  const [state, setState] = useState<StepperState>(initial);
  const { data, reload } = useMachineData(STUDIO, createClient);
  const changes = useAccountChanges({ connection: STUDIO, createClient });
  return (
    <MachineStepper
      state={state}
      onChange={next => {
        if (next !== null) setState(next);
      }}
      machineName="studio-mac"
      online
      onRetry={() => undefined}
    >
      <AddLoginStep
        state={state}
        onChange={setState}
        onAdded={id => added.push(id)}
        {...(harness === undefined ? {} : { harness })}
        machine={machine()}
        machineName="studio-mac"
        connection={STUDIO}
        createClient={createClient}
        data={data}
        reload={reload}
        changes={changes}
      />
    </MachineStepper>
  );
}

const open = async (routes: Record<string, unknown> = {}, harness?: 'claude' | 'codex') => {
  const calls: Call[] = [];
  const made: FleetCredentialView[] = [];
  const client = scripted(
    {
      ...READS(),
      'GET /v1/fleet/credentials': () => ({ ...CREDENTIALS, credentials: [...CREDENTIALS.credentials, ...made] }),
      [PRESETS_READ]: PRESETS,
      [SECRETS]: secretList([]),
      [STORE]: (call: Call) => ({
        name: (call.body as { name: string }).name,
        createdAt: '2026-10-16T08:00:00.000Z',
        updatedAt: '2026-10-16T08:00:00.000Z',
      }),
      [CHANGES]: (call: Call) => {
        const change = (call.body as { change: { kind: string; id: string; preset?: string } }).change;
        if (change.kind === 'credential.add')
          made.push(
            change.preset === 'zai-glm'
              ? credential({ id: change.id, store: 'environment', environment: ENVIRONMENT })
              : credential({ id: change.id, store: 'environment' }),
          );
        return stagedFrom(call);
      },
      [APPLY]: APPLIED,
      ...routes,
    },
    calls,
  );
  const added: string[] = [];
  const view = await mount(
    <Host
      initial={startStepper(addLoginFlowInput(harness === undefined ? {} : { harness }))}
      {...(harness === undefined ? {} : { harness })}
      createClient={async () => client}
      added={added}
    />,
  );
  await click(view.container.querySelector('[data-add-login-kind-option="environment"] input'), 'Environment');
  return { view, calls, added };
};

const form = (container: HTMLElement) => container.querySelector('[data-env-login="form"]');

describe('AddLoginStep · Environment', () => {
  it('offers the presets by tool, with an unavailable one disabled with its reason and the preset facts', async () => {
    const { view } = await open();
    await until(() => form(view.container) !== null, 'the form');
    const c = view.container;
    const groups = Array.from(c.querySelectorAll('optgroup')).map(group => group.label);
    expect(groups).toEqual(['Claude Code', 'Codex']);
    const blocked = must(c.querySelector<HTMLOptionElement>('option[value="zai-glm-codex"]'), 'the Codex GLM option');
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toBe('GLM / Z.ai — not offered: Codex needs a model catalogue file.');
    const facts = c.querySelector('[data-env-preset-facts="zai-glm"]')?.textContent ?? '';
    expect(facts).toContain('Claude only');
    expect(facts).toContain('Z.ai’s Coding Plan quota.');
    expect(facts).toContain('https://docs.example.com/claude');
    expect(facts).toContain('2026-10-16');
    expect(facts).toContain('Not confirmed: The quota endpoint is community-documented.');
    expect(c.querySelector<HTMLInputElement>('[data-env-name]')?.value).toBe('zai-glm');
    expect(c.querySelector('[data-env-problem]')?.textContent).toBe('Store ZAI_API_KEY first.');
    expect(c.querySelector('[data-stepper-position]')?.textContent).toBe('Step 1 of 2 · Environment');
    await click(c.querySelector('[data-add-login-kind-option="signin"] input'), 'Sign in');
    expect(c.querySelector('[data-stepper-position]')?.textContent).toBe('Step 1 of 2 · Choose tool');
    expect(c.querySelector('[data-add-login-step="tool"]')).not.toBeNull();
    await view.unmount();
  });

  it('stores a pasted secret, clears it, shows set ✓, and adds the login from the preset', async () => {
    const { view, calls, added } = await open();
    await until(() => form(view.container) !== null, 'the form');
    const c = view.container;
    await type(c.querySelector('[data-env-secret-input="ZAI_API_KEY"]'), 'a-pasted-key-for-the-test');
    await click(c.querySelector('[data-env-secret-store="ZAI_API_KEY"]'), 'Store');
    await until(() => c.querySelector('[data-env-secret-set="ZAI_API_KEY"]') !== null, 'set ✓');
    expect(c.querySelector('[data-env-secret-set="ZAI_API_KEY"]')?.textContent).toContain(
      `${secretRef('ZAI_API_KEY')} set ✓`,
    );
    expect(calls.filter(call => `${call.method} ${call.path}` === STORE).map(call => call.body)).toEqual([
      { name: 'ZAI_API_KEY', value: 'a-pasted-key-for-the-test' },
    ]);
    expect(c.textContent).not.toContain('a-pasted-key-for-the-test');
    const timeout = must(c.querySelector('[data-env-variable="API_TIMEOUT_MS"] input'), 'the timeout field');
    expect((timeout as HTMLInputElement).placeholder).toBe('a timeout');
    await type(timeout, '600');
    await type(c.querySelector('[data-env-variable="ANTHROPIC_BASE_URL"] input'), '');
    expect(c.querySelector('[data-env-problem]')?.textContent).toBe('Fill in ANTHROPIC_BASE_URL.');
    expect((c.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await type(c.querySelector('[data-env-variable="ANTHROPIC_BASE_URL"] input'), 'https://api.z.ai/api/anthropic');
    await type(c.querySelector('[data-env-name]'), 'glm-work');
    await click(c.querySelector('[data-change-submit]'), 'Add login');
    await until(() => c.querySelector('[data-env-login="added"]') !== null, 'the added screen');
    const change = calls.find(call => `${call.method} ${call.path}` === CHANGES)?.body as { change: unknown };
    expect(change.change).toEqual({
      kind: 'credential.add',
      id: 'glm-work',
      harness: 'claude',
      store: 'environment',
      preset: 'zai-glm',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: secretRef('ZAI_API_KEY'),
        API_TIMEOUT_MS: '600',
        ANTHROPIC_API_KEY: '',
      },
    });
    expect(c.textContent).toContain('Added glm-work from GLM / Z.ai');
    expect(c.querySelector('[data-stepper-position]')?.textContent).toBe('Step 2 of 2 · Test');
    expect(c.querySelector('[data-add-login-step="test"]')).not.toBeNull();
    expect(c.querySelector('[data-add-login-kind]')).toBeNull();
    expect(c.textContent).toContain('Reads your quota. Spends nothing.');
    await click(c.querySelector('[data-step-next]'), 'Done');
    expect(added).toEqual(['glm-work']);
    await view.unmount();
  });

  it('says why a secret could not be stored, and forgets the pasted value', async () => {
    const { view } = await open({
      [STORE]: new FyHttpError('The secret store is damaged.', 503, 'secret_store_damaged'),
    });
    await until(() => form(view.container) !== null, 'the form');
    const c = view.container;
    const input = c.querySelector('[data-env-secret-input="ZAI_API_KEY"]');
    await type(input, 'another-pasted-key-value');
    await click(c.querySelector('[data-env-secret-store="ZAI_API_KEY"]'), 'Store');
    await until(() => c.querySelector('[data-env-store-error]') !== null, 'the store error');
    expect(c.querySelector('[data-env-store-error]')?.textContent).toBe('The secret store is damaged.');
    expect((c.querySelector('[data-env-secret-input="ZAI_API_KEY"]') as HTMLInputElement).value).toBe('');
    await view.unmount();
  });

  it('switches preset, takes a cloud reference, and offers only one tool’s presets when opened for it', async () => {
    const { view, calls } = await open({ [SECRETS]: secretList(['FOUNDRY_KEY']) });
    await until(() => form(view.container) !== null, 'the form');
    const c = view.container;
    await choose(c.querySelector('[data-env-preset]'), 'amazon-bedrock');
    expect(c.querySelector('[data-env-cloud] input')).not.toBeNull();
    expect((c.querySelector('[data-env-cloud] input') as HTMLInputElement).value).toBe('aws-profile:default');
    await type(c.querySelector('[data-env-cloud] input'), 'aws-profile:work');
    await click(c.querySelector('[data-change-submit]'), 'Add login');
    await until(() => c.querySelector('[data-env-login="added"]') !== null, 'the added screen');
    const change = calls.find(call => `${call.method} ${call.path}` === CHANGES)?.body as {
      change: { cloudCredential?: string };
    };
    expect(change.change.cloudCredential).toBe('aws-profile:work');
    expect(c.textContent).toContain('No Test: Bedrock needs AWS request signing.');
    await view.unmount();

    const codex = await open({}, 'codex');
    await until(() => form(codex.view.container) !== null, 'the Codex form');
    expect(Array.from(codex.view.container.querySelectorAll('option')).map(option => option.value)).toEqual([
      'ollama-codex',
      'zai-glm-codex',
    ]);
    await codex.view.unmount();
  });

  it('switches back to Sign in, and says so when there are no presets or they cannot be read', async () => {
    const { view } = await open({ [PRESETS_READ]: { presets: [FOUNDRY] }, [SECRETS]: new Error('no store') }, 'codex');
    await until(() => view.container.querySelector('[data-env-login="none"]') !== null, 'no preset');
    expect(view.container.textContent).toContain('studio-mac offers no provider preset for this tool.');
    await click(view.container.querySelector('[data-add-login-kind-option="signin"] input'), 'Sign in');
    expect(view.container.querySelector('[data-add-login-step="start"]')).not.toBeNull();
    await view.unmount();

    const failed = await open({ [PRESETS_READ]: new FyHttpError('No presets here.', 500, 'x') });
    await until(() => failed.view.container.querySelector('[data-env-login="failed"]') !== null, 'the failure');
    expect(failed.view.container.textContent).toContain('No presets here.');
    await failed.view.unmount();
  });
});
