import { describe, expect, it } from 'bun:test';
import type { LoginEnvironment } from '../../../contract/index.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { EnvironmentSection } from './support/environment-section.tsx';
import { typeInto } from './support/typing.ts';

const STAGE = 'POST /v1/logins/changes';
const APPLY = 'POST /v1/logins/changes/:changeId/apply';
const GRANTS = 'GET /v1/grants';
const OPEN = { capabilities: [{ capability: 'fleet', use: true, configure: true, configureRefusal: 'granted' }] };
/** A key-shaped string, assembled so no source line holds one. */
const KEY = ['sk', 'ant', 'b'.repeat(24)].join('-');

const ENVIRONMENT: LoginEnvironment = {
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' },
    { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
    { name: 'ODD_TOKEN', kind: 'hidden' },
  ],
  quotaSource: 'zai-coding-plan',
  missingSecrets: [],
  test: { available: false, reason: 'No preset.' },
};

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await until(() => !(target as HTMLButtonElement).disabled, `${what} to be enabled`);
  await interact(() => target.click());
};

/** The section on a client that stages and applies, so every change it sends can be read back from `calls`. */
const setup = async (extra: Record<string, unknown> = {}, online = true) => {
  const calls: Call[] = [];
  let reloads = 0;
  const client = scripted(
    {
      [GRANTS]: OPEN,
      [STAGE]: (call: Call) => ({
        id: 'chg1',
        change: call.body,
        summary: 'Change the variables',
        consequences: ['It changes something.'],
        expiresAt: '2026-11-01T10:15:00.000Z',
        state: 'pending',
      }),
      [APPLY]: { outcome: 'applied' },
      ...extra,
    },
    calls,
  );
  const view = await mount(
    <EnvironmentSection
      loginId="zai"
      environment={ENVIRONMENT}
      client={client}
      online={online}
      reload={async () => {
        reloads += 1;
      }}
    />,
  );
  const c = view.container;
  const field = (label: string) => c.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const stages = () => calls.filter(call => call.route === STAGE);
  return { view, c, calls, field, stages, reloads: () => reloads };
};

describe('editing a login’s environment', () => {
  it('offers Edit variables, and not while the machine is out of reach', async () => {
    const off = await setup({}, false);
    expect((off.c.querySelector('[data-login-env-edit]') as HTMLButtonElement).disabled).toBe(true);
    expect(off.c.querySelector('[data-login-env-editor]')).toBeNull();
    await off.view.unmount();
  });

  it('opens the editor with plain values filled in and secrets kept, and Cancel closes it with nothing sent', async () => {
    const t = await setup();
    await click(t.c.querySelector('[data-login-env-edit]'), 'Edit variables');
    expect(t.c.querySelector('[data-login-variable]')).toBeNull();
    expect(t.field('ANTHROPIC_BASE_URL value').value).toBe('https://api.z.ai/api/anthropic');
    expect(t.field('ANTHROPIC_AUTH_TOKEN value').value).toBe('');
    expect(t.field('ANTHROPIC_AUTH_TOKEN value').placeholder).toBe('(kept)');
    expect(t.c.querySelector('[data-env-row="ODD_TOKEN"]')?.textContent).toContain('Hidden, kept as it is');
    // Nothing is edited yet, so there is nothing to save.
    expect((t.c.querySelector('[data-change-submit]') as HTMLButtonElement).disabled).toBe(true);
    await click(t.c.querySelector('[data-env-cancel]'), 'Cancel');
    expect(t.c.querySelector('[data-login-env-editor]')).toBeNull();
    expect(t.c.querySelector('[data-login-variable="ODD_TOKEN"]')).not.toBeNull();
    expect(t.stages()).toHaveLength(0);
    await t.view.unmount();
  });

  it('saves an edited plain value as one login.env change that keeps every secret, then reloads and closes', async () => {
    const t = await setup();
    await click(t.c.querySelector('[data-login-env-edit]'), 'Edit variables');
    await typeInto(t.field('ANTHROPIC_BASE_URL value'), 'https://gw.example.test/v1');
    await click(t.c.querySelector('[data-change-submit]'), 'Save variables');
    await until(() => t.reloads() === 1, 'the reload');
    expect(t.stages()[0]?.body).toEqual({
      kind: 'login.env',
      id: 'zai',
      env: {
        ANTHROPIC_BASE_URL: 'https://gw.example.test/v1',
        ANTHROPIC_AUTH_TOKEN: { keep: true },
        ODD_TOKEN: { keep: true },
      },
    });
    expect(t.calls.some(call => call.route === APPLY)).toBe(true);
    await until(() => t.c.querySelector('[data-login-env-editor]') === null, 'the editor to close');
    await t.view.unmount();
  });

  it('accepts a secret reference typed over a secret and sends it as the reference', async () => {
    const t = await setup();
    await click(t.c.querySelector('[data-login-env-edit]'), 'Edit variables');
    await typeInto(t.field('ANTHROPIC_AUTH_TOKEN value'), `\${secret:WORK_KEY}`);
    await click(t.c.querySelector('[data-change-submit]'), 'Save variables');
    await until(() => t.stages().length === 1, 'the stage');
    expect(t.stages()[0]?.body).toMatchObject({ env: { ANTHROPIC_AUTH_TOKEN: `\${secret:WORK_KEY}` } });
    await t.view.unmount();
  });

  it('refuses a raw key before anything is sent, says which variable, and never shows the key', async () => {
    const t = await setup();
    await click(t.c.querySelector('[data-login-env-edit]'), 'Edit variables');
    await typeInto(t.field('ANTHROPIC_AUTH_TOKEN value'), KEY);
    await click(t.c.querySelector('[data-change-submit]'), 'Save variables');
    await until(
      () =>
        t.c.querySelector('[data-change-refusal]') !== null || t.c.textContent?.includes('looks like a key') === true,
      'the refusal',
    );
    expect(t.c.textContent).toContain('ANTHROPIC_AUTH_TOKEN looks like a key');
    expect(t.c.textContent).toContain(`\${secret:NAME}`);
    expect(t.stages()).toHaveLength(0);
    expect(t.calls.some(call => call.route === APPLY)).toBe(false);
    // The key sits in the box the person typed it into, and nowhere else on the screen.
    expect(t.c.textContent).not.toContain(KEY);
    // Editing again clears the refusal.
    await typeInto(t.field('ANTHROPIC_AUTH_TOKEN value'), `\${secret:WORK_KEY}`);
    expect(t.c.textContent).not.toContain('looks like a key');
    await t.view.unmount();
  });

  it('refuses a key typed as a variable NAME before anything is sent, and never shows it', async () => {
    const t = await setup();
    await click(t.c.querySelector('[data-login-env-edit]'), 'Edit variables');
    await click(t.c.querySelector('[data-env-add]'), 'Add a variable');
    const name = ['ghp', 'a1b2c3d4e5f6a1b2c3d4e5f6'].join('_');
    await typeInto(t.field('New variable name'), name);
    await typeInto(t.field(`${name} value`), 'https://gw.example.test');
    await click(t.c.querySelector('[data-change-submit]'), 'Save variables');
    await until(() => t.c.textContent?.includes('looks like a key') === true, 'the refusal');
    expect(t.stages()).toHaveLength(0);
    // The name sits in the box it was typed into, and nowhere in text.
    expect(t.c.textContent).not.toContain(name);
    await t.view.unmount();
  });

  it('adds a variable and removes another, and a removed one can be kept again', async () => {
    const t = await setup();
    await click(t.c.querySelector('[data-login-env-edit]'), 'Edit variables');
    await click(t.c.querySelector('[data-env-add]'), 'Add a variable');
    await typeInto(t.field('New variable name'), 'REGION');
    await typeInto(t.field('REGION value'), 'us-east-1');
    await click(t.c.querySelector('[data-env-remove="ODD_TOKEN"]'), 'Remove ODD_TOKEN');
    expect(t.c.querySelector('[data-env-row="ODD_TOKEN"] [data-env-removed]')).not.toBeNull();
    expect(t.c.querySelector('[data-env-remove="ODD_TOKEN"]')?.textContent).toBe('Keep it');
    await click(t.c.querySelector('[data-env-remove="ODD_TOKEN"]'), 'Keep it');
    expect(t.c.querySelector('[data-env-row="ODD_TOKEN"] [data-env-removed]')).toBeNull();
    await click(t.c.querySelector('[data-env-remove="ODD_TOKEN"]'), 'Remove ODD_TOKEN');
    await click(t.c.querySelector('[data-change-submit]'), 'Save variables');
    await until(() => t.stages().length === 1, 'the stage');
    expect(t.stages()[0]?.body).toEqual({
      kind: 'login.env',
      id: 'zai',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: { keep: true },
        REGION: 'us-east-1',
      },
    });
    await t.view.unmount();
  });

  it('keeps the editor open with the owner-confirmation sentence when the change is held', async () => {
    const t = await setup({
      [APPLY]: { outcome: 'held', sentences: ['ANTHROPIC_BASE_URL now points somewhere new'] },
    });
    await click(t.c.querySelector('[data-login-env-edit]'), 'Edit variables');
    await typeInto(t.field('ANTHROPIC_BASE_URL value'), 'https://gw.example.test/v1');
    await click(t.c.querySelector('[data-change-submit]'), 'Save variables');
    await until(() => t.c.textContent?.includes('the owner has to confirm it') === true, 'the held sentence');
    expect(t.c.textContent).toContain('ANTHROPIC_BASE_URL now points somewhere new');
    expect(t.c.querySelector('[data-login-env-editor]')).not.toBeNull();
    await t.view.unmount();
  });

  it('keeps the editor open with the daemon’s own sentence when the machine refuses the change', async () => {
    const t = await setup({ [STAGE]: new Error('no route') });
    await click(t.c.querySelector('[data-login-env-edit]'), 'Edit variables');
    await typeInto(t.field('ANTHROPIC_BASE_URL value'), 'https://gw.example.test/v1');
    await click(t.c.querySelector('[data-change-submit]'), 'Save variables');
    await until(() => t.c.textContent?.includes('didn’t answer') === true, 'the refusal');
    expect(t.c.querySelector('[data-login-env-editor]')).not.toBeNull();
    expect(t.reloads()).toBe(0);
    await t.view.unmount();
  });
});
