/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import app from '../../app/index.ts';
import manifest from '../../manifest.ts';
import { ABSENT_VIEW } from '../../contract/testing/index.ts';
import type { HarnessCliView } from '../../contract/index.ts';
import { modeOf, withMode } from '../../app/features/onboarding/onboarding-api.ts';
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
    expect(install?.options?.body).toEqual({ harnesses: ['codex'] });
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
  const codexLogin = (word: 'ready' | 'needs_sign_in') =>
    sampleLogin('codex-main', {
      harness: 'codex',
      harnesses: ['codex'],
      status: {
        word,
        label: word === 'ready' ? 'Ready' : 'Sign in',
        reason: word === 'ready' ? 'access_current' : 'not_signed_in',
        explanation: 'fixture',
        lastCheckInconclusive: false,
      },
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

  test('a choice is remembered and answered; a returning page opens on the earlier choice', async () => {
    const harness = stepHarness();
    const { container } = await mount('import-choice', harness, () => ({}));
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="fresh"]')?.click();
    });
    expect(harness.segment.importMode).toBe('fresh');
    expect(harness.count('done')).toBe(1);
    const again = stepHarness({ segment: { importMode: 'choose' } });
    const second = await mount('import-choice', again, () => ({}));
    expect(second.container.querySelector<HTMLInputElement>('input[value="choose"]')?.checked).toBe(true);
  });
});

describe('permission', () => {
  const file = (text: string) => ({ path: 'harness-codex.yaml', exists: true, text, etag: 'e1' });

  test('opens on the config value (skip when unset), says what skip allows and names the real flag', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, () => file(''));
    expect(container.querySelector<HTMLInputElement>('input[value="skip"]')?.checked).toBe(true);
    expect(container.textContent).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(container.textContent).toContain('without asking you, including deleting files');
  });

  test('choosing Auto writes only permissionMode, every other line kept', async () => {
    const harness = stepHarness();
    const text = 'binary: /opt/codex # mine\nsearchPaths:\n  - ~/bin\npermissionMode: skip\n';
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'applied' } : file(text),
    );
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="auto"]')?.click();
    });
    await act(async () => {});
    const put = calls.find(call => call.route === 'PUT /v1/config/file');
    expect(put?.options?.body).toEqual({
      path: 'harness-codex.yaml',
      text: 'binary: /opt/codex # mine\nsearchPaths:\n  - ~/bin\npermissionMode: auto\n',
      etag: 'e1',
    });
    expect(harness.count('done')).toBe(1);
  });

  test('a change the daemon holds is said, not shown as saved', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'pending' } : file('permissionMode: auto\n'),
    );
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="skip"]')?.click();
    });
    await act(async () => {});
    expect(container.querySelector('[data-permission-note]')?.textContent).toContain('waiting for your confirmation');
    expect(harness.count('done')).toBe(0);
  });
});

describe('the panel', () => {
  test('a declared step with no page yet skips itself at once, so it never hangs the flow', async () => {
    const harness = stepHarness();
    await mount('import-skills', harness, () => ({}));
    expect(harness.decision).toBe('skipped');
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
  test('modeOf reads the line, defaults to skip, and ignores nonsense', () => {
    expect(modeOf('permissionMode: auto\n')).toBe('auto');
    expect(modeOf('permissionMode: "auto" # why\n')).toBe('auto');
    expect(modeOf('')).toBe('skip');
    expect(modeOf('permissionMode: yolo\n')).toBe('skip');
  });
  test('withMode replaces in place or appends, and touches nothing else', () => {
    expect(withMode('', 'auto')).toBe('permissionMode: auto\n');
    expect(withMode('binary: /x', 'auto')).toBe('binary: /x\npermissionMode: auto\n');
    expect(withMode('permissionMode: skip\nbinary: /x\n', 'auto')).toBe('permissionMode: auto\nbinary: /x\n');
  });
});
