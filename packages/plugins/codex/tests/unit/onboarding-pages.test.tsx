/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import app from '../../app/index.ts';
import manifest from '../../manifest.ts';
import { ABSENT_VIEW } from '../../contract/testing/index.ts';
import type { HarnessCliView } from '../../contract/index.ts';
import { readConfigText } from '@ferretry/std/yaml';
import { modeOf, signInFacts, withMode } from '../../app/features/onboarding/onboarding-api.ts';
import { createRoot } from '../support/dom.ts';
import { type StepHarness, stepHarness } from '@ferretry/plugin-onboarding/contract/testing';

const mounted: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
});

const FOUND: HarnessCliView = {
  ...ABSENT_VIEW,
  location: { state: 'located', path: '/fixture/bin/codex', rule: 'inherited environment', declaredBy: 'PATH' },
  installed: { state: 'ok', version: '0.140.0' },
};
const SCAN_MISSING = {
  machine: 'fixture',
  format: 'none',
  tools: [
    { harness: 'claude-code', label: 'Claude Code', installed: true },
    {
      harness: 'codex',
      label: 'Codex',
      installed: false,
      install: { kind: 'runnable', command: 'npm install -g @openai/codex' },
    },
  ],
  harnesses: [],
  runtimes: [],
  updates: [],
  duplicates: [],
  notes: [],
  importing: { available: true },
};

type Call = { readonly route: string; readonly options?: { readonly body?: unknown } };
type Answer = (route: string, options?: Call['options']) => unknown;

/** The Codex half's `step-<id>` panel, mounted for one step with the harness as its host. */
async function mount(step: string, harness: StepHarness, answer: Answer) {
  const calls: Call[] = [];
  const half = app.build?.({
    manifest,
    client: {
      call: async (route: string, options?: Call['options']) => {
        calls.push({ route, ...(options === undefined ? {} : { options }) });
        const value = answer(route, options);
        if (value instanceof Error) throw value;
        return value;
      },
      subscribe: () => () => {},
    },
  } as never);
  const Panel = half?.panels?.[`step-${step}`];
  if (Panel === undefined) throw new Error('missing the step panel');
  const container = document.createElement('div');
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(Panel as never, { subject: `codex.${step}`, step: harness.host }));
  });
  await act(async () => {});
  return { container, calls };
}
const press = async (container: HTMLElement, selector: string) => {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => {
    button?.click();
  });
  await act(async () => {});
};

describe('the declared steps', () => {
  test('the Codex segment is eleven daemon steps, orders 40 to 50, in the group "Codex"', () => {
    const steps: readonly { id: string; order: number; group?: string; side?: string }[] = manifest.onboarding ?? [];
    expect(steps.map(step => step.order)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
    expect(steps.every(step => step.group === 'Codex' && (step.side ?? 'daemon') === 'daemon')).toBe(true);
    expect(steps.map(step => step.id)).toEqual([
      'installed',
      'sign-in',
      'import-choice',
      'import-settings',
      'import-model-set',
      'import-instructions',
      'import-skills',
      'import-mcp',
      'conversations',
      'import-run',
      'permission',
    ]);
    expect(steps.some(step => step.id === 'harness')).toBe(false);
  });
});

describe('installed', () => {
  test('is skipped when Codex is found, and draws nothing', async () => {
    const harness = stepHarness();
    const { container } = await mount('installed', harness, () => FOUND);
    expect(harness.decision).toBe('skipped');
    expect(harness.skippedWhy).toBe('not-needed');
    expect(container.textContent).toBe('');
  });

  test('shows the exact command first, and Install runs only that, busy while it does', async () => {
    const harness = stepHarness();
    let installed = false;
    const { container, calls } = await mount('installed', harness, route => {
      if (route === 'GET /v1/codex/update') return installed ? FOUND : ABSENT_VIEW;
      if (route === 'GET /v1/runtimes/setup/scan') return SCAN_MISSING;
      installed = true;
      return {
        outcomes: [
          {
            harness: 'codex',
            outcome: 'installed',
            command: 'npm install -g @openai/codex',
            output: ['added 1 package'],
          },
        ],
      };
    });
    expect(harness.decision).toBe('shown');
    expect(container.querySelector('[data-install-command]')?.textContent).toBe('npm install -g @openai/codex');
    expect(calls.some(call => call.route.startsWith('POST'))).toBe(false);
    await press(container, '[data-install-run]');
    const install = calls.find(call => call.route === 'POST /v1/runtimes/machine/tools/install');
    // The request is bound to the plan on the screen: the daemon compares this command with its own before it spawns.
    expect(install?.options?.body).toEqual({
      harnesses: ['codex'],
      shown: [{ harness: 'codex', command: 'npm install -g @openai/codex' }],
    });
    expect(
      harness.calls.filter(call => call.kind === 'busy').map(call => (call.kind === 'busy' ? call.label : '')),
    ).toEqual(['Installing Codex…', null]);
    expect(harness.count('done')).toBe(1);
    expect(container.textContent).toContain('0.140.0 is installed');
  });

  test('a failed install says why and keeps the command to run by hand', async () => {
    const harness = stepHarness();
    const { container } = await mount('installed', harness, route =>
      route === 'GET /v1/codex/update'
        ? ABSENT_VIEW
        : route === 'GET /v1/runtimes/setup/scan'
          ? SCAN_MISSING
          : {
              outcomes: [
                {
                  harness: 'codex',
                  outcome: 'failed',
                  cause: 'needs-admin',
                  reason: 'It needs admin rights.',
                  manualCommand: 'sudo npm i -g @openai/codex',
                  output: [],
                },
              ],
            },
    );
    await press(container, '[data-install-run]');
    expect(container.querySelector('[data-install-note]')?.textContent).toContain('sudo npm i -g @openai/codex');
    expect(harness.count('done')).toBe(0);
  });

  test('with no package manager there is no Install button, only the command and a recheck', async () => {
    const harness = stepHarness();
    const scan = {
      ...SCAN_MISSING,
      tools: [
        {
          harness: 'codex',
          label: 'Codex',
          installed: false,
          install: { kind: 'no-package-manager', reason: 'No npm here.', manualCommand: 'brew install codex' },
        },
      ],
    };
    const { container } = await mount('installed', harness, route =>
      route === 'GET /v1/codex/update' ? ABSENT_VIEW : scan,
    );
    expect(container.querySelector('[data-install-run]')).toBeNull();
    expect(container.querySelector('[data-install-command]')?.textContent).toBe('brew install codex');
    expect(container.querySelector('[data-install-recheck]')).not.toBeNull();
  });
});

describe('sign-in', () => {
  const codexLogin = (
    word: 'ready' | 'refresh_due' | 'needs_sign_in' | 'checking',
    extra: { readonly id?: string; readonly disabled?: true; readonly canSignIn?: boolean } = {},
  ) =>
    sampleLogin(extra.id ?? 'codex-main', {
      harness: 'codex',
      harnesses: ['codex'],
      status: {
        word,
        label: word === 'ready' ? 'Ready' : 'Sign in',
        reason: word === 'ready' ? 'access_current' : 'not_signed_in',
        explanation: 'fixture',
        lastCheckInconclusive: false,
      },
      signIn:
        (extra.canSignIn ?? word === 'needs_sign_in') ? { available: true } : { available: false, reason: 'fixture' },
      ...(extra.disabled === true ? { disabled: { source: 'login' as const } } : {}),
    });
  const list = (...logins: ReturnType<typeof codexLogin>[]) => ({ format: 1, machine: 'fixture', logins });

  test('is skipped when a Codex login is ready (a Claude login does not count)', async () => {
    const harness = stepHarness();
    await mount('sign-in', harness, () => list(codexLogin('ready'), sampleLogin('claude-main')));
    expect(harness.decision).toBe('skipped');
  });

  test('a Claude-only machine still needs a Codex sign-in', async () => {
    const harness = stepHarness();
    const { container } = await mount('sign-in', harness, () => list(sampleLogin('claude-main')));
    expect(harness.decision).toBe('shown');
    expect(container.textContent).toContain('no Codex login');
  });

  test('a login that needs signing in is shown, never skipped', async () => {
    const harness = stepHarness();
    const { container } = await mount('sign-in', harness, () => list(codexLogin('needs_sign_in')));
    expect(harness.decision).toBe('shown');
    expect(container.textContent).toContain('needs you to sign in');
  });

  test('a switched-off ready login is not signed in: the step is shown, never skipped', async () => {
    const harness = stepHarness();
    const { container } = await mount('sign-in', harness, () => list(codexLogin('ready', { disabled: true })));
    expect(harness.decision).toBe('shown');
    expect(container.textContent).toContain('no Codex login');
  });

  test('a login that is still being checked is not signed in: it says so and offers to check again', async () => {
    const harness = stepHarness();
    let reads = 0;
    const { container } = await mount('sign-in', harness, () => {
      reads += 1;
      return list(codexLogin(reads === 1 ? 'checking' : 'ready'));
    });
    expect(harness.decision).toBe('shown');
    expect(container.querySelector('[data-codex-checking]')).not.toBeNull();
    await press(container, '[data-codex-retry]');
    expect(harness.count('done')).toBe(1);
    expect(container.textContent).toContain('Signed in as');
  });

  test('a login that needs signing in but cannot be signed in from here does not hide the add-login action', async () => {
    const harness = stepHarness();
    const { container } = await mount('sign-in', harness, () =>
      list(codexLogin('needs_sign_in', { canSignIn: false })),
    );
    expect(harness.decision).toBe('shown');
    expect(container.textContent).toContain('no Codex login');
    expect(container.textContent).not.toContain('needs you to sign in');
  });

  test('the facts pick the signable login among several, and ignore switched-off rows', () => {
    const view = (...logins: ReturnType<typeof codexLogin>[]) => ({ format: 1 as const, machine: 'fixture', logins });
    const stuck = codexLogin('needs_sign_in', { id: 'a', canSignIn: false });
    const signable = codexLogin('needs_sign_in', { id: 'b' });
    expect(signInFacts(view(stuck, signable))).toEqual({ state: 'needs-sign-in', login: signable });
    expect(signInFacts(view(stuck, codexLogin('checking', { id: 'c' })))).toEqual({ state: 'checking' });
    expect(signInFacts(view(codexLogin('needs_sign_in', { disabled: true })))).toEqual({ state: 'no-login' });
    expect(signInFacts(view(codexLogin('refresh_due')))).toMatchObject({ state: 'signed-in' });
    expect(
      signInFacts(view(codexLogin('ready', { id: 'off', disabled: true }), codexLogin('ready', { id: 'on' }))),
    ).toMatchObject({ state: 'signed-in' });
  });
});

describe('import-choice', () => {
  test('opens on Import everything and remembers it for the later pages', async () => {
    const harness = stepHarness();
    const { container } = await mount('import-choice', harness, () => ({}));
    expect(harness.decision).toBe('shown');
    expect(harness.segment.importMode).toBe('everything');
    expect(container.querySelector<HTMLInputElement>('input[value="everything"]')?.checked).toBe(true);
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(3);
  });

  test('a choice is remembered, not saved (the shell records Next); a returning page opens on the earlier choice', async () => {
    const harness = stepHarness();
    const { container } = await mount('import-choice', harness, () => ({}));
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="fresh"]')?.click();
    });
    expect(harness.segment.importMode).toBe('fresh');
    expect(harness.count('done')).toBe(0);
    const again = stepHarness({ segment: { importMode: 'choose' } });
    const second = await mount('import-choice', again, () => ({}));
    expect(second.container.querySelector<HTMLInputElement>('input[value="choose"]')?.checked).toBe(true);
  });
});

describe('permission', () => {
  const file = (text: string, extra: Record<string, unknown> = {}) => ({
    path: 'harness-codex.yaml',
    exists: true,
    text,
    etag: 'e1',
    absolutePath: '/home/fixture/config/harness-codex.yaml',
    issues: [],
    ...extra,
  });
  const radio = (container: HTMLElement, value: string) =>
    container.querySelector<HTMLInputElement>(`input[value="${value}"]`);
  const choose = async (container: HTMLElement, value: string) => {
    await act(async () => {
      radio(container, value)?.click();
    });
    await act(async () => {});
  };
  const putOf = (calls: readonly Call[]) => calls.find(call => call.route === 'PUT /v1/config/file');
  const putText = (calls: readonly Call[]) => (putOf(calls)?.options?.body as { text: string } | undefined)?.text ?? '';
  const busyLabels = (harness: StepHarness) =>
    harness.calls.filter(call => call.kind === 'busy').map(call => (call.kind === 'busy' ? call.label : ''));

  test('opens on the config value (skip when unset), says what skip allows and names the real flag', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, () => file(''));
    expect(radio(container, 'skip')?.checked).toBe(true);
    expect(container.textContent).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(container.textContent).toContain('without asking you, including deleting files');
  });

  test('choosing Auto writes only permissionMode, every other line kept', async () => {
    const harness = stepHarness();
    const text = 'binary: /opt/codex # mine\nsearchPaths:\n  - ~/bin\npermissionMode: skip\n';
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'applied' } : file(text),
    );
    await choose(container, 'auto');
    expect(putOf(calls)?.options?.body).toEqual({
      path: 'harness-codex.yaml',
      text: 'binary: /opt/codex # mine\nsearchPaths:\n  - ~/bin\npermissionMode: auto\n',
      etag: 'e1',
    });
    expect(harness.count('done')).toBe(1);
  });

  // Valid YAML spellings of "Auto" that a line pattern misreads, and the one-key edit that must not corrupt them.
  const AUTO_FORMS: readonly (readonly [string, string])[] = [
    ['a flow map', '{permissionMode: auto, dangerousRmWaiver: false}\n'],
    ['a folded scalar', 'permissionMode: >-\n  auto\nbinary: /opt/codex\n'],
    ['a quoted key', "'permissionMode': auto\nbinary: /opt/codex\n"],
    ['a double-quoted key and value', '"permissionMode": "auto"\nbinary: /opt/codex\n'],
    ['an inline comment', 'binary: /opt/codex\npermissionMode: auto # I chose this\n'],
  ];
  for (const [name, text] of AUTO_FORMS) {
    test(`shows Auto for ${name}, and Skip writes exactly one valid permissionMode`, async () => {
      const harness = stepHarness();
      const { container, calls } = await mount('permission', harness, route =>
        route.startsWith('PUT') ? { outcome: 'applied' } : file(text),
      );
      expect(radio(container, 'auto')?.checked).toBe(true);
      expect(container.querySelector('[data-permission-words]')).toBeNull();
      await choose(container, 'skip');
      await press(container, '[data-permission-confirm]');
      const written = putText(calls);
      const read = readConfigText(written);
      expect(read.ok).toBe(true);
      expect(read.ok ? (read.read.value as { permissionMode?: string }).permissionMode : undefined).toBe('skip');
      expect(written.match(/permissionMode/gu)?.length).toBe(1);
      expect(harness.count('done')).toBe(1);
    });
  }

  test('an inline comment and the other keys survive the write', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT')
        ? { outcome: 'applied' }
        : file('# mine\nbinary: /opt/codex\npermissionMode: skip # keep\n'),
    );
    await choose(container, 'auto');
    expect(putText(calls)).toBe('# mine\nbinary: /opt/codex\npermissionMode: auto # keep\n');
  });

  test('a quoted-key Skip is shown as Skip, not misread as unset', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, () => file('\'permissionMode\': "skip"\n'));
    expect(radio(container, 'skip')?.checked).toBe(true);
  });

  test('Skip from Auto shows the whole consequence first and writes nothing until it is confirmed', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'applied' } : file('permissionMode: auto\n'),
    );
    expect(container.querySelector('[data-permission-words]')).toBeNull();
    await choose(container, 'skip');
    // The selection shows the warning (no approvals, no sandbox, deleting files, the real flag) and nothing was written.
    expect(radio(container, 'skip')?.checked).toBe(true);
    expect(container.querySelector('[data-permission-words="skip"]')?.textContent).toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
    expect(container.textContent).toContain('including deleting files');
    expect(container.textContent).toContain('no approvals, no sandbox');
    expect(putOf(calls)).toBeUndefined();
    // Not answerable by default while the confirm is open: the page holds the step busy, so Next cannot record it.
    expect(busyLabels(harness).at(-1)).toBe('Confirm or cancel Skip permissions');
    expect(harness.count('done')).toBe(0);
    await press(container, '[data-permission-confirm]');
    expect(putText(calls)).toBe('permissionMode: skip\n');
    expect(harness.count('done')).toBe(1);
    expect(busyLabels(harness).at(-1)).toBeNull();
  });

  test('cancelling the Skip confirm leaves Auto in place and writes nothing', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('permission', harness, () => file('permissionMode: auto\n'));
    await choose(container, 'skip');
    await press(container, '[data-permission-cancel]');
    expect(radio(container, 'auto')?.checked).toBe(true);
    expect(container.querySelector('[data-permission-words]')).toBeNull();
    expect(putOf(calls)).toBeUndefined();
    expect(busyLabels(harness).at(-1)).toBeNull();
    expect(harness.count('done')).toBe(0);
  });

  test('picking Auto while the Skip confirm is open drops the confirm', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('permission', harness, () => file('permissionMode: auto\n'));
    await choose(container, 'skip');
    await choose(container, 'auto');
    expect(container.querySelector('[data-permission-confirm]')).toBeNull();
    expect(putOf(calls)).toBeUndefined();
    expect(busyLabels(harness).at(-1)).toBeNull();
  });

  test('a change the daemon holds is said, not shown as saved', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'pending' } : file('permissionMode: auto\n'),
    );
    await choose(container, 'skip');
    await press(container, '[data-permission-confirm]');
    expect(container.querySelector('[data-permission-note]')?.textContent).toContain('waiting for your confirmation');
    expect(harness.count('done')).toBe(0);
  });

  const WITHHELD =
    '# ‹hidden›: the text of this file is not shown because it holds a raw secret, which the owner must move into the secret store; edit it at the machine\n';
  for (const [name, answer] of [
    [
      'withheld by the daemon',
      file(WITHHELD, { issues: [{ message: 'the text of this file is not shown because x' }] }),
    ],
    ['withheld (only the comment line says so)', file(WITHHELD)],
    ['not valid YAML', file('permissionMode: [auto\n')],
    ['holding a mode this page does not know', file('permissionMode: yolo\n')],
    ['a list, not a mapping', file('- permissionMode\n')],
  ] as const) {
    test(`a file ${name}: the mode is unknown, nothing is written, and it says where to change it`, async () => {
      const harness = stepHarness();
      const { container, calls } = await mount('permission', harness, () => answer);
      expect(harness.decision).toBe('shown');
      expect(container.querySelector('[data-permission-unknown]')?.textContent).toContain(
        'Change this at the machine: /home/fixture/config/harness-codex.yaml',
      );
      expect(radio(container, 'skip')?.checked).toBe(false);
      expect(radio(container, 'auto')?.checked).toBe(false);
      expect(radio(container, 'auto')?.disabled).toBe(true);
      await choose(container, 'auto');
      await choose(container, 'skip');
      expect(putOf(calls)).toBeUndefined();
      expect(container.querySelector('[data-permission-confirm]')).toBeNull();
      expect(harness.count('done')).toBe(0);
    });
  }
});

describe('the panel', () => {
  test('every declared step has a page, so none is left to hang the flow', () => {
    const half = app.build?.({ manifest, client: { call: async () => ({}), subscribe: () => () => {} } } as never);
    for (const step of manifest.onboarding ?? []) expect(half?.panels?.[`step-${step.id}`]).toBeDefined();
  });

  test("another plugin's step draws nothing and asks nothing", async () => {
    const harness = stepHarness();
    const calls: string[] = [];
    const half = app.build?.({
      manifest,
      client: { call: async (route: string) => void calls.push(route), subscribe: () => () => {} },
    } as never);
    const Panel = half?.panels?.['step-installed'];
    const container = document.createElement('div');
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(createElement(Panel as never, { subject: 'claude-code.installed', step: harness.host }));
    });
    expect(container.textContent).toBe('');
    expect(harness.calls).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('the permission text', () => {
  test('modeOf reads every YAML spelling, defaults an absent key to skip, and says unknown for what it cannot read', () => {
    expect(modeOf('permissionMode: auto\n')).toBe('auto');
    expect(modeOf('permissionMode: "auto" # why\n')).toBe('auto');
    expect(modeOf("'permissionMode': 'auto'\n")).toBe('auto');
    expect(modeOf('{permissionMode: auto}\n')).toBe('auto');
    expect(modeOf('permissionMode: >-\n  auto\n')).toBe('auto');
    expect(modeOf('')).toBe('skip');
    expect(modeOf('# only a comment\n')).toBe('skip');
    expect(modeOf('binary: /x\n')).toBe('skip');
    expect(modeOf('permissionMode: yolo\n')).toBeNull();
    expect(modeOf('permissionMode: [auto\n')).toBeNull();
    expect(modeOf('- auto\n')).toBeNull();
  });
  test('withMode replaces in place or appends, and touches nothing else', () => {
    expect(withMode('', 'auto')).toBe('permissionMode: auto\n');
    expect(withMode('binary: /x', 'auto')).toBe('binary: /x\npermissionMode: auto\n');
    expect(withMode('permissionMode: skip\nbinary: /x\n', 'auto')).toBe('permissionMode: auto\nbinary: /x\n');
    expect(withMode('permissionMode: skip # keep\n', 'auto')).toBe('permissionMode: auto # keep\n');
  });
  test('withMode refuses a text it cannot edit instead of guessing', () => {
    expect(() => withMode('permissionMode: [auto\n', 'auto')).toThrow();
    expect(() => withMode('permissionMode: auto\npermissionMode: skip\n', 'auto')).toThrow();
  });
});

describe('installed: the press is bound to the plan on the screen', () => {
  const REFUSAL =
    'the install command for Codex is not the one that was shown (it is now: brew install --cask codex); nothing was run. Look at it, then press Install again';
  const scanWith = (command: string) => ({
    ...SCAN_MISSING,
    tools: [{ harness: 'codex', label: 'Codex', installed: false, install: { kind: 'runnable', command } }],
  });

  test('a refusal because the plan changed shows the new command for a fresh press, and installs nothing', async () => {
    const harness = stepHarness();
    let command = 'npm install -g @openai/codex';
    const { container, calls } = await mount('installed', harness, route => {
      if (route === 'GET /v1/codex/update') return ABSENT_VIEW;
      if (route === 'GET /v1/runtimes/setup/scan') return scanWith(command);
      // The machine gained Homebrew between the look and the press.
      command = 'brew install --cask codex';
      return new Error(REFUSAL);
    });
    expect(container.querySelector('[data-install-command]')?.textContent).toBe('npm install -g @openai/codex');
    await press(container, '[data-install-run]');
    const installs = calls.filter(call => call.route === 'POST /v1/runtimes/machine/tools/install');
    expect(installs.map(call => call.options?.body)).toEqual([
      { harnesses: ['codex'], shown: [{ harness: 'codex', command: 'npm install -g @openai/codex' }] },
    ]);
    expect(container.querySelector('[data-install-command]')?.textContent).toBe('brew install --cask codex');
    expect(container.querySelector('[data-install-note]')?.textContent).toContain('nothing was run');
    expect(harness.count('done')).toBe(0);
    // The fresh press sends the NEW command, so what runs is what is now on the screen.
    command = 'brew install --cask codex';
    await press(container, '[data-install-run]');
    const second = calls.filter(call => call.route === 'POST /v1/runtimes/machine/tools/install')[1];
    expect(second?.options?.body).toEqual({
      harnesses: ['codex'],
      shown: [{ harness: 'codex', command: 'brew install --cask codex' }],
    });
  });

  test('any other failure keeps the shown plan and says what went wrong', async () => {
    const harness = stepHarness();
    const { container } = await mount('installed', harness, route => {
      if (route === 'GET /v1/codex/update') return ABSENT_VIEW;
      if (route === 'GET /v1/runtimes/setup/scan') return scanWith('npm install -g @openai/codex');
      return new Error('an install is already running on this machine; wait for it to finish');
    });
    await press(container, '[data-install-run]');
    expect(container.querySelector('[data-install-command]')?.textContent).toBe('npm install -g @openai/codex');
    expect(container.querySelector('[data-install-note]')?.textContent).toContain('already running');
    expect(container.querySelector('[data-install-run]')).not.toBeNull();
  });
});

describe('import steps after a reload', () => {
  const IMPORT_STEPS = [
    'import-settings',
    'import-model-set',
    'import-instructions',
    'import-skills',
    'import-mcp',
    'import-run',
  ];

  test('choose, then a reload before the import: the empty memory brings the choice back, and nothing is answered by default', async () => {
    // 1. The person chooses at import-choice.
    const first = stepHarness();
    const choice = await mount('import-choice', first, () => ({}));
    await act(async () => {
      choice.container.querySelector<HTMLInputElement>('input[value="fresh"]')?.click();
    });
    expect(first.segment.importMode).toBe('fresh');
    expect(first.count('done')).toBe(0);
    // 2. A reload: the run memory is gone, the choice step is answered, and the next import step opens.
    const after = stepHarness();
    const { container } = await mount('import-settings', after, () => ({}));
    expect(container.querySelector('[data-codex-step="import-choice"]')).not.toBeNull();
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(3);
    expect(container.querySelectorAll('input[type="radio"]:checked').length).toBe(0);
    expect(after.segment.importMode).toBeUndefined();
    // Not skipped by choice, not answered by default (busy keeps Next from recording it), nothing remembered for the person.
    expect(after.decision).toBe('shown');
    expect(after.count('done')).toBe(0);
    expect(after.count('remember')).toBe(0);
    expect(after.calls.filter(call => call.kind === 'busy').at(-1)).toEqual({
      kind: 'busy',
      label: 'Choose what to bring over first',
    });
    // 3. Resume: the person chooses again, the memory is back, and the step carries on.
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="choose"]')?.click();
    });
    await act(async () => {});
    expect(after.segment.importMode).toBe('choose');
    expect(after.calls.filter(call => call.kind === 'busy').at(-1)).toEqual({ kind: 'busy', label: null });
    expect(container.querySelector('[data-codex-step="import-choice"]')).toBeNull();
    expect(after.count('done')).toBe(0);
    // The step carries on into its own body (the settings page) and is not skipped by the missing choice.
    expect(container.querySelector('[data-codex-step="import-settings"]')).not.toBeNull();
    expect(after.skippedWhy).toBeUndefined();
  });

  for (const id of IMPORT_STEPS) {
    test(`${id} does not run or skip itself while the choice is missing`, async () => {
      const harness = stepHarness();
      const { container } = await mount(id, harness, () => ({}));
      expect(container.querySelector('[data-codex-step="import-choice"]')).not.toBeNull();
      expect(harness.skippedWhy).toBeUndefined();
      expect(harness.count('done')).toBe(0);
    });
  }

  test('with the choice remembered, an import step goes straight to its own body', async () => {
    const harness = stepHarness({ segment: { importMode: 'everything' } });
    const { container } = await mount('import-mcp', harness, () => ({}));
    expect(container.querySelector('[data-codex-step="import-choice"]')).toBeNull();
    expect(harness.count('skip')).toBe(0);
    expect(harness.decision).toBe('passed-over');
  });

  test('conversations is asked in both modes, so it does not wait for the choice (it reads its answer back from the file)', async () => {
    const harness = stepHarness();
    const { container } = await mount('conversations', harness, () => ({}));
    expect(container.querySelector('[data-codex-step="import-choice"]')).toBeNull();
    expect(harness.decision).toBe('shown');
  });
});

describe('no step is recorded as done without its page', () => {
  const ALL = (manifest.onboarding ?? []).map(step => step.id);

  for (const id of ALL) {
    test(`${id}: mounting it under the host never calls done (a skip or a page decides, not the plumbing)`, async () => {
      const harness = stepHarness();
      await mount(id, harness, route =>
        route === 'GET /v1/codex/update'
          ? ABSENT_VIEW
          : route === 'GET /v1/runtimes/setup/scan'
            ? SCAN_MISSING
            : route === 'GET /v1/logins'
              ? { format: 1, machine: 'fixture', logins: [] }
              : { path: 'harness-codex.yaml', exists: true, text: '', etag: 'e1' },
      );
      expect(harness.count('done')).toBe(0);
      expect(harness.decision).not.toBe('undecided');
    });
  }

  test('with everything chosen and Codex missing, no import page skips itself (a skip outlives a change of mind), so the choice follows the person', async () => {
    const shown: string[] = [];
    for (const id of ALL) {
      const harness = stepHarness({ segment: { importMode: 'everything' } });
      await mount(id, harness, route =>
        route === 'GET /v1/codex/update'
          ? ABSENT_VIEW
          : route === 'GET /v1/runtimes/setup/scan'
            ? SCAN_MISSING
            : route === 'GET /v1/logins'
              ? { format: 1, machine: 'fixture', logins: [] }
              : { path: 'harness-codex.yaml', exists: true, text: '', etag: 'e1' },
      );
      if (harness.decision === 'shown') shown.push(id);
    }
    // The five kind pages are passed over by the choice (notNeeded); the run page (Codex missing) is the one that skips.
    expect(shown).toEqual(['installed', 'sign-in', 'import-choice', 'conversations', 'permission']);
  });
});
