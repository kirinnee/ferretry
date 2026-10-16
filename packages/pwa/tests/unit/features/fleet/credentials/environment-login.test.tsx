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
import { ENVIRONMENT, FOUNDRY, PROVIDERS } from './environment-support.ts';

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
      [PRESETS_READ]: PROVIDERS,
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

const grid = (container: HTMLElement) => container.querySelector('[data-provider-grid]');
const form = (container: HTMLElement) => container.querySelector('[data-env-login="form"]');
const tiles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-provider-tile]')).map(tile => tile.getAttribute('data-provider-tile'));
const sent = (calls: readonly Call[], route: string) =>
  calls.filter(call => `${call.method} ${call.path}` === route).map(call => call.body);

describe('AddLoginStep · Environment · providers', () => {
  it('shows a tile per provider in the daemon’s order, the gateway and Paste last, with scope chips', async () => {
    const { view } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    expect(tiles(c)).toEqual([
      'deepseek',
      'zai-glm',
      'zai-glm-codex',
      'azure-openai',
      'deepseek-mirror',
      'amazon-bedrock',
      'custom-gateway',
      'paste',
    ]);
    const chip = (id: string) =>
      c.querySelector(`[data-provider-tile="${id}"] [data-login-scope]`)?.getAttribute('data-login-scope');
    expect(chip('deepseek')).toBe('both');
    expect(c.querySelector('[data-provider-tile="deepseek"]')?.textContent).toContain('Claude + Codex');
    expect(chip('deepseek-mirror')).toBe('claude');
    expect(chip('azure-openai')).toBe('codex');
    expect(chip('zai-glm-codex')).toBe('codex');
    const blocked = must(c.querySelector<HTMLButtonElement>('[data-provider-tile="zai-glm-codex"]'), 'GLM on Codex');
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toContain('Not offered here: Codex needs a model catalogue file.');
    expect(c.querySelector('[data-stepper-position]')?.textContent).toBe('Step 1 of 2 · Environment');
    await click(c.querySelector('[data-add-login-kind-option="signin"] input'), 'Sign in');
    expect(c.querySelector('[data-add-login-step="tool"]')).not.toBeNull();
    await view.unmount();
  });

  it('asks a two-half provider for its one key, stores it FIRST, then adds one login for both CLIs', async () => {
    const { view, calls, added } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    expect(form(c)?.getAttribute('data-one-click')).toBe('deepseek');
    expect(c.querySelectorAll('[data-env-secret-input]').length).toBe(1);
    const field = must(c.querySelector('[data-one-click-secret="DEEPSEEK_API_KEY"]'), 'the key field');
    expect(field.textContent).toContain('Used as ANTHROPIC_AUTH_TOKEN and DEEPSEEK_API_KEY.');
    expect(c.querySelector('[data-env-problem]')?.textContent).toBe('Paste DEEPSEEK_API_KEY.');
    expect(c.querySelector('[data-env-preset-facts="deepseek"] [data-login-scope]')?.textContent).toBe(
      'Claude + Codex',
    );
    await type(c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'a-pasted-deepseek-key');
    expect(c.querySelector('[data-env-problem]')).toBeNull();
    await click(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-env-login="added"]') !== null, 'the added screen');
    const order = calls.map(call => `${call.method} ${call.path}`).filter(key => key === STORE || key === CHANGES);
    expect(order).toEqual([STORE, CHANGES]);
    expect(sent(calls, STORE)).toEqual([{ name: 'DEEPSEEK_API_KEY', value: 'a-pasted-deepseek-key' }]);
    expect((sent(calls, CHANGES)[0] as { change: unknown }).change).toEqual({
      kind: 'credential.add',
      id: 'deepseek',
      harness: 'claude',
      store: 'environment',
      preset: 'deepseek',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: secretRef('DEEPSEEK_API_KEY'),
        DEEPSEEK_API_KEY: secretRef('DEEPSEEK_API_KEY'),
      },
    });
    expect(c.textContent).not.toContain('a-pasted-deepseek-key');
    expect(c.innerHTML).not.toContain('a-pasted-deepseek-key');
    expect(c.textContent).toContain('Added deepseek from DeepSeek');
    expect(c.querySelector('[data-stepper-position]')?.textContent).toBe('Step 2 of 2 · Test');
    await click(c.querySelector('[data-step-next]'), 'Done');
    expect(added).toEqual(['deepseek']);
    await view.unmount();
  });

  it('shows a stored key as set ✓, and More options changes the name and the other variables', async () => {
    const { view, calls } = await open({ [SECRETS]: secretList(['ZAI_API_KEY']) });
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="zai-glm"]'), 'GLM');
    expect(c.querySelector('[data-env-secret-set="ZAI_API_KEY"]')?.textContent).toContain(
      `${secretRef('ZAI_API_KEY')} set ✓`,
    );
    expect(c.querySelector('[data-one-click-secret="ZAI_API_KEY"]')?.textContent).toContain(
      'Already in studio-mac’s secret store.',
    );
    expect(c.querySelector('[data-env-name]')).toBeNull();
    expect(c.textContent).toContain('Not confirmed: The quota endpoint is community-documented.');
    expect(c.querySelector('[data-env-preset-docs]')?.getAttribute('href')).toBe('https://docs.example.com/claude');
    expect(c.querySelector('[data-env-preset-facts]')?.textContent).toContain('facts checked against them 2026-10-16');
    const more = must(c.querySelector('[data-one-click-more]'), 'More options');
    await click(more, 'More options');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    await type(c.querySelector('[data-env-name]'), 'glm-work');
    const timeout = must(c.querySelector('[data-env-variable="API_TIMEOUT_MS"] input'), 'the timeout field');
    expect(c.querySelector('[data-env-variable="API_TIMEOUT_MS"] label')?.textContent).toBe(
      'API_TIMEOUT_MS (optional)',
    );
    expect((timeout as HTMLInputElement).placeholder).toBe('a timeout');
    await type(timeout, '600');
    expect(c.querySelector('[data-one-click-secret="EXTRA_KEY"]')?.textContent).toContain('EXTRA_KEY (optional)');
    await type(c.querySelector('[data-env-variable="ANTHROPIC_BASE_URL"] input'), '');
    expect(c.querySelector('[data-env-problem]')?.textContent).toBe('Fill in ANTHROPIC_BASE_URL.');
    await type(c.querySelector('[data-env-variable="ANTHROPIC_BASE_URL"] input'), 'https://api.z.ai/api/anthropic');
    await click(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-env-login="added"]') !== null, 'the added screen');
    expect(sent(calls, STORE)).toEqual([]);
    expect((sent(calls, CHANGES)[0] as { change: { id: string; env: unknown } }).change).toMatchObject({
      id: 'glm-work',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: secretRef('ZAI_API_KEY'),
        API_TIMEOUT_MS: '600',
        ANTHROPIC_API_KEY: '',
      },
    });
    expect(c.textContent).toContain('Reads your quota. Spends nothing.');
    await view.unmount();
  });

  it('closes More options again', async () => {
    const { view } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="zai-glm"]'), 'GLM');
    await click(c.querySelector('[data-one-click-more]'), 'More options');
    expect(c.querySelector('[data-env-variables]')).not.toBeNull();
    await click(c.querySelector('[data-one-click-more]'), 'More options');
    expect(c.querySelector('[data-env-variables]')).toBeNull();
    await view.unmount();
  });

  it('says why a key could not be stored, forgets it, and adds nothing', async () => {
    const { view, calls } = await open({
      [STORE]: new FyHttpError('The secret store is damaged.', 503, 'secret_store_damaged'),
    });
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    await type(c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'another-pasted-key-value');
    await click(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-env-store-error]') !== null, 'the store error');
    expect(c.querySelector('[data-env-store-error]')?.textContent).toBe('The secret store is damaged.');
    expect((c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]') as HTMLInputElement).value).toBe('');
    expect(sent(calls, CHANGES)).toEqual([]);
    await view.unmount();
  });

  it('keeps the form when the change is refused, the key already stored', async () => {
    const { view } = await open({ [CHANGES]: new FyHttpError('Not allowed here.', 403, 'forbidden') });
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    await type(c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'refused-path-key');
    await click(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-env-secret-set="DEEPSEEK_API_KEY"]') !== null, 'set ✓');
    expect(form(c)).not.toBeNull();
    expect(c.querySelector('[data-env-login="added"]')).toBeNull();
    await view.unmount();
  });

  it('asks a cloud provider for its reference and a resource provider for its value, and goes back', async () => {
    const { view, calls } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="amazon-bedrock"]'), 'Bedrock');
    const cloud = must(c.querySelector<HTMLInputElement>('[data-env-cloud] input'), 'the reference');
    expect(cloud.value).toBe('aws-profile:default');
    await type(cloud, ' ');
    expect(c.querySelector('[data-env-problem]')?.textContent).toBe('Fill in the cloud credential reference.');
    await type(cloud, 'aws-profile:work');
    await click(c.querySelector('[data-one-click-back]'), 'All providers');
    expect(grid(c)).not.toBeNull();
    await click(c.querySelector('[data-provider-tile="azure-openai"]'), 'Azure');
    const resource = must(
      c.querySelector<HTMLInputElement>('[data-env-variable="AZURE_OPENAI_RESOURCE"] input'),
      'resource',
    );
    expect(resource.placeholder).toBe('the resource name');
    expect(c.querySelector('[data-env-problem]')?.textContent).toBe('Fill in AZURE_OPENAI_RESOURCE.');
    await type(resource, 'acme');
    await type(c.querySelector('[data-env-secret-input="AZURE_OPENAI_API_KEY"]'), 'azure-key');
    await click(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-env-login="added"]') !== null, 'the added screen');
    expect((sent(calls, CHANGES)[0] as { change: unknown }).change).toMatchObject({
      harness: 'codex',
      env: { AZURE_OPENAI_RESOURCE: 'acme', AZURE_OPENAI_API_KEY: secretRef('AZURE_OPENAI_API_KEY') },
    });
    await view.unmount();
  });

  it('opened for Codex, offers only providers with a Codex half — and the login still gets both', async () => {
    const { view, calls } = await open({}, 'codex');
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    expect(tiles(c)).toEqual(['deepseek', 'azure-openai', 'paste']);
    await click(c.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    await type(c.querySelector('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'codex-flow-key');
    await click(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-env-login="added"]') !== null, 'the added screen');
    expect((sent(calls, CHANGES)[0] as { change: { harness: string; env: object } }).change.harness).toBe('claude');
    await view.unmount();
  });

  it('says so when there are no providers for a tool or they cannot be read', async () => {
    const { view } = await open({ [PRESETS_READ]: { presets: [FOUNDRY] }, [SECRETS]: new Error('no store') }, 'codex');
    await until(() => view.container.querySelector('[data-env-login="none"]') !== null, 'no preset');
    expect(view.container.textContent).toContain('studio-mac offers no provider for this tool.');
    await view.unmount();

    const failed = await open({ [PRESETS_READ]: new FyHttpError('No presets here.', 500, 'x') });
    await until(() => failed.view.container.querySelector('[data-env-login="failed"]') !== null, 'the failure');
    expect(failed.view.container.textContent).toContain('No presets here.');
    await failed.view.unmount();
  });
});

describe('AddLoginStep · Environment · Paste variables', () => {
  const paste = async (c: HTMLElement, text: string): Promise<void> => {
    await type(c.querySelector('[data-paste-input]'), text);
    await click(c.querySelector('[data-paste-read]'), 'Read');
  };

  it('recognises the provider by NAMES, clears the box, and opens its form filled in', async () => {
    const { view, calls } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="paste"]'), 'Paste variables');
    const box = must(c.querySelector<HTMLTextAreaElement>('[data-paste-input]'), 'the box');
    expect(box.getAttribute('autocomplete')).toBe('off');
    expect(box.getAttribute('spellcheck')).toBe('false');
    expect((c.querySelector('[data-paste-read]') as HTMLButtonElement).disabled).toBe(true);
    await paste(
      c,
      'export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nexport ANTHROPIC_AUTH_TOKEN=sk-pasted-deepseek-secret',
    );
    expect(box.value).toBe('');
    expect(c.querySelector('[data-paste-result]')?.getAttribute('data-paste-result')).toBe('deepseek');
    expect(c.querySelector('[data-paste-detected]')?.textContent).toBe(
      'Looks like DeepSeek — from ANTHROPIC_BASE_URL (api.deepseek.com)',
    );
    expect(c.querySelector('[data-paste-also]')?.textContent).toBe('or: DeepSeek mirror');
    expect(c.innerHTML).not.toContain('sk-pasted-deepseek-secret');
    await click(c.querySelector('[data-paste-continue]'), 'Continue');
    expect(form(c)?.getAttribute('data-one-click')).toBe('deepseek');
    expect(c.querySelector('[data-one-click-prefilled]')).not.toBeNull();
    expect(c.querySelector('[data-one-click-pasted="DEEPSEEK_API_KEY"]')?.textContent).toBe(
      'pasted — stored when you Add',
    );
    expect(c.querySelector('[data-env-secret-input]')).toBeNull();
    expect(c.innerHTML).not.toContain('sk-pasted-deepseek-secret');
    await click(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-env-login="added"]') !== null, 'the added screen');
    expect(sent(calls, STORE)).toEqual([{ name: 'DEEPSEEK_API_KEY', value: 'sk-pasted-deepseek-secret' }]);
    await view.unmount();
  });

  it('lets a pasted key be replaced, and continues as a custom gateway with what was recognised', async () => {
    const { view, calls } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="paste"]'), 'Paste variables');
    await paste(c, 'ANTHROPIC_BASE_URL: https://gw.example.test\nANTHROPIC_AUTH_TOKEN: gateway-pasted-key\nFOO: bar');
    expect(c.querySelector('[data-paste-result]')?.getAttribute('data-paste-result')).toBe('custom');
    expect(c.querySelector('[data-paste-detected]')?.textContent).toBe(
      'Custom gateway — recognised: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN',
    );
    expect(c.querySelector('[data-paste-not-offered]')).toBeNull();
    await click(c.querySelector('[data-paste-continue]'), 'Continue');
    expect(form(c)?.getAttribute('data-one-click')).toBe('custom-gateway');
    expect(c.querySelector<HTMLInputElement>('[data-env-variable="ANTHROPIC_BASE_URL"] input')?.value).toBe(
      'https://gw.example.test',
    );
    await click(c.querySelector('[data-one-click-replace="GATEWAY_API_KEY"]'), 'Paste another');
    expect(c.querySelector('[data-one-click-pasted]')).toBeNull();
    expect(c.querySelector('[data-env-problem]')?.textContent).toBe('Paste GATEWAY_API_KEY.');
    await type(c.querySelector('[data-env-secret-input="GATEWAY_API_KEY"]'), 'typed-instead');
    await click(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-env-login="added"]') !== null, 'the added screen');
    expect(sent(calls, STORE)).toEqual([{ name: 'GATEWAY_API_KEY', value: 'typed-instead' }]);
    await view.unmount();
  });

  it('says when nothing was found, when nothing offered can take it, and goes back', async () => {
    const { view } = await open({}, 'codex');
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="paste"]'), 'Paste variables');
    await paste(c, '# only a comment');
    expect(c.querySelector('[data-paste-result="empty"]')?.textContent).toBe(
      'No variables found. Paste lines like NAME=value.',
    );
    expect(c.querySelector('[data-paste-continue]')).toBeNull();
    await paste(c, 'ANTHROPIC_BASE_URL=https://gw.example.test');
    expect(c.querySelector('[data-paste-not-offered]')?.textContent).toBe(
      'Nothing offered here can take these variables. Pick a provider instead.',
    );
    const go = must(c.querySelector<HTMLButtonElement>('[data-paste-continue]'), 'Continue');
    expect(go.disabled).toBe(true);
    await click(c.querySelector('[data-paste-back]'), 'All providers');
    expect(grid(c)).not.toBeNull();
    await view.unmount();
  });

  it('continues as the gateway when the provider it recognised is not offered here', async () => {
    const { view } = await open({
      [PRESETS_READ]: {
        presets: PROVIDERS.presets.map(preset =>
          preset.id === 'deepseek' || preset.id === 'deepseek-mirror'
            ? { ...preset, offered: { available: false, reason: 'Not here.' } }
            : preset,
        ),
      },
    });
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    await click(c.querySelector('[data-provider-tile="paste"]'), 'Paste variables');
    await paste(c, 'DEEPSEEK_API_KEY=whatever');
    expect(c.querySelector('[data-paste-not-offered]')?.textContent).toBe(
      'That provider is not offered here, so this continues as Custom gateway.',
    );
    await view.unmount();
  });
});
