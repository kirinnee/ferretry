import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { LoginEnvironment } from '../../../contract/index.ts';
import { SignInsTab } from '../../../app/features/sign-ins-tab.tsx';
import { login, loginList } from '../cli/fakes.ts';
import { interact, mount, must } from '../support/dom.ts';
import { type Call, scripted } from './support/client.ts';
import { localModelsFixture as n } from './support/local-models.ts';

// The read-only cases of the Sign-ins tab: what the list and a login's page SHOW.

// Opening a login writes its address, so the window's hash is reset around every test here: the
// tab must never start on a page a previous test happened to leave behind, nor leave one behind.
beforeEach(() => {
  window.history.pushState({}, '', '/');
});
afterEach(() => {
  window.location.hash = '';
  window.history.pushState({}, '', '/');
});

const LIST = 'GET /v1/logins';
const REFRESH = 'POST /v1/models/local/refresh';
const NOW = Date.parse('2026-10-13T08:00:00.000Z');

const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}`);
};

const text = (container: HTMLElement, selector: string): string | undefined =>
  container.querySelector(selector)?.textContent ?? undefined;

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
};

const status = (word: string, label: string, explanation: string) => ({
  word,
  label,
  reason: 'access_current',
  explanation,
  lastCheckInconclusive: false,
});

const open = async (logins: ReturnType<typeof login>[], calls: Call[] = [], extra: Record<string, unknown> = {}) => {
  const view = await mount(
    <SignInsTab client={scripted({ [LIST]: loginList(...logins), ...extra }, calls)} now={() => NOW} />,
  );
  await until(() => view.container.querySelector('[data-logins-tab]') !== null, 'the tab');
  return view;
};

const personal = login({
  id: 'claude-personal',
  label: 'personal',
  sharedWithTerminal: true,
  usedBy: ['claude-default', 'claude-agent', 'claude-review'],
  usage: {
    fiveHour: { usedPercent: 38, resetsAt: '2026-10-13T10:00:00.000Z' },
    weekly: { usedPercent: 83, resetsAt: '2026-10-16T08:00:00.000Z' },
  },
});
const work = login({
  id: 'claude-work',
  label: 'work',
  email: 'work@example.com',
  needsLabel: true,
  status: status('refresh_due', 'Refresh due', 'Refresh soon.'),
  usage: { fiveHour: {}, weekly: {} },
});
const codex = login({
  id: 'codex',
  harness: 'codex',
  harnesses: ['codex'],
  email: 'c@example.com',
  sharedWithTerminal: true,
  usage: { fiveHour: {}, weekly: {} },
});

describe('the Sign-ins list', () => {
  it('groups logins by tool, with status, use, badges and the usage bars', async () => {
    const view = await open([personal, work, codex]);
    const c = view.container;
    expect(text(c, '[data-logins-tab] > div > p')).toBe('3 logins on box');
    const claude = must(c.querySelector('[data-logins-group="claude-code"]'), 'the Claude group');
    expect(claude.querySelector('h4')?.textContent).toBe('Claude Code');
    expect(
      must(c.querySelector('[data-logins-group="codex"]'), 'the Codex group').querySelector('h4')?.textContent,
    ).toBe('Codex');
    expect(
      Array.from(claude.querySelectorAll('[data-login-row]')).map(row => row.getAttribute('data-login-row')),
    ).toEqual(['claude-personal', 'claude-work']);

    const row = must(c.querySelector('[data-login-row="claude-personal"]'), 'personal row');
    expect(row.textContent).toContain('you@example.com');
    expect(row.querySelector('[data-login-badges]')?.textContent).toBe(
      'Claude onlypersonalShared with claude in your terminal',
    );
    expect(row.textContent).toContain('Ready · Used by 3 runtimes');
    const bars = Array.from(row.querySelectorAll('[role="img"]'));
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual([
      '5h: 38% used · resets in 2h',
      'Week: 83% used · resets in 3d',
    ]);
    expect(bars[0]?.querySelector('span')?.className).toContain('bg-accent');
    expect(bars[1]?.querySelector('span')?.className).toContain('bg-warn');
    expect(bars[1]?.querySelector('span')?.getAttribute('style')).toContain('83%');

    const refresh = must(c.querySelector('[data-login-row="claude-work"]'), 'work row');
    expect(refresh.textContent).toContain('Refresh due · Used by 1 runtime');
    expect(refresh.querySelector('[data-login-usage]')).toBeNull();
    expect(refresh.querySelector('[data-login-badges]')?.textContent).toBe('Claude onlywork');

    const codexRow = must(c.querySelector('[data-login-row="codex"]'), 'codex row');
    expect(codexRow.textContent).toContain('Shared with codex in your terminal');
    expect(codexRow.querySelector('[data-login-usage="unknown"]')?.textContent).toBe('Usage not measured yet');
    expect(c.querySelector('[data-logins-labels-hint]')?.textContent).toContain('Two logins share an email');
    await view.unmount();
  });

  it('says what it cannot measure, copied slots, and a login whose email nobody told us', async () => {
    const slot = login({
      id: 'claude-slot',
      email: undefined,
      clonedFrom: 'laptop',
      usedBy: [],
      status: status('needs_sign_in', 'Needs sign-in', 'Sign in.'),
    });
    const half = login({
      id: 'claude-half',
      email: 'half@example.com',
      usedBy: [],
      usage: { fiveHour: { usedPercent: 12.4, resetsAt: '2026-10-13T07:00:00.000Z' }, weekly: {} },
    });
    const view = await open([slot, half]);
    const c = view.container;
    const slotRow = must(c.querySelector('[data-login-row="claude-slot"]'), 'slot row');
    expect(slotRow.textContent).toContain('Claude Code login');
    expect(slotRow.querySelector('[data-login-badges]')?.textContent).toBe('Claude onlyCopied slot from laptop');
    expect(slotRow.textContent).toContain('Needs sign-in · Not used yet');
    const halfRow = must(c.querySelector('[data-login-row="claude-half"]'), 'half row');
    expect(Array.from(halfRow.querySelectorAll('[role="img"]')).map(bar => bar.getAttribute('aria-label'))).toEqual([
      '5h: 12% used · resets now',
      'Week: not measured yet',
    ]);
    expect(halfRow.textContent).toContain('not measured');
    expect(halfRow.querySelector('[data-login-badges]')?.textContent).toBe('Claude only');
    expect(c.querySelector('[data-logins-labels-hint]')).toBeNull();
    expect(c.querySelector('[data-logins-group="codex"]')).toBeNull();
    await view.unmount();
  });

  it('lists a login that drives both CLIs once, in its own group, with its Claude + Codex chip and page', async () => {
    const dual = login({ id: 'deepseek', store: 'environment', email: undefined, harnesses: ['claude-code', 'codex'] });
    const view = await open([login({ id: 'claude' }), dual]);
    const c = view.container;
    expect(
      Array.from(c.querySelectorAll('[data-logins-group]')).map(group => group.getAttribute('data-logins-group')),
    ).toEqual(['claude-code', 'both']);
    const both = must(c.querySelector('[data-logins-group="both"]'), 'the both group');
    expect(both.querySelector('h4')?.textContent).toBe('Claude Code + Codex');
    expect(c.querySelectorAll('[data-login-row="deepseek"]')).toHaveLength(1);
    expect(both.querySelector('[data-login-scope]')?.getAttribute('data-login-scope')).toBe('both');
    expect(both.querySelector('[data-login-badges]')?.textContent).toBe('Claude + Codex');
    await click(c.querySelector('[data-login-row="deepseek"]'), 'the row');
    expect(text(c, 'h3')).toBe('Claude Code + Codex login');
    await view.unmount();
  });

  it('explains the labels when a login says it needs one, even before two share an email', async () => {
    const view = await open([login({ id: 'claude-a', email: 'a@example.com', needsLabel: true })]);
    expect(view.container.querySelector('[data-logins-labels-hint]')).not.toBeNull();
    expect(text(view.container, '[data-logins-tab] > div > p')).toBe('1 login on box');
    await view.unmount();
  });

  it('reads first, then lists', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const inner = scripted({ [LIST]: loginList(login()) });
    const view = await mount(<SignInsTab client={{ call: async (...args) => (await gate, inner.call(...args)) }} />);
    expect(text(view.container, '[data-logins-loading]')).toBe('Reading the logins on this machine…');
    release();
    await until(() => view.container.querySelector('[data-logins-tab]') !== null, 'the tab');
    expect(view.container.querySelector('[data-logins-loading]')).toBeNull();
    await view.unmount();
  });

  it('with no logins it says so and offers Add a login; backing out returns to the list', async () => {
    const view = await mount(<SignInsTab client={scripted({ [LIST]: loginList() })} />);
    await until(() => view.container.querySelector('[data-logins-empty]') !== null, 'the empty state');
    expect(text(view.container, '[data-logins-empty] h3')).toBe('No logins on box');
    expect(text(view.container, '[data-logins-empty] p')).toBe(
      'A login is one sign-in or key to Claude Code or Codex. It belongs to this machine.',
    );
    await click(view.container.querySelector('[data-logins-empty] [data-add-login]'), 'Add a login');
    expect(view.container.querySelector('[data-logins-adding]')).not.toBeNull();
    await click(view.container.querySelector('[data-logins-adding] button'), 'Logins');
    expect(view.container.querySelector('[data-logins-empty]')).not.toBeNull();
    await view.unmount();
  });
});

describe('a login’s page', () => {
  it('shows the status and its words, the usage, who uses it, and goes back to the list', async () => {
    const view = await open([personal, work, codex]);
    const c = view.container;
    await click(c.querySelector('[data-login-row="claude-personal"]'), 'the row');
    expect(c.querySelector('[data-login-page]')?.getAttribute('data-login-page')).toBe('claude-personal');
    expect(text(c, 'h3')).toBe('Claude Code login');
    expect(text(c, '[data-login-page] p.font-mono')).toBe('you@example.com (personal)');
    expect(text(c, '[data-login-page] [data-login-badges]')).toBe(
      'Claude onlypersonalShared with claude in your terminal',
    );
    expect(c.querySelector('[data-login-status]')?.getAttribute('data-login-status')).toBe('ready');
    expect(c.querySelectorAll('[data-login-status] [role="img"]')).toHaveLength(2);
    expect(
      Array.from(c.querySelectorAll('[data-login-runtime]')).map(item => item.getAttribute('data-login-runtime')),
    ).toEqual(['claude-default', 'claude-agent', 'claude-review']);
    await click(c.querySelector('[data-page-back]'), 'Logins');
    expect(c.querySelector('[data-login-page]')).toBeNull();
    expect(c.querySelectorAll('[data-login-row]')).toHaveLength(3);
    await view.unmount();
  });

  it('a login nothing uses says so, and a copied empty slot says it needs a sign-in rather than offering a check', async () => {
    const slot = login({
      id: 'claude-slot',
      email: undefined,
      clonedFrom: 'laptop',
      usedBy: [],
      status: status('needs_sign_in', 'Needs sign-in', 'Sign in once and every runtime that uses it can launch.'),
    });
    const view = await open([slot]);
    await click(view.container.querySelector('[data-login-row="claude-slot"]'), 'the row');
    expect(text(view.container, '[data-login-status]')).toContain(
      'Sign in once and every runtime that uses it can launch.',
    );
    expect(view.container.textContent).toContain('No runtime uses this login yet.');
    expect(view.container.querySelector('[data-login-actions]')).toBeNull();
    expect(view.container.querySelector('[data-login-status] [data-login-usage]')).toBeNull();
    expect(view.container.querySelector('[data-login-sign-in]')).not.toBeNull();
    await view.unmount();
  });
});

describe('an environment login', () => {
  const environment: LoginEnvironment = {
    preset: { id: 'zai-glm', label: 'GLM / Z.ai', docs: 'https://docs.z.ai/devpack/tool/claude' },
    variables: [{ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true }],
    quotaSource: 'zai-coding-plan',
    missingSecrets: [],
    test: { available: true, spends: 'nothing', note: 'Reads your quota. Spends nothing.' },
  };
  const { preset: _preset, ...noPreset } = environment;
  const glm = login({ id: 'glm-env', store: 'environment', email: undefined, environment });

  it('lists it by its id with its scope and preset chips', async () => {
    const view = await open([
      glm,
      login({ id: 'hand-env', harness: 'codex', harnesses: ['codex'], store: 'environment', email: undefined }),
      login({ id: 'hand-made', store: 'environment', email: undefined, environment: noPreset }),
    ]);
    const c = view.container;
    const row = must(c.querySelector('[data-login-row="glm-env"]'), 'the GLM row');
    expect(row.textContent).toContain('glm-env');
    expect(row.querySelector('[data-login-badges]')?.textContent).toBe('Claude onlyEnvironment · GLM / Z.ai');
    expect(c.querySelector('[data-login-row="hand-made"] [data-login-environment-chip]')?.textContent).toBe(
      'Environment',
    );
    expect(c.querySelector('[data-login-row="hand-env"] [data-login-badges]')?.textContent).toBe('Codex only');
    await view.unmount();
  });

  it('shows its provider quota in the list and on its page, in place of the 5-hour and weekly bars', async () => {
    const quoted = login({
      id: 'glm-env',
      store: 'environment',
      email: undefined,
      environment,
      usage: {
        fiveHour: { usedPercent: 64 },
        weekly: {},
        provider: {
          source: 'zai-coding-plan',
          via: 'endpoint',
          windows: [{ label: '5h', usedPercent: 64 }],
          exhausted: false,
          unverified: true,
          at: '2026-10-16T09:00:00.000Z',
        },
      },
    });
    const view = await open([quoted]);
    const row = must(view.container.querySelector('[data-login-row="glm-env"]'), 'the row');
    expect(row.querySelector('[data-provider-quota="endpoint"]')).not.toBeNull();
    expect(row.querySelector('[data-login-usage=""]')).toBeNull();
    await click(row, 'the row');
    expect(view.container.querySelector('[data-provider-quota-window="5h"]')?.textContent).toContain('64% used');
    await view.unmount();
  });

  it('shows its variables and its Test on its page', async () => {
    const view = await open([glm]);
    await click(view.container.querySelector('[data-login-row="glm-env"]'), 'the row');
    const panel = must(view.container.querySelector('[data-login-environment="glm-env"]'), 'the panel');
    expect(panel.textContent).toContain('${secret:ZAI_API_KEY} set ✓');
    expect(panel.querySelector('[data-login-test-run]')).not.toBeNull();
    await view.unmount();
  });
});

describe('an Ollama login', () => {
  const environment: LoginEnvironment = {
    preset: { id: 'ollama-codex', label: 'Ollama (local)', docs: 'https://docs.ollama.com' },
    variables: [],
    quotaSource: 'transcript-pricing',
    missingSecrets: [],
    test: { available: false, reason: 'Ollama is checked on the models panel.' },
  };
  const ollama = login({
    id: 'ollama-local',
    harness: 'codex',
    harnesses: ['codex'],
    store: 'environment',
    email: undefined,
    environment,
  });
  const only = (calls: readonly Call[]) => calls.filter(call => call.route === REFRESH);

  it('reads Ollama once when its page opens, lists what is installed, and asks again only on Check again', async () => {
    const calls: Call[] = [];
    let answer = n('not-running');
    const view = await open([ollama], calls, { [REFRESH]: () => answer });
    await click(view.container.querySelector('[data-login-row="ollama-local"]'), 'the row');
    const c = view.container;
    await until(() => c.querySelector('[data-local-models-panel="not-running"]') !== null, 'the panel');
    expect(only(calls)).toHaveLength(1);
    answer = n('found');
    await click(c.querySelector('[data-local-models-check]'), 'Check again');
    await until(() => c.querySelector('[data-local-models-panel="found"]') !== null, 'the found panel');
    expect(c.querySelectorAll('[data-local-model]')).toHaveLength(2);
    expect(only(calls)).toHaveLength(2);
    await view.unmount();
  });

  it('asks nothing on the list, nor on another login’s page', async () => {
    const glm = login({
      id: 'glm-env',
      store: 'environment',
      email: undefined,
      environment: { variables: [], quotaSource: 'transcript-pricing', missingSecrets: [], test: environment.test },
    });
    const calls: Call[] = [];
    const view = await open([ollama, glm], calls, { [REFRESH]: () => n('found') });
    await interact(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(only(calls)).toHaveLength(0);
    await click(view.container.querySelector('[data-login-row="glm-env"]'), 'the row');
    await interact(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(only(calls)).toHaveLength(0);
    expect(view.container.querySelector('[data-local-models-panel]')).toBeNull();
    await view.unmount();
  });
});

describe('a login that is gone', () => {
  it('says so and still shows the list', async () => {
    // A page open on a login that a later read no longer lists falls back to the list with the sentence.
    const calls: Call[] = [];
    let list = loginList(login(), login({ id: 'claude-b', email: 'b@example.com' }));
    const view = await mount(
      <SignInsTab client={scripted({ [LIST]: () => list, 'POST /v1/logins/:loginId/check': login() }, calls)} />,
    );
    await until(() => view.container.querySelector('[data-logins-tab]') !== null, 'the tab');
    await click(view.container.querySelector('[data-login-row="claude-b"]'), 'the row');
    list = loginList(login());
    await until(
      () =>
        !(view.container.querySelector('[data-login-actions] [data-change-submit]') as HTMLButtonElement | null)
          ?.disabled,
      'check',
    );
    await click(view.container.querySelector('[data-login-actions] [data-change-submit]'), 'Check now');
    await until(() => view.container.querySelector('[data-login-missing]') !== null, 'the missing sentence');
    expect(text(view.container, '[data-login-missing]')).toBe('There is no login claude-b on box any more.');
    expect(view.container.querySelectorAll('[data-login-row]')).toHaveLength(1);
    await view.unmount();
  });
});
