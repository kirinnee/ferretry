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
import { signInPanelFor } from '../../app/features/onboarding/sign-in-page.tsx';
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
  test('the Codex segment is twelve daemon steps, orders 40 to 51, in the group "Codex"', () => {
    const steps: readonly { id: string; order: number; group?: string; side?: string }[] = manifest.onboarding ?? [];
    expect(steps.map(step => step.order)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
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
      'ready',
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
    ).toEqual(['Install Codex to continue', 'Installing Codex…', null, null]);
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

  test('"Check again" asks the daemon for a fresh scan (past its lookup cache); opening the page does not', async () => {
    const harness = stepHarness();
    const manual = {
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
    const { container, calls } = await mount('installed', harness, route =>
      route === 'GET /v1/codex/update' ? ABSENT_VIEW : manual,
    );
    const scanQueries = () =>
      calls
        .filter(call => call.route === 'GET /v1/runtimes/setup/scan')
        .map(call => (call.options as { query?: unknown } | undefined)?.query);
    expect(scanQueries()).toEqual([undefined]);

    await press(container, '[data-install-recheck]');

    expect(scanQueries().at(-1)).toEqual({ fresh: '1' });
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
    expect(container.textContent).toContain('No Codex login');
  });

  test('a login that needs signing in is shown, never skipped', async () => {
    const harness = stepHarness();
    const { container } = await mount('sign-in', harness, () => list(codexLogin('needs_sign_in')));
    expect(harness.decision).toBe('shown');
    expect(container.textContent).toContain('Sign in to Codex on this machine');
    expect(container.textContent).not.toContain('No Codex login');
  });

  test('a switched-off ready login is not signed in: the step is shown, never skipped', async () => {
    const harness = stepHarness();
    const { container } = await mount('sign-in', harness, () => list(codexLogin('ready', { disabled: true })));
    expect(harness.decision).toBe('shown');
    expect(container.textContent).toContain('No Codex login');
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
    expect(container.textContent).toContain('No Codex login');
  });

  test('the add-login panel is mounted LOCKED to Codex (subject harness:codex), never the open chooser', () => {
    // Logins reads the tool from this subject (`harnessOfSubject`, proven in logins' own suite): without it the panel opens on the
    // Claude Code / Codex chooser and a provider grid (owner line 6).
    expect(signInPanelFor({ state: 'no-login' })).toEqual({ panel: 'add-login', subject: 'harness:codex' });
    const login = codexLogin('needs_sign_in', { id: 'b' });
    expect(signInPanelFor({ state: 'needs-sign-in', login })).toEqual({ panel: 'codex-login', subject: 'b' });
  });

  test('the words on the sign-in page never name Claude', async () => {
    for (const rows of [[], [codexLogin('needs_sign_in')], [codexLogin('checking')]]) {
      const harness = stepHarness();
      const { container } = await mount('sign-in', harness, () => list(...rows));
      expect(container.textContent?.toLowerCase()).not.toContain('claude');
    }
  });

  test('a login whose own harness is Claude Code is not a Codex login, even when it lists Codex among its tools', () => {
    const view = (...logins: ReturnType<typeof codexLogin>[]) => ({ format: 1 as const, machine: 'fixture', logins });
    const shared = {
      ...codexLogin('needs_sign_in', { id: 'claude-first' }),
      harness: 'claude-code' as const,
      harnesses: ['claude-code' as const, 'codex' as const],
    };
    // Not offered as the login to sign in (the Codex panel would refuse it); with nothing else, the add panel is.
    expect(signInFacts(view(shared))).toEqual({ state: 'no-login' });
    expect(signInFacts(view(shared, codexLogin('needs_sign_in', { id: 'b' })))).toMatchObject({
      state: 'needs-sign-in',
      login: { id: 'b' },
    });
    // Nor does one that is ready for Claude Code count as Codex being signed in.
    expect(signInFacts(view({ ...shared, status: { ...shared.status, word: 'ready' as const } }))).toEqual({
      state: 'no-login',
    });
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
    // The demo follows the pick (portaled into the frame in the flow; inline here, outside a frame).
    expect(container.querySelector('[data-demo="import-everything"]')).not.toBeNull();
  });

  test('a choice is remembered, not saved (the shell records Next); a returning page opens on the earlier choice', async () => {
    const harness = stepHarness();
    const { container } = await mount('import-choice', harness, () => ({}));
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="fresh"]')?.click();
    });
    expect(harness.segment.importMode).toBe('fresh');
    expect(container.querySelector('[data-demo="import-fresh"]')).not.toBeNull();
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
  /** What the shell's Next does: run the registered save, then (it, not the page) record the step. */
  const next = async (harness: StepHarness) => {
    await act(async () => {
      await harness.runCommit();
    });
  };
  const nextRefused = async (harness: StepHarness): Promise<string> => {
    let said = '';
    await act(async () => {
      await harness.runCommit().catch((cause: unknown) => {
        said = cause instanceof Error ? cause.message : String(cause);
      });
    });
    return said;
  };
  const putOf = (calls: readonly Call[]) => calls.filter(call => call.route === 'PUT /v1/config/file');
  const putText = (calls: readonly Call[]) =>
    (putOf(calls).at(0)?.options?.body as { text: string } | undefined)?.text ?? '';

  test('opens on the config value (skip when unset), says what skip allows and names the real flag', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, () => file(''));
    expect(radio(container, 'skip')?.checked).toBe(true);
    expect(container.textContent).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(container.textContent).toContain('Runs every command without asking, even deleting files.');
    // Cards stacked, and nothing to press on the page: Next is the only way to save.
    expect(container.querySelector('[data-choice-cards][data-layout="stack"]')).not.toBeNull();
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(harness.hasCommit).toBe(false);
  });

  test('the page names only Codex (no Claude anywhere), with the plain apostrophe fixed to a typographic one', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, () => file(''));
    expect(container.textContent?.toLowerCase()).not.toContain('claude');
    expect(container.textContent).toContain('Codex’s');
    expect(container.textContent).not.toContain("Codex's");
  });

  test('choosing Auto writes nothing until Next: then only permissionMode changes, every other line kept', async () => {
    const harness = stepHarness();
    const text = 'binary: /opt/codex # mine\nsearchPaths:\n  - ~/bin\npermissionMode: skip\n';
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'applied' } : file(text),
    );
    await choose(container, 'auto');
    expect(putOf(calls)).toEqual([]);
    expect(harness.hasCommit).toBe(true);
    // Moving over the cards with the arrow keys selects only, and writes nothing.
    await next(harness);
    expect(putOf(calls)).toHaveLength(1);
    expect(putOf(calls)[0]?.options?.body).toEqual({
      path: 'harness-codex.yaml',
      text: 'binary: /opt/codex # mine\nsearchPaths:\n  - ~/bin\npermissionMode: auto\n',
      etag: 'e1',
    });
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
      await next(harness);
      const written = putText(calls);
      const read = readConfigText(written);
      expect(read.ok).toBe(true);
      expect(read.ok ? (read.read.value as { permissionMode?: string }).permissionMode : undefined).toBe('skip');
      expect(written.match(/permissionMode/gu)?.length).toBe(1);
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
    await next(harness);
    expect(putText(calls)).toBe('# mine\nbinary: /opt/codex\npermissionMode: auto # keep\n');
  });

  test('a quoted-key Skip is shown as Skip, not misread as unset', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, () => file('\'permissionMode\': "skip"\n'));
    expect(radio(container, 'skip')?.checked).toBe(true);
  });

  test('a pick shows the warning and the demo at once, writes nothing, and never holds Next', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'applied' } : file('permissionMode: auto\n'),
    );
    expect(container.querySelector('[data-permission-words]')).toBeNull();
    await choose(container, 'skip');
    // The selection shows the warning (what it allows in plain words, the real flag) and nothing was written.
    expect(radio(container, 'skip')?.checked).toBe(true);
    const words = container.querySelector('[data-permission-words="skip"]')?.textContent ?? '';
    expect(words).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(words).toContain('Runs every command without asking, even deleting files.');
    expect(putOf(calls)).toEqual([]);
    // Rule 8: no page-made hold on Next (no busy label at all), no done() from the page, no page button.
    expect(harness.calls.filter(call => call.kind === 'busy')).toEqual([]);
    expect(harness.count('done')).toBe(0);
    expect(container.querySelectorAll('button').length).toBe(0);
    await next(harness);
    expect(putText(calls)).toBe('permissionMode: skip\n');
    // The shell records the step on a resolved commit; the page does not.
    expect(harness.count('done')).toBe(0);
  });

  test('going back to the saved card clears the save: Next then writes nothing', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('permission', harness, () => file('permissionMode: auto\n'));
    await choose(container, 'skip');
    expect(harness.hasCommit).toBe(true);
    await choose(container, 'auto');
    expect(harness.hasCommit).toBe(false);
    expect(container.querySelector('[data-permission-words]')).toBeNull();
    await next(harness);
    expect(putOf(calls)).toEqual([]);
  });

  test('a file with a held edit waiting (the read is pending): Next writes NOTHING and says why, every time', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'applied' } : file('permissionMode: auto\n', { state: 'pending' }),
    );
    await choose(container, 'skip');
    const words = 'A change to this file is waiting for your OK — confirm or discard it in Settings > Files first.';
    expect(await nextRefused(harness)).toBe(words);
    expect(await nextRefused(harness)).toBe(words);
    expect(putOf(calls)).toEqual([]);
    expect(harness.count('done')).toBe(0);
  });

  test('a held edit cleared in Settings after the page opened: the next Next re-reads the file and sends exactly 1 PUT', async () => {
    const harness = stepHarness();
    let held = true;
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT')
        ? { outcome: 'applied' }
        : file('permissionMode: auto\n', held ? { state: 'pending' } : {}),
    );
    await choose(container, 'skip');
    expect(await nextRefused(harness)).toContain('waiting for your OK');
    expect(putOf(calls)).toEqual([]);
    held = false;
    await next(harness);
    expect(putOf(calls)).toHaveLength(1);
  });

  test('a change the daemon holds is said, Next stays on the page, and a second Next tries again', async () => {
    const harness = stepHarness();
    const { container, calls } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? { outcome: 'pending' } : file('permissionMode: auto\n'),
    );
    await choose(container, 'skip');
    expect(await nextRefused(harness)).toContain('waiting for your confirmation');
    expect(harness.count('done')).toBe(0);
    expect(await nextRefused(harness)).toContain('waiting for your confirmation');
    expect(putOf(calls)).toHaveLength(2);
  });

  test('a refused write says the daemon’s words and keeps the pick', async () => {
    const harness = stepHarness();
    const { container } = await mount('permission', harness, route =>
      route.startsWith('PUT') ? new Error('That file changed.') : file('permissionMode: auto\n'),
    );
    await choose(container, 'skip');
    expect(await nextRefused(harness)).toBe('That file changed.');
    expect(radio(container, 'skip')?.checked).toBe(true);
    expect(harness.hasCommit).toBe(true);
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
      // Nothing is offered to pick when the mode cannot be read.
      expect(radio(container, 'skip')).toBeNull();
      expect(radio(container, 'auto')).toBeNull();
      expect(container.querySelector('[data-demo]')).toBeNull();
      expect(putOf(calls)).toEqual([]);
      expect(harness.hasCommit).toBe(false);
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

  test('a reload (the memory is empty) shows the kind page as its checklist: no chooser, nothing remembered, nothing answered', async () => {
    const harness = stepHarness();
    const { container } = await mount('import-settings', harness, () => ({}));
    expect(container.querySelector('[data-codex-step="import-choice"]')).toBeNull();
    expect(container.querySelector('[data-returned], [data-returned-continue]')).toBeNull();
    expect(container.querySelectorAll('input[type="radio"]').length).toBe(0);
    expect(harness.segment.importMode).toBeUndefined();
    expect(container.querySelector('[data-codex-step="import-settings"]')).not.toBeNull();
    // The page is shown and answered only by the footer's Next: nothing is done or skipped on its own.
    expect(harness.decision).toBe('shown');
    expect(harness.count('done')).toBe(0);
    expect(harness.skippedWhy).toBeUndefined();
    expect(harness.calls.some(call => call.kind === 'notNeeded')).toBe(false);
  });

  test('a fresh choice made in this run still passes the kind pages over, and a reload does not', async () => {
    const fresh = stepHarness({ segment: { importMode: 'fresh' } });
    await mount('import-skills', fresh, () => ({}));
    expect(fresh.decision).toBe('passed-over');
    const reloaded = stepHarness();
    await mount('import-skills', reloaded, () => ({}));
    expect(reloaded.decision).toBe('shown');
  });

  for (const id of IMPORT_STEPS) {
    test(`${id} never draws a chooser and never skips or answers itself because the choice is missing`, async () => {
      const harness = stepHarness();
      const { container } = await mount(id, harness, () => ({}));
      expect(container.querySelector('[data-codex-step="import-choice"]')).toBeNull();
      expect(harness.calls.some(call => call.kind === 'notNeeded')).toBe(false);
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
    expect(shown).toEqual(['installed', 'sign-in', 'import-choice', 'conversations', 'permission', 'ready']);
  });
});
