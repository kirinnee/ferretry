import { afterEach, describe, expect, it } from 'bun:test';
import { AddLoginPanel } from '../../../app/features/add-login-panel.tsx';
import { QuickKeyForm, quickKeyVariable } from '../../../app/features/quick-key-form.tsx';
import type { ProviderPresetView } from '../../../contract/index.ts';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { typeInto } from './support/typing.ts';

// The one-click provider form: it asks only for the key, files it in the Vault under the preset's secret name, and the
// login holds a `${secret:NAME}` reference — the key reaches no field, sentence or login file.

const KEY = 'SENTINEL-sk-quick-very-secret';
const LIST = 'GET /v1/logins';
const GRANTS = 'GET /v1/grants';
const STAGE = 'POST /v1/logins/changes';
const APPLY = 'POST /v1/logins/changes/:changeId/apply';
const HELD = 'GET /v1/secrets';
const FILE = 'POST /v1/secrets';

const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
const NONE_HELD = { v: 1, health: 'ready', secrets: [], references: [] };
const holding = (...names: string[]) => ({
  v: 1,
  health: 'ready',
  secrets: names.map(name => ({ name, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' })),
  references: [],
});
const staged = {
  id: 'chg1',
  change: { kind: 'login.add', id: 'claude-zai-glm', harness: 'claude-code' },
  summary: 'Add claude-zai-glm.',
  consequences: [],
  expiresAt: '2026-11-17T00:10:00.000Z',
  state: 'pending',
};

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

const ZAI: ProviderPresetView = {
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
      value: 'https://api.z.ai/api/anthropic',
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
    { name: 'API_TIMEOUT_MS', kind: 'plain', required: false, allowEmpty: false, harnesses: ['claude-code'] },
  ],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Free.' },
  quota: { source: 'none', note: 'n/a' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
};

const routes = (held: unknown, calls: Call[]) =>
  scripted(
    {
      'GET /v1/logins/presets': { presets: [ZAI] },
      [LIST]: loginList(),
      [GRANTS]: OPEN,
      [HELD]: held,
      [FILE]: { name: 'ZAI_API_KEY' },
      [STAGE]: staged,
      [APPLY]: { outcome: 'applied' },
    },
    calls,
  );

const mountForm = async (client: ReturnType<typeof routes>, added: string[] = [], more: string[] = []) => {
  const variable = must(quickKeyVariable(ZAI), 'the key variable');
  return mount(
    <QuickKeyForm
      client={client}
      preset={ZAI}
      variable={variable}
      onAdded={id => added.push(id)}
      onCancel={() => undefined}
      onMore={() => more.push('more')}
    />,
  );
};

const type = async (view: { container: HTMLElement }, text: string): Promise<void> =>
  typeInto(must(view.container.querySelector<HTMLInputElement>('[data-quick-key-input]'), 'the key field'), text);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('which providers get the key-only form', () => {
  it('picks the one secret of a preset that asks for nothing else a person must type', () => {
    expect(quickKeyVariable(ZAI)?.name).toBe('ANTHROPIC_AUTH_TOKEN');
  });

  it('leaves a preset that needs a typed value, a second key or a cloud credential to the full form', () => {
    const url = must(ZAI.variables[0], 'the base URL');
    const token = must(ZAI.variables[1], 'the key');
    const timeout = must(ZAI.variables[2], 'the timeout');
    const typed = { ...ZAI, variables: [{ ...url, value: undefined }, token, timeout] } as ProviderPresetView;
    expect(quickKeyVariable(typed)).toBeUndefined();
    const second = { ...ZAI, variables: [...ZAI.variables, { ...token, name: 'OTHER_KEY', secret: 'OTHER' }] };
    expect(quickKeyVariable(second as ProviderPresetView)).toBeUndefined();
    const cloud = { ...ZAI, cloudCredential: { kinds: ['aws'], suggested: 'aws-main' } };
    expect(quickKeyVariable(cloud as unknown as ProviderPresetView)).toBeUndefined();
    expect(quickKeyVariable({ ...ZAI, variables: [url] } as ProviderPresetView)).toBeUndefined();
  });
});

describe('the key-only form', () => {
  it('files the key in the Vault under the preset’s secret name and adds a login that only names it', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const view = await mountForm(routes(NONE_HELD, calls), added);
    const c = view.container;
    const field = must(c.querySelector<HTMLInputElement>('[data-quick-key-input]'), 'the key field');
    // The key is typed into a hidden field, and it is the only field there is.
    expect(field.type).toBe('password');
    expect(c.querySelectorAll('input')).toHaveLength(1);
    // Uncontrolled and not autofilled: the browser is told this is a new secret, and React mirrors nothing into the DOM.
    expect(field.autocomplete).toBe('new-password');
    await type(view, KEY);
    expect(field.value).toBe(KEY);
    expect(field.getAttribute('value')).toBeNull();
    expect(c.innerHTML).not.toContain(KEY);
    expect(c.outerHTML).not.toContain(KEY);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => added.length > 0, 'the login to be added');

    // The value went to the Vault under the preset's own secret name, once, and nowhere else.
    expect(calls.filter(call => call.route === FILE).map(call => call.body)).toEqual([
      { name: 'ZAI_API_KEY', value: KEY },
    ]);
    expect(JSON.stringify(calls.filter(call => call.route !== FILE))).not.toContain(KEY);
    // The login carries the preset's plain defaults and a reference for the key; an optional blank is left out.
    expect(calls.find(call => call.route === STAGE)?.body).toEqual({
      kind: 'login.add',
      id: 'claude-zai-glm',
      harness: 'claude-code',
      store: 'environment',
      preset: 'zai-glm',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: `\${secret:ZAI_API_KEY}`,
      },
    });
    expect(added).toEqual(['claude-zai-glm']);
    // After filing, the key is in no field, no sentence and nothing the tree holds.
    expect(c.innerHTML).not.toContain(KEY);
    expect(c.textContent).not.toContain(KEY);
    for (const input of Array.from(c.querySelectorAll('input'))) expect(input.value).not.toContain(KEY);
    expect(c.querySelector('[data-quick-key-filed]')?.textContent).toContain('ZAI_API_KEY');
    await view.unmount();
  });

  it('asks first when the Vault already holds the name, and writes nothing until the person answers', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const view = await mountForm(routes(holding('ZAI_API_KEY'), calls), added);
    const c = view.container;
    await type(view, KEY);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-quick-key-held="ZAI_API_KEY"]') !== null, 'the question');
    expect(c.querySelector('[data-quick-key-held]')?.textContent).toContain(
      'ZAI_API_KEY is already in the secret store',
    );
    expect(calls.some(call => call.route === FILE || call.route === STAGE)).toBe(false);
    // While it waits for the answer the key sits in the hidden field and nowhere else: not in the markup, not in an attribute.
    expect(c.textContent).not.toContain(KEY);
    expect(c.innerHTML).not.toContain(KEY);
    expect(c.outerHTML).not.toContain(KEY);
    const asked = must(c.querySelector<HTMLInputElement>('[data-quick-key-input]'), 'the key field');
    expect(asked.getAttribute('value')).toBeNull();

    // Back changes nothing; replacing files the typed key and then adds the login.
    await press(c.querySelector('[data-quick-key-back]'), 'Back');
    expect(c.querySelector('[data-quick-key-held]')).toBeNull();
    expect(calls.some(call => call.route === FILE)).toBe(false);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-quick-key-replace]') !== null, 'the question again');
    await press(c.querySelector('[data-quick-key-replace]'), 'Replace it with mine');
    await until(() => added.length > 0, 'the login to be added');
    expect(calls.filter(call => call.route === FILE).map(call => call.body)).toEqual([
      { name: 'ZAI_API_KEY', value: KEY },
    ]);
    expect(c.innerHTML).not.toContain(KEY);
    await view.unmount();
  });

  it('keeps the key that is there when the person says so, and sends the typed one nowhere', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const view = await mountForm(routes(holding('ZAI_API_KEY'), calls), added);
    const c = view.container;
    await type(view, KEY);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-quick-key-keep]') !== null, 'the question');
    await press(c.querySelector('[data-quick-key-keep]'), 'Use the one already there');
    await until(() => added.length > 0, 'the login to be added');
    expect(calls.some(call => call.route === FILE)).toBe(false);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(c.innerHTML).not.toContain(KEY);
    for (const input of Array.from(c.querySelectorAll('input'))) expect(input.value).toBe('');
    for (const input of Array.from(c.querySelectorAll('input'))) expect(input.getAttribute('value') ?? '').toBe('');
    await view.unmount();
  });

  it('writes nothing when it cannot tell what the Vault holds, and says why', async () => {
    const calls: Call[] = [];
    const view = await mountForm(routes(new Error('the Vault is locked'), calls));
    const c = view.container;
    await type(view, KEY);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(calls.some(call => call.route === FILE || call.route === STAGE)).toBe(false);
    expect(c.textContent).not.toContain(KEY);
    await view.unmount();
  });

  it('offers no Add until a key is typed, and More… hands over to the full form', async () => {
    const more: string[] = [];
    const view = await mountForm(routes(NONE_HELD, []), [], more);
    const c = view.container;
    await until(() => c.querySelector('[data-change-apply="reading"]') === null, 'the grants');
    expect((c.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await press(c.querySelector('[data-quick-key-more]'), 'More fields…');
    expect(more).toEqual(['more']);
    await view.unmount();
  });

  it('retries the login without the key when the add was refused after the key was filed', async () => {
    const calls: Call[] = [];
    let refuse = true;
    const client = scripted(
      {
        [LIST]: loginList(),
        [GRANTS]: OPEN,
        [HELD]: NONE_HELD,
        [FILE]: { name: 'ZAI_API_KEY' },
        [STAGE]: () => (refuse ? new Error('refused for now') : staged),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    const added: string[] = [];
    const view = await mountForm(client, added);
    const c = view.container;
    await type(view, KEY);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(c.querySelector('[data-quick-key-input]')).toBeNull();
    refuse = false;
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => added.length > 0, 'the login to be added');
    expect(calls.filter(call => call.route === FILE)).toHaveLength(1);
    expect(c.innerHTML).not.toContain(KEY);
    await view.unmount();
  });
});

describe('one click files one key', () => {
  /** A route that answers only when the test lets it. */
  const gated = () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      open = resolve;
    });
    return { gate, open: () => open() };
  };

  it('files the key and stages the login once when Add is clicked twice during the slow Vault read', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const { gate, open } = gated();
    const client = scripted(
      {
        [LIST]: loginList(),
        [GRANTS]: OPEN,
        [HELD]: async () => {
          await gate;
          return NONE_HELD;
        },
        [FILE]: { name: 'ZAI_API_KEY' },
        [STAGE]: staged,
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    const view = await mountForm(client, added);
    const c = view.container;
    await type(view, KEY);
    const add = must(c.querySelector<HTMLButtonElement>('[data-change-submit]'), 'Add');
    await until(() => !add.disabled, 'Add to be enabled');
    // Two clicks in the same tick, before any render could disable the button.
    await interact(() => {
      add.click();
      add.click();
    });
    // The button shows it is working while the Vault is still being read.
    await until(() => (c.querySelector('[data-change-submit]') as HTMLButtonElement).disabled, 'Add to disable');
    await interact(() => {
      (c.querySelector('[data-change-submit]') as HTMLButtonElement).click();
    });
    open();
    await until(() => added.length > 0, 'the login to be added');
    expect(calls.filter(call => call.route === HELD)).toHaveLength(1);
    expect(calls.filter(call => call.route === FILE)).toHaveLength(1);
    expect(calls.filter(call => call.route === STAGE)).toHaveLength(1);
    expect(added).toEqual(['claude-zai-glm']);
    await view.unmount();
  });

  it('stages the login once when Add is clicked twice on the retry after the key was filed', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    let refuse = true;
    const { gate, open } = gated();
    const client = scripted(
      {
        [LIST]: async () => {
          if (!refuse) await gate;
          return loginList();
        },
        [GRANTS]: OPEN,
        [HELD]: NONE_HELD,
        [FILE]: { name: 'ZAI_API_KEY' },
        [STAGE]: () => (refuse ? new Error('refused for now') : staged),
        [APPLY]: { outcome: 'applied' },
      },
      calls,
    );
    const view = await mountForm(client, added);
    const c = view.container;
    await type(view, KEY);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-change-refusal]') !== null, 'the refusal');
    expect(c.querySelector('[data-quick-key-filed]')).not.toBeNull();
    refuse = false;
    const retry = must(c.querySelector<HTMLButtonElement>('[data-change-submit]'), 'Add again');
    await until(() => !retry.disabled, 'Add to be enabled');
    await interact(() => {
      retry.click();
      retry.click();
    });
    open();
    await until(() => added.length > 0, 'the login to be added');
    expect(calls.filter(call => call.route === FILE)).toHaveLength(1);
    // One refused stage, one good one: the two clicks made ONE retry.
    expect(calls.filter(call => call.route === STAGE)).toHaveLength(2);
    await view.unmount();
  });

  it('files the key once when Replace it with mine is clicked twice', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const view = await mountForm(routes(holding('ZAI_API_KEY'), calls), added);
    const c = view.container;
    await type(view, KEY);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => c.querySelector('[data-quick-key-replace]') !== null, 'the question');
    const replace = must(c.querySelector<HTMLButtonElement>('[data-quick-key-replace]'), 'Replace');
    await interact(() => {
      replace.click();
      replace.click();
    });
    await until(() => added.length > 0, 'the login to be added');
    expect(calls.filter(call => call.route === FILE)).toHaveLength(1);
    expect(calls.filter(call => call.route === STAGE)).toHaveLength(1);
    await view.unmount();
  });
});

// A preset that drives both CLIs and asks for nothing but one key: the key is read by both, each CLI also has a plain
// variable of its own that the other never reads.
const BOTH: ProviderPresetView = {
  ...ZAI,
  id: 'both-cli',
  label: 'Both CLI',
  variables: [
    {
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://both.test/anthropic',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
    {
      name: 'OPENAI_BASE_URL',
      kind: 'plain',
      value: 'https://both.test/v1',
      required: true,
      allowEmpty: false,
      harnesses: ['codex'],
    },
    {
      name: 'BOTH_API_KEY',
      kind: 'secret',
      secret: 'BOTH_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code', 'codex'],
    },
  ],
  halves: [
    { harness: 'claude-code', offered: { available: true }, models: [] },
    { harness: 'codex', offered: { available: true }, models: [] },
  ],
};

const mountBoth = async (calls: Call[], added: string[]) => {
  const client = scripted(
    {
      'GET /v1/logins/presets': { presets: [BOTH] },
      [LIST]: loginList(),
      [GRANTS]: OPEN,
      [HELD]: NONE_HELD,
      [FILE]: { name: 'BOTH_KEY' },
      [STAGE]: staged,
      [APPLY]: { outcome: 'applied' },
    },
    calls,
  );
  return mount(
    <QuickKeyForm
      client={client}
      preset={BOTH}
      variable={must(quickKeyVariable(BOTH), 'the key variable')}
      onAdded={id => added.push(id)}
      onCancel={() => undefined}
      onMore={() => undefined}
    />,
  );
};

describe('a preset that drives several CLIs', () => {
  it('asks which CLI, and with the 2nd one makes a Codex login that carries only Codex’s variables', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const view = await mountBoth(calls, added);
    const c = view.container;
    const choice = must(c.querySelector<HTMLSelectElement>('[data-quick-key-harness]'), 'the CLI choice');
    expect(Array.from(choice.options).map(option => option.value)).toEqual(['claude-code', 'codex']);
    expect(choice.value).toBe('claude-code');
    await interact(() => {
      choice.value = 'codex';
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type(view, KEY);
    await press(c.querySelector('[data-change-submit]'), 'Add');
    await until(() => added.length > 0, 'the login to be added');

    expect(calls.find(call => call.route === STAGE)?.body).toEqual({
      kind: 'login.add',
      id: 'codex-both-cli',
      harness: 'codex',
      halves: ['codex'],
      store: 'environment',
      preset: 'both-cli',
      env: { OPENAI_BASE_URL: 'https://both.test/v1', BOTH_API_KEY: `\${secret:BOTH_KEY}` },
    });
    await view.unmount();
  });

  it('makes a Claude Code login with only Claude Code’s variables when the first CLI is left chosen', async () => {
    const calls: Call[] = [];
    const added: string[] = [];
    const view = await mountBoth(calls, added);
    await type(view, KEY);
    await press(view.container.querySelector('[data-change-submit]'), 'Add');
    await until(() => added.length > 0, 'the login to be added');

    expect(calls.find(call => call.route === STAGE)?.body).toEqual({
      kind: 'login.add',
      id: 'claude-both-cli',
      harness: 'claude-code',
      halves: ['claude-code'],
      store: 'environment',
      preset: 'both-cli',
      env: { ANTHROPIC_BASE_URL: 'https://both.test/anthropic', BOTH_API_KEY: `\${secret:BOTH_KEY}` },
    });
    await view.unmount();
  });

  it('offers no choice for a preset that drives one CLI, and sends no halves', async () => {
    const calls: Call[] = [];
    const view = await mountForm(routes(NONE_HELD, calls));
    expect(view.container.querySelector('[data-quick-key-harness]')).toBeNull();
    await view.unmount();
  });
});

describe('the tile', () => {
  it('opens the key-only form, and More fields… opens today’s full form with the key as a reference', async () => {
    const calls: Call[] = [];
    const view = await mount(<AddLoginPanel client={routes(NONE_HELD, calls)} />);
    const c = view.container;
    await until(() => c.querySelector('[data-provider-tile="zai-glm"]') !== null, 'the tile');
    await press(c.querySelector('[data-provider-tile="zai-glm"]'), 'GLM / Z.ai');
    expect(c.querySelector('[data-quick-key-form="zai-glm"]')).not.toBeNull();
    expect(c.querySelector('[data-add-login-form]')).toBeNull();
    await press(c.querySelector('[data-quick-key-more]'), 'More fields…');
    expect(c.querySelector('[data-quick-key-form]')).toBeNull();
    const fields = Array.from(c.querySelectorAll<HTMLInputElement>('[data-add-login-form="zai-glm"] input'));
    expect(fields.map(field => field.value)).toEqual([
      'https://api.z.ai/api/anthropic',
      `\${secret:ZAI_API_KEY}`,
      '',
      '',
    ]);
    await view.unmount();
  });

  it('sends a preset that needs more than a key to the full form straight away', async () => {
    const [url, ...rest] = ZAI.variables;
    const needy = { ...ZAI, variables: [{ ...url, value: undefined }, ...rest] };
    const client = scripted({ 'GET /v1/logins/presets': { presets: [needy] }, [LIST]: loginList(login()) });
    const view = await mount(<AddLoginPanel client={client} />);
    const c = view.container;
    await until(() => c.querySelector('[data-provider-tile="zai-glm"]') !== null, 'the tile');
    await press(c.querySelector('[data-provider-tile="zai-glm"]'), 'GLM / Z.ai');
    expect(c.querySelector('[data-add-login-form="zai-glm"]')).not.toBeNull();
    expect(c.querySelector('[data-quick-key-form]')).toBeNull();
    await view.unmount();
  });
});
