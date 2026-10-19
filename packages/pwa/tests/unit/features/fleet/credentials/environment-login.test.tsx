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
import { LONG_PRESS_MS } from '../../../../../src/shell/agent-sidebar-model.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { localModelsFixture } from '../../../../support/local-models.ts';
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
import { DEEPSEEK, DEEPSEEK_MIRROR, ENVIRONMENT, FOUNDRY, OLLAMA, PROVIDERS } from './environment-support.ts';

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
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A pointer event as React reads it: `pointerover`/`pointerout` from outside are its enter and leave. */
const pointer = (target: HTMLElement, type: string, pointerType: string): void => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType, relatedTarget: document.body });
  target.dispatchEvent(event);
};
const sent = (calls: readonly Call[], route: string) =>
  calls.filter(call => `${call.method} ${call.path}` === route).map(call => call.body);

describe('AddLoginStep · Environment · providers', () => {
  it('files a tile per provider under its heading, nothing picked, the gateway and Paste last, with scope chips', async () => {
    const { view } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    expect(tiles(c)).toEqual([
      'deepseek',
      'zai-glm',
      'zai-glm-codex',
      'azure-openai',
      'amazon-bedrock',
      'deepseek-mirror',
      'custom-gateway',
      'paste',
    ]);
    const headings = Array.from(c.querySelectorAll('[data-provider-section]')).map(section => [
      section.getAttribute('data-provider-section'),
      section.querySelector('h4')?.textContent,
    ]);
    expect(headings).toEqual([
      ['popular', 'Popular'],
      ['cloud', 'Cloud'],
      ['other', 'More providers'],
      ['self-hosted', 'Self-hosted'],
    ]);
    // Seven tiles: no search box, and no tile is pressed until somebody taps one.
    expect(c.querySelector('[data-provider-search]')).toBeNull();
    expect(c.querySelector('[data-provider-tile][aria-pressed="true"], [data-provider-tile][aria-current]')).toBeNull();
    expect(form(c)).toBeNull();
    const chip = (id: string) =>
      c.querySelector(`[data-provider-tile="${id}"] [data-login-scope]`)?.getAttribute('data-login-scope');
    expect(chip('deepseek')).toBe('both');
    expect(c.querySelector('[data-provider-tile="deepseek"]')?.textContent).toBe('DeepSeekClaude + Codex');
    expect(chip('deepseek-mirror')).toBe('claude');
    expect(chip('azure-openai')).toBe('codex');
    expect(chip('zai-glm-codex')).toBe('codex');
    expect(c.querySelector('[data-stepper-position]')?.textContent).toBe('Step 1 of 2 · Environment');
    await click(c.querySelector('[data-add-login-kind-option="signin"] input'), 'Sign in');
    expect(c.querySelector('[data-add-login-step="tool"]')).not.toBeNull();
    await view.unmount();
  });

  it('shows a tile’s one line on hover and keyboard focus, hides it on leave, blur and Escape', async () => {
    const { view } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    const tile = must(c.querySelector<HTMLButtonElement>('[data-provider-tile="deepseek"]'), 'DeepSeek');
    const note = must(c.querySelector<HTMLElement>('[data-provider-tile-note="deepseek"]'), 'its note');
    const shown = () => !note.className.split(' ').includes('hidden');
    // Always its accessible description, shown or not.
    expect(tile.getAttribute('aria-describedby')).toBe(note.id);
    expect(note.getAttribute('role')).toBe('tooltip');
    expect(note.textContent).toBe(DEEPSEEK.summary);
    expect(shown()).toBe(false);
    await interact(() => pointer(tile, 'pointerover', 'mouse'));
    expect(shown()).toBe(true);
    await interact(() => pointer(tile, 'pointerout', 'mouse'));
    expect(shown()).toBe(false);
    // A pen hovering is not a mouse: it shows nothing until it presses.
    await interact(() => pointer(tile, 'pointerover', 'pen'));
    expect(shown()).toBe(false);
    await interact(() => tile.focus());
    expect(shown()).toBe(true);
    await interact(() => tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(shown()).toBe(true);
    await interact(() => tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(shown()).toBe(false);
    await interact(() => tile.focus());
    const other = must(c.querySelector<HTMLButtonElement>('[data-provider-tile="zai-glm"]'), 'GLM');
    await interact(() => other.focus());
    expect(shown()).toBe(false);
    expect(c.querySelector('[data-provider-tile-note="zai-glm"]')?.className).not.toContain('hidden');
    await interact(() => other.blur());
    expect(c.querySelector('[data-provider-tile-note="zai-glm"]')?.className).toContain('hidden');
    await view.unmount();
  });

  it('shows the note on a long press and swallows the tap that ends it; a short tap opens the form', async () => {
    const { view } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    const tile = must(c.querySelector<HTMLButtonElement>('[data-provider-tile="deepseek"]'), 'DeepSeek');
    const shown = () =>
      !c.querySelector('[data-provider-tile-note="deepseek"]')?.className.split(' ').includes('hidden');
    await interact(() => pointer(tile, 'pointerdown', 'touch'));
    await interact(() => sleep(LONG_PRESS_MS + 50));
    expect(shown()).toBe(true);
    await interact(() => pointer(tile, 'pointerup', 'touch'));
    const menu = new Event('contextmenu', { bubbles: true, cancelable: true });
    await interact(() => tile.dispatchEvent(menu));
    expect(menu.defaultPrevented).toBe(true);
    await click(tile, 'the tap that ends the press');
    expect(form(c)).toBeNull();
    // A press that a scroll took over is cancelled before it shows anything.
    await interact(() => pointer(tile, 'pointerout', 'mouse'));
    await interact(() => pointer(tile, 'pointerdown', 'touch'));
    await interact(() => pointer(tile, 'pointercancel', 'touch'));
    await interact(() => sleep(LONG_PRESS_MS + 50));
    const untouched = new Event('contextmenu', { bubbles: true, cancelable: true });
    await interact(() => tile.dispatchEvent(untouched));
    expect(untouched.defaultPrevented).toBe(false);
    // A mouse press is a click, never a long press; a short tap opens the form at once.
    await interact(() => pointer(tile, 'pointerdown', 'mouse'));
    await interact(() => pointer(tile, 'pointerdown', 'touch'));
    await interact(() => pointer(tile, 'pointerup', 'touch'));
    await click(tile, 'a short tap');
    expect(form(c)?.getAttribute('data-one-click')).toBe('deepseek');
    await view.unmount();
  });

  it('keeps a provider that is not offered focusable, and a tap on it says why instead of opening it', async () => {
    const { view } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    const blocked = must(c.querySelector<HTMLButtonElement>('[data-provider-tile="zai-glm-codex"]'), 'GLM on Codex');
    expect(blocked.disabled).toBe(false);
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    expect(blocked.querySelector('[data-provider-tile-unoffered]')?.textContent).toBe('Not offered here');
    expect(c.querySelector('[data-provider-tile="deepseek"]')?.hasAttribute('aria-disabled')).toBe(false);
    const note = must(c.querySelector<HTMLElement>('[data-provider-tile-note="zai-glm-codex"]'), 'its note');
    expect(note.querySelector('[data-provider-tile-reason]')?.textContent).toBe(
      'Not offered here: Codex needs a model catalogue file.',
    );
    await click(blocked, 'GLM on Codex');
    expect(form(c)).toBeNull();
    expect(note.className).not.toContain('hidden');
    await view.unmount();
  });

  it('puts a search box over more than eight tiles, narrows them by name, and says when nothing matches', async () => {
    const more = ['one', 'two', 'three'].map(n => ({ ...DEEPSEEK_MIRROR, id: `extra-${n}`, label: `Extra ${n}` }));
    const { view } = await open({ [PRESETS_READ]: { presets: [...PROVIDERS.presets, ...more] } });
    await until(() => grid(view.container) !== null, 'the grid');
    const c = view.container;
    const search = must(c.querySelector<HTMLInputElement>('[data-provider-search]'), 'the search box');
    expect(search.type).toBe('search');
    expect(search.closest('label')?.textContent).toContain('Search providers');
    await type(search, 'DEEPSEEK');
    expect(tiles(c)).toEqual(['deepseek', 'deepseek-mirror', 'paste']);
    await type(search, 'extra two');
    expect(tiles(c)).toEqual(['extra-two', 'paste']);
    await type(search, 'nothing-is-called-this ');
    expect(tiles(c)).toEqual(['paste']);
    expect(c.querySelector('[data-provider-no-match]')?.textContent).toBe(
      'No provider matches “nothing-is-called-this”. Try another name, or paste your variables below.',
    );
    await type(search, '');
    expect(tiles(c)).toHaveLength(11);
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
    // The key comes first: what the provider is follows it.
    expect(
      field.compareDocumentPosition(must(c.querySelector('[data-env-preset-facts="deepseek"]'), 'the facts')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

describe('AddLoginStep · Environment · Ollama on this machine', () => {
  const REFRESH = 'POST /v1/models/local/refresh';
  const withOllama = { [PRESETS_READ]: { presets: [...PROVIDERS.presets, OLLAMA] } };
  const refreshes = (calls: readonly Call[]) => sent(calls, REFRESH).length;
  const tileLine = (c: HTMLElement) => c.querySelector('[data-provider-tile-local]')?.textContent;

  it('reads Ollama once when the grid opens and says what it found on the tile’s second line', async () => {
    const { view, calls } = await open({ ...withOllama, [REFRESH]: localModelsFixture('found') });
    await until(() => tileLine(view.container) === '2 models installed', 'the count');
    expect(refreshes(calls)).toBe(1);
    expect(view.container.querySelector('[data-provider-tile-local]')?.getAttribute('data-provider-tile-local')).toBe(
      'found',
    );
    // Only the Ollama tile carries it.
    expect(view.container.querySelectorAll('[data-provider-tile-local]')).toHaveLength(1);
    expect(
      view.container.querySelector('[data-provider-tile="ollama-codex"] [data-provider-tile-local]'),
    ).not.toBeNull();
    await view.unmount();
  });

  it('says "Not running" and "No model pulled yet" in the same place', async () => {
    const down = await open({ ...withOllama, [REFRESH]: localModelsFixture('not-running') });
    await until(() => tileLine(down.view.container) === 'Not running', 'not running');
    await down.view.unmount();
    const empty = await open({ ...withOllama, [REFRESH]: localModelsFixture('none-pulled') });
    await until(() => tileLine(empty.view.container) === 'No model pulled yet', 'none pulled');
    await empty.view.unmount();
  });

  it('shows the list, the sentence and Check again on the form — and asks again only on that tap', async () => {
    let answer = localModelsFixture('none-pulled');
    const { view, calls } = await open({ ...withOllama, [REFRESH]: () => answer });
    await until(() => tileLine(view.container) === 'No model pulled yet', 'none pulled');
    await click(view.container.querySelector('[data-provider-tile="ollama-codex"]'), 'Ollama');
    const c = view.container;
    const panel = must(c.querySelector('[data-local-models-panel]'), 'the panel');
    expect(panel.getAttribute('data-local-models-panel')).toBe('none-pulled');
    expect(panel.querySelector('[data-local-models-command]')?.textContent).toBe('ollama pull gpt-oss:20b');
    expect(refreshes(calls)).toBe(1);
    answer = localModelsFixture('found');
    await click(c.querySelector('[data-local-models-check]'), 'Check again');
    await until(
      () => c.querySelector('[data-local-models-panel]')?.getAttribute('data-local-models-panel') === 'found',
      'found',
    );
    expect(refreshes(calls)).toBe(2);
    expect([...c.querySelectorAll('[data-local-model]')].map(row => row.getAttribute('data-local-model'))).toEqual([
      'gpt-oss:20b',
      'qwen3-coder:30b',
    ]);
    // No timer: nothing else asks.
    await interact(() => sleep(150));
    expect(refreshes(calls)).toBe(2);
    await view.unmount();
  });

  it('puts no panel on any other provider’s form, and reads nothing when there is no Ollama tile', async () => {
    const { view, calls } = await open();
    await until(() => grid(view.container) !== null, 'the grid');
    await click(view.container.querySelector('[data-provider-tile="deepseek"]'), 'DeepSeek');
    expect(view.container.querySelector('[data-local-models-panel]')).toBeNull();
    expect(refreshes(calls)).toBe(0);
    await view.unmount();
  });

  it('keeps the tile quiet when the machine cannot be asked, and says so on the form', async () => {
    const { view } = await open({
      ...withOllama,
      [REFRESH]: new FyHttpError('This device may not do that.', 403, 'forbidden'),
    });
    await until(() => tileLine(view.container) === 'Could not check Ollama', 'the failure');
    await click(view.container.querySelector('[data-provider-tile="ollama-codex"]'), 'Ollama');
    expect(view.container.querySelector('[data-local-models-error]')?.textContent).toContain(
      'Could not ask studio-mac what Ollama has installed.',
    );
    await view.unmount();
  });
});
