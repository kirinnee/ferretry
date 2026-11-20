import { afterEach, describe, expect, it } from 'bun:test';
import { AddLoginPanel } from '../../../app/features/add-login-panel.tsx';
import { isSecretReference, SECRET_VALUE_SENTENCE } from '../../../app/lib/secret-slot.ts';
import type { ProviderPresetView } from '../../../contract/index.ts';
import { loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { typeInto } from './support/typing.ts';

// The full preset form's secret slot holds a `${secret:NAME}` reference. A value that is not one is a key pasted by
// mistake: the field masks it, no request is made, and nothing on screen or on the wire repeats it.

const RAW = 'SENTINEL-sk-or-v1-0123456789abcdef0123456789abcdef';
const LIST = 'GET /v1/logins';
const GRANTS = 'GET /v1/grants';
const STAGE = 'POST /v1/logins/changes';
const APPLY = 'POST /v1/logins/changes/:changeId/apply';
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
const staged = {
  id: 'chg1',
  change: { kind: 'login.add', id: 'claude-zai-glm', harness: 'claude-code' },
  summary: 'Add claude-zai-glm.',
  consequences: [],
  expiresAt: '2026-11-17T00:10:00.000Z',
  state: 'pending',
};

// No default base URL, so the tile opens the full form straight away.
const NEEDY: ProviderPresetView = {
  id: 'zai-glm',
  label: 'GLM / Z.ai',
  harness: 'claude-code',
  summary: 'Claude Code on GLM.',
  docs: 'https://docs.example.test',
  origin: 'built-in',
  variables: [
    {
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'ZAI_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Free.' },
  quota: { source: 'none', note: 'n/a' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
} as ProviderPresetView;

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const press = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await until(() => !(target as HTMLButtonElement).disabled, `${what} to be enabled`);
  await interact(() => target.click());
};

const openForm = async (calls: Call[]) => {
  const client = scripted(
    {
      'GET /v1/logins/presets': { presets: [NEEDY] },
      [LIST]: loginList(),
      [GRANTS]: OPEN,
      [STAGE]: staged,
      [APPLY]: { outcome: 'applied' },
    },
    calls,
  );
  const view = await mount(<AddLoginPanel client={client} />);
  const c = view.container;
  await until(() => c.querySelector('[data-provider-tile="zai-glm"]') !== null, 'the tile');
  await press(c.querySelector('[data-provider-tile="zai-glm"]'), 'GLM / Z.ai');
  const field = (name: string) =>
    must(
      Array.from(c.querySelectorAll<HTMLLabelElement>('[data-add-login-form="zai-glm"] label'))
        .find(label => label.querySelector('span')?.textContent === name)
        ?.querySelector('input') ?? null,
      name,
    );
  return { view, c, field };
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('what a secret slot accepts', () => {
  it('takes empty and a well-formed reference, and nothing else', () => {
    expect(isSecretReference('ANTHROPIC_AUTH_TOKEN', '')).toBe(true);
    expect(isSecretReference('ANTHROPIC_AUTH_TOKEN', '${secret:ZAI_API_KEY}')).toBe(true);
    expect(isSecretReference('ANTHROPIC_AUTH_TOKEN', 'Bearer ${secret:ZAI_API_KEY}')).toBe(true);
    expect(isSecretReference('ANTHROPIC_AUTH_TOKEN', RAW)).toBe(false);
    expect(isSecretReference('ANTHROPIC_AUTH_TOKEN', 'ZAI_API_KEY')).toBe(false);
    expect(isSecretReference('ANTHROPIC_AUTH_TOKEN', '${secret:lower_case}')).toBe(false);
    expect(isSecretReference('ANTHROPIC_AUTH_TOKEN', `${RAW} \${secret:ZAI_API_KEY}`)).toBe(false);
  });
});

describe('the full form’s secret slot', () => {
  it('masks a pasted raw key, sends no request, and repeats it nowhere', async () => {
    const calls: Call[] = [];
    const { view, c, field } = await openForm(calls);
    await typeInto(field('ANTHROPIC_BASE_URL'), 'https://api.z.ai/api/anthropic');
    const slot = field('ANTHROPIC_AUTH_TOKEN');
    expect(slot.type).toBe('text');
    expect(slot.value).toBe('${secret:ZAI_API_KEY}');
    await typeInto(slot, RAW);
    expect(slot.type).toBe('password');
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(c.querySelector('[data-change-refusal]')?.textContent).toContain(SECRET_VALUE_SENTENCE);
    expect(calls.some(call => call.route === STAGE || call.route === APPLY || call.route === LIST)).toBe(false);
    expect(JSON.stringify(calls)).not.toContain(RAW);
    // The refused value is dropped from the form too: not in a field, an attribute or a sentence.
    expect(field('ANTHROPIC_AUTH_TOKEN').value).toBe('');
    expect(c.innerHTML).not.toContain(RAW);
    expect(c.textContent).not.toContain(RAW);
    await view.unmount();
  });

  it('sends a valid reference unchanged, as text', async () => {
    const calls: Call[] = [];
    const { view, c, field } = await openForm(calls);
    await typeInto(field('ANTHROPIC_BASE_URL'), 'https://api.z.ai/api/anthropic');
    const slot = field('ANTHROPIC_AUTH_TOKEN');
    await typeInto(slot, '${secret:WORK_KEY}');
    expect(slot.type).toBe('text');
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => calls.some(call => call.route === STAGE), 'the staging request');
    expect(calls.find(call => call.route === STAGE)?.body).toMatchObject({
      kind: 'login.add',
      store: 'environment',
      preset: 'zai-glm',
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: '${secret:WORK_KEY}' },
    });
    await view.unmount();
  });
});
