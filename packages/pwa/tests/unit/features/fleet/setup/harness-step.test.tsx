import { describe, expect, it } from 'bun:test';
import {
  FleetLayeredProfileCatalogSchema,
  type FleetLayeredProfileView,
  type FleetMachineView,
  type FleetSetupScan,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { useState } from 'react';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import type { MachineData } from '../../../../../src/features/fleet/runtimes/machine-data.ts';
import type { HarnessAnswers } from '../../../../../src/features/fleet/setup/harness-import-model.ts';
import {
  type HarnessReport,
  OnboardingHarnessStep,
  providerProfile,
} from '../../../../../src/features/fleet/setup/harness-step.tsx';
import type { SetupHarness } from '../../../../../src/features/fleet/setup/setup-words.ts';
import type { MachineTabProps } from '../../../../../src/features/fleet/shell/machines-surface.tsx';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { profile as profileView } from '../account-support.ts';
import { PROVIDERS } from '../credentials/environment-support.ts';
import {
  APPLY_PATH,
  type Call,
  credentials,
  credentialView,
  machineAnswer,
  machineView,
  NOTHING_INSTALLED,
  runtimes,
  runtimeView,
  STUDIO,
  scan,
  scriptedClient,
} from './setup-support.ts';

const SCAN_PATH = '/v1/fleet/setup/scan';
const RUNTIMES_PATH = '/v1/fleet/runtimes';
const CHANGES_PATH = '/v1/fleet/proposals';
const INSTALL_PATH = '/v1/fleet/machine/tools/install';
const CREDENTIALS_PATH = '/v1/fleet/credentials';
const PROFILES_PATH = '/v1/fleet/profiles';
const COMPONENTS_PATH = '/v1/fleet/components';
const PRESETS_PATH = '/v1/fleet/presets';
const SECRETS_PATH = '/v1/secrets';
const LOGIN_PATH = '/v1/fleet/login';
const FLOW_PATH = '/v1/fleet/login/flow-1';

const stagedFrom = (call: Call) => ({
  id: 'fy_fprop_abcdefghijklmnopqrstuv',
  revision: 'absent',
  change: (call.body as { change: unknown }).change,
  summary: 'A change',
  consequences: [],
  expiresAt: '2026-10-13T08:15:00.000Z',
  state: 'pending',
  preview: { kind: 'executor', executor: 'setup', description: 'A change.' },
});

const EXECUTED = { outcome: 'executed', executor: 'setup', summary: 'studio-mac is ready' };

const [CLAUDE_SCAN, CODEX_SCAN] = scan().harnesses as [FleetSetupScan['harnesses'][0], FleetSetupScan['harnesses'][0]];

const profiles = (list: readonly FleetLayeredProfileView[]) =>
  FleetLayeredProfileCatalogSchema.parse({ format: 'version-2', profiles: list });

const PROFILES = profiles([profileView({ name: 'default' })]);

const secretList = (names: readonly string[]) => ({
  v: 1,
  health: 'ready',
  secrets: names.map(name => ({ name, createdAt: '2026-10-16T08:00:00.000Z', updatedAt: '2026-10-16T08:00:00.000Z' })),
  references: [],
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  });
};

/** Waits until the screen shows what the test expects, one act per slice, for at most two seconds. */
const until = async (shown: () => boolean, what: string): Promise<void> => {
  for (let elapsed = 0; elapsed < 2_000 && !shown(); elapsed += 10)
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
  if (!shown()) throw new Error(`never shown: ${what}: ${document.body.textContent}`);
};

const clickOn = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const typeInto = async (element: Element | null, value: string, what: string): Promise<void> => {
  const input = must(element as HTMLInputElement | null, what);
  await interact(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

interface Options {
  readonly harness: SetupHarness;
  readonly online: boolean;
  readonly answers: HarnessAnswers;
}

interface Step {
  readonly view: Mounted;
  readonly q: (selector: string) => Element | null;
  readonly text: (selector?: string) => string;
  readonly answers: HarnessAnswers[];
  readonly ready: number[];
  /** Each time the step finished and asked the page to move on, with what it reports. */
  readonly finished: (HarnessReport | null)[];
  readonly rerender: (overrides: Partial<Options>) => Promise<void>;
}

function Host({
  tab,
  harness,
  initial,
  log,
  ready,
  finished,
}: {
  readonly tab: MachineTabProps;
  readonly harness: SetupHarness;
  readonly initial: HarnessAnswers;
  readonly log: HarnessAnswers[];
  readonly ready: number[];
  readonly finished: (HarnessReport | null)[];
}) {
  const [answers, setAnswers] = useState<HarnessAnswers>(initial);
  return (
    <OnboardingHarnessStep
      tab={tab}
      harness={harness}
      answers={answers}
      onAnswers={next => {
        log.push(next);
        setAnswers(next);
      }}
      onReady={() => ready.push(1)}
      onFinished={report => finished.push(report)}
      pollMs={5}
    />
  );
}

const start = async (client: FleetClient, options: Partial<Options> = {}): Promise<Step> => {
  const log: HarnessAnswers[] = [];
  const ready: number[] = [];
  const finished: (HarnessReport | null)[] = [];
  const createClient = async () => client;
  const machine: FleetMachineView = machineView();
  const element = (current: Options) => (
    <Host
      tab={{
        connection: STUDIO,
        machineName: 'studio-mac',
        machine,
        online: current.online,
        checking: false,
        onRetry: () => undefined,
        createClient,
      }}
      harness={current.harness}
      initial={current.answers}
      log={log}
      ready={ready}
      finished={finished}
    />
  );
  let current: Options = { harness: 'claude', online: true, answers: {}, ...options };
  const view = await mount(element(current));
  await settle();
  const q = (selector: string) => view.container.querySelector(selector);
  return {
    view,
    q,
    text: (selector?: string) => (selector === undefined ? view.container.textContent : q(selector)?.textContent) ?? '',
    answers: log,
    ready,
    finished,
    rerender: async overrides => {
      current = { ...current, ...overrides };
      await view.render(element(current));
      await settle();
    },
  };
};

/** A daemon with every read this step makes: the scan, the runtimes, the logins, the profiles, the providers. */
const daemon = (routes: Record<string, unknown> = {}, calls: Call[] = []): FleetClient =>
  scriptedClient(
    {
      '/v1/fleet/machine': machineAnswer(),
      [SCAN_PATH]: scan(),
      [RUNTIMES_PATH]: runtimes([]),
      [CREDENTIALS_PATH]: credentials([]),
      [PROFILES_PATH]: PROFILES,
      [COMPONENTS_PATH]: new Error('no components'),
      [PRESETS_PATH]: PROVIDERS,
      [SECRETS_PATH]: (call: Call) =>
        call.body === undefined
          ? secretList([])
          : {
              name: (call.body as { name: string }).name,
              createdAt: '2026-10-16T08:00:00.000Z',
              updatedAt: '2026-10-16T08:00:00.000Z',
            },
      [CHANGES_PATH]: stagedFrom,
      [APPLY_PATH]: EXECUTED,
      ...routes,
    },
    calls,
  );

const changeBodies = (calls: readonly Call[]) =>
  calls.filter(call => call.path === CHANGES_PATH).map(call => (call.body as { change: unknown }).change);

/** Opens the runtime name field, which is a line of text until “Change” is pressed. */
const rename = async (s: Step): Promise<void> => {
  await clickOn(s.q('[data-harness-name-change]'), 'change the runtime name');
};

const submit = (s: Step) => s.q('[data-change-submit]') as HTMLButtonElement | null;

describe('OnboardingHarnessStep: reading the machine', () => {
  it('says it is looking until the scan answers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const inner = daemon();
    const client: FleetClient = {
      request: async (path, schema, init) => {
        if (path === SCAN_PATH) await gate;
        return await inner.request(path, schema, init);
      },
    };
    const s = await start(client);
    try {
      expect(s.text('[data-harness-reading]')).toBe('Looking for Claude Code on studio-mac…');
      await interact(() => release());
      await settle();
      expect(s.q('[data-harness-reading]')).toBeNull();
      expect(s.q('[data-onboarding-step-body="claude"]')).not.toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('a scan that fails says so and Try again reads it again', async () => {
    let up = false;
    const s = await start(daemon({ [SCAN_PATH]: () => (up ? scan() : new Error('unreachable')) }));
    try {
      expect(s.text('[data-setup-note="scan-failed"]')).toContain('Couldn’t look at studio-mac');
      expect(s.q('[data-setup-section="found"]')).toBeNull();
      up = true;
      await clickOn(s.q('[data-scan-retry]'), 'try again');
      expect(s.q('[data-setup-note="scan-failed"]')).toBeNull();
      expect(s.q('[data-setup-section="found"]')).not.toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('a machine that is asleep pauses the step, and waking it brings the step back', async () => {
    const s = await start(daemon(), { online: false });
    try {
      expect(s.text('[data-setup-note="harness-paused"]')).toContain('studio-mac is asleep or offline');
      expect(s.text('[data-setup-note="harness-paused"]')).toContain('Your place is kept.');
      expect(s.q('[data-change-submit]')).toBeNull();
      await s.rerender({ online: true });
      expect(s.q('[data-setup-note="harness-paused"]')).toBeNull();
      expect(s.q('[data-setup-section="found"]')).not.toBeNull();
    } finally {
      await s.view.unmount();
    }
  });
});

describe('OnboardingHarnessStep: Claude Code on one screen', () => {
  it('shows what was found as ticked lines, the runtime name as text, and one Import button', async () => {
    const s = await start(daemon());
    try {
      expect(s.q('[data-setup-row="tool-claude"]')).toBeNull();
      const lines = [...s.view.container.querySelectorAll('[data-found-line]')].map(line => line.textContent);
      expect(lines).toContain('Signed in as you@example.com');
      expect(lines.some(line => line?.includes('MCP server'))).toBe(true);
      expect(lines.some(line => line?.includes('skill'))).toBe(true);
      expect(s.q('[data-setup-section="found"]')?.querySelector('h4')?.textContent).toBe('Found on studio-mac');
      // The rest sits behind a closed Details, with the secret-value badge.
      const details = must(s.q('[data-setup-disclosure="found-details"]'), 'the details');
      expect(details.hasAttribute('open')).toBe(false);
      expect(details.textContent).toContain('CLAUDE.md');
      expect(details.textContent).toContain('2 secret values · go to the secret store, never shown');
      expect(details.textContent).toContain('Command not found: uvx');
      expect(s.q('[data-harness-sign-in]')).toBeNull();
      expect(s.q('[data-setup-note="problem"]')).toBeNull();
      expect(s.q('[data-harness-has]')).toBeNull();
      // The name is text with Change; the input and its validation come with Change.
      expect(s.text('[data-harness-runtime-line]')).toContain('claude-default');
      expect(s.q('[data-harness-name]')).toBeNull();
      await rename(s);
      expect((s.q('[data-harness-name="claude"]') as HTMLInputElement).value).toBe('claude-default');
      expect(s.q('[data-harness-name="claude"]')?.getAttribute('aria-invalid')).toBe('false');
      expect(s.text('[data-setup-section="runtime"]')).toContain('Letters, digits and dashes.');
      expect(s.q('[data-harness-add-another]')).toBeNull();
      expect(s.q('[data-setup-choice]')).toBeNull();
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
      expect(s.view.container.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
      expect(s.text('[data-onboarding-step-body]')).toContain(
        'Ferretry and your own claude share this login: signing out in one signs out both.',
      );
      expect(s.ready).toHaveLength(0);
      expect(s.finished).toHaveLength(0);
    } finally {
      await s.view.unmount();
    }
  });

  it('one Import sends ONE setup.import for this CLI and shows the runtime ready in place', async () => {
    const calls: Call[] = [];
    let created = false;
    const s = await start(
      daemon(
        {
          [RUNTIMES_PATH]: () => runtimes(created ? [runtimeView('claude-default')] : []),
          [APPLY_PATH]: () => {
            created = true;
            return EXECUTED;
          },
        },
        calls,
      ),
    );
    try {
      await clickOn(s.q('[data-change-submit]'), 'import');
      expect(changeBodies(calls)).toEqual([
        { kind: 'setup.import', include: ['claude'], names: { claude: 'claude-default' } },
      ]);
      const imported = s.q('[data-harness-imported="claude"]');
      expect(imported?.textContent).toContain('claude-default is ready');
      expect(imported?.textContent).toContain('Claude Code · default profile');
      expect(s.text('[data-setup-note="import-ready"]')).toContain('claude-default is ready');
      // ONE summary line; the rest sits behind a closed Details.
      expect(s.text('[data-setup-note="import-ready"] > p')).toBe('Imported 1 login, 2 skills, 3 MCP servers');
      expect(s.q('[data-setup-disclosure="import-details"]')?.hasAttribute('open')).toBe(false);
      // The form gives way to the result; the answers are cleared; the step is set.
      expect(s.q('[data-setup-section="runtime"]')).toBeNull();
      expect(s.q('[data-harness-name]')).toBeNull();
      expect(s.answers.at(-1)).toEqual({});
      expect(s.ready.length).toBeGreaterThan(0);
      expect(s.q('[data-harness-sign-in-later]')).toBeNull();
      expect(s.text('[data-setup-note="import-note"]')).toBe(
        'notes needs uvx: install uv on studio-mac and it starts working.',
      );
      // Success hands the page on, once, with what it did.
      expect(s.finished).toEqual([
        {
          harness: 'claude',
          runtime: 'claude-default',
          summary: 'Imported 1 login, 2 skills, 3 MCP servers',
          conversations: null,
          conversationsFailed: false,
          signIn: [],
        },
      ]);
    } finally {
      await s.view.unmount();
    }
  });

  it('says Imported when the machine lists no runtime afterwards', async () => {
    const s = await start(daemon());
    try {
      await clickOn(s.q('[data-change-submit]'), 'import');
      expect(s.text('[data-setup-note="import-ready"]')).toContain('Imported');
      expect(s.text('[data-harness-imported]')).toContain('Your Claude Code setup is in Ferretry.');
      expect(s.ready).toHaveLength(0);
      expect(s.finished).toHaveLength(1);
    } finally {
      await s.view.unmount();
    }
  });

  it('links a runtime that still needs a sign-in, one link per runtime', async () => {
    let created = false;
    const s = await start(
      daemon(
        {
          [SCAN_PATH]: scan({
            harnesses: [{ ...CLAUDE_SCAN, account: { state: 'not-signed-in' } }, CODEX_SCAN],
          }),
          [RUNTIMES_PATH]: () =>
            runtimes(
              created
                ? [
                    runtimeView('claude-default', {
                      credential: { id: 'claude-host', store: 'host', status: 'needs_sign_in' },
                    }),
                    runtimeView('claude-work', {
                      profile: 'work',
                      credential: { id: 'claude-work', store: 'ferretry', status: 'needs_sign_in' },
                    }),
                    runtimeView('claude-ok'),
                  ]
                : [],
            ),
          [APPLY_PATH]: () => {
            created = true;
            return EXECUTED;
          },
        },
        [],
      ),
    );
    try {
      expect(s.text('[data-found-line="attention"]')).toContain('Not signed in — sign in now, or after importing');
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(s.text('[data-setup-note="import-ready"]')).toContain(
        'claude-default, claude-work and claude-ok are ready',
      );
      expect(s.text('[data-setup-note="import-ready"]')).toContain(
        'Claude Code · default profile, work profile, default profile',
      );
      expect(s.text('[data-setup-note="sign-in-later"]')).toContain('Sign in before you launch');
      const hrefs = [...s.view.container.querySelectorAll('[data-harness-sign-in-later]')].map(link => [
        link.textContent,
        link.getAttribute('href'),
      ]);
      expect(hrefs).toEqual([
        ['Sign in for claude-default', '#machines/studio-mac/sign-ins/claude-host'],
        ['Sign in for claude-work', '#machines/studio-mac/sign-ins/claude-work'],
      ]);
      expect(s.finished[0]?.signIn).toEqual([
        { runtime: 'claude-default', credential: 'claude-host' },
        { runtime: 'claude-work', credential: 'claude-work' },
      ]);
    } finally {
      await s.view.unmount();
    }
  });

  it('a change the daemon refuses shows its sentence, stays on the page and does not move on', async () => {
    const sentence = 'Import is not available while a migration is running.';
    const calls: Call[] = [];
    const s = await start(daemon({ [CHANGES_PATH]: new FyHttpError(sentence, 409, 'fleet_change_refused') }, calls));
    try {
      await clickOn(s.q('[data-change-submit]'), 'import');
      expect(s.text('[data-change-refusal]')).toBe(sentence);
      expect(s.q('[data-harness-imported]')).toBeNull();
      expect(s.q('[data-harness-runtime-line]')).not.toBeNull();
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
      expect(s.answers).toHaveLength(0);
      expect(s.finished).toHaveLength(0);
      expect(calls.some(call => call.path === APPLY_PATH)).toBe(false);
    } finally {
      await s.view.unmount();
    }
  });
});

describe('OnboardingHarnessStep: the runtime name', () => {
  it('keeps what is typed with the rail’s answers, trimmed, and sends it', async () => {
    const calls: Call[] = [];
    const s = await start(daemon({}, calls));
    try {
      await rename(s);
      await typeInto(s.q('[data-harness-name="claude"]'), ' claude-work ', 'name');
      expect(s.answers.at(-1)).toEqual({ name: 'claude-work' });
      expect((s.q('[data-harness-name="claude"]') as HTMLInputElement).value).toBe('claude-work');
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(changeBodies(calls)).toEqual([
        { kind: 'setup.import', include: ['claude'], names: { claude: 'claude-work' } },
      ]);
    } finally {
      await s.view.unmount();
    }
  });

  it('starts from the answers kept from an earlier visit', async () => {
    const s = await start(daemon(), { answers: { name: 'kept-name' } });
    try {
      expect(s.text('[data-harness-runtime-line]')).toContain('kept-name');
      await rename(s);
      expect((s.q('[data-harness-name="claude"]') as HTMLInputElement).value).toBe('kept-name');
    } finally {
      await s.view.unmount();
    }
  });

  it('a clash with a runtime on the machine says why, offers the next free name and holds the button', async () => {
    const s = await start(daemon({ [RUNTIMES_PATH]: runtimes([runtimeView('claude-default')]) }), {
      answers: { addAnother: true, name: 'claude-default' },
    });
    try {
      expect(s.q('[data-harness-name="claude"]')?.getAttribute('aria-invalid')).toBe('true');
      expect(s.text('[data-harness-name-problem="claude"]')).toContain(
        'claude-default is already a runtime on studio-mac.',
      );
      expect(s.text('[data-harness-name-suggestion="claude"]')).toBe('Use claude-default-2');
      expect(submit(s)?.disabled).toBe(true);
      await clickOn(s.q('[data-harness-name-suggestion="claude"]'), 'use suggestion');
      expect(s.text('[data-harness-runtime-line]')).toContain('claude-default-2');
      expect(s.q('[data-harness-name-problem]')).toBeNull();
      expect(submit(s)?.disabled).toBe(false);
      expect(s.text('[data-harness-has="claude"]')).toBe(
        'claude-default already runs Claude Code on studio-mac. Importing again adds only what is new.',
      );
    } finally {
      await s.view.unmount();
    }
  });

  it('a bad name offers a slug, and an empty one only says to give a name', async () => {
    const s = await start(daemon());
    try {
      await rename(s);
      await typeInto(s.q('[data-harness-name="claude"]'), 'My Runtime!', 'bad name');
      expect(s.text('[data-harness-name-problem="claude"]')).toContain('Use only letters, digits and dashes.');
      expect(s.text('[data-harness-name-suggestion="claude"]')).toBe('Use my-runtime');
      expect(submit(s)?.disabled).toBe(true);
      await typeInto(s.q('[data-harness-name="claude"]'), '   ', 'empty name');
      expect(s.text('[data-harness-name-problem="claude"]')).toBe('Give the runtime a name. ');
      expect(s.q('[data-harness-name-suggestion]')).toBeNull();
      expect(submit(s)?.disabled).toBe(true);
    } finally {
      await s.view.unmount();
    }
  });

  it('says every runtime already on the CLI, in the plural', async () => {
    const s = await start(
      daemon({ [RUNTIMES_PATH]: runtimes([runtimeView('claude-default'), runtimeView('claude-work')]) }),
    );
    try {
      expect(s.text('[data-harness-has="claude"]')).toBe(
        'claude-default and claude-work already run Claude Code on studio-mac. Importing again adds only what is new.',
      );
      expect(s.ready.length).toBeGreaterThan(0);
    } finally {
      await s.view.unmount();
    }
  });
});

describe('OnboardingHarnessStep: a duplicate and the updates', () => {
  const duplicated = scan({
    runtimes: [{ harness: 'codex', name: 'codex-default', profile: 'default' }],
    duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
  });

  it('a duplicate makes no runtime until “also add another” is ticked, then the change asks for duplicates (E15)', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon({ [SCAN_PATH]: duplicated, [RUNTIMES_PATH]: runtimes([runtimeView('claude-default')]) }, calls),
    );
    try {
      const another = must(s.q('[data-harness-add-another]') as HTMLInputElement | null, 'add another');
      expect(another.checked).toBe(false);
      expect(s.q('[data-harness-runtime-line]')).toBeNull();
      expect(s.text('[data-onboarding-primary]')).toBe('Continue');
      await clickOn(another, 'add another');
      expect(s.answers.at(-1)).toEqual({ addAnother: true });
      expect(s.text('[data-harness-runtime-line]')).toContain('claude-default-2');
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(changeBodies(calls)).toEqual([
        { kind: 'setup.import', include: ['claude'], names: { claude: 'claude-default-2' }, addDuplicates: true },
      ]);
    } finally {
      await s.view.unmount();
    }
  });

  it('an unticked duplicate imports without a runtime when the CLI has no runtime yet', async () => {
    const calls: Call[] = [];
    const s = await start(daemon({ [SCAN_PATH]: duplicated }, calls));
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(changeBodies(calls)).toEqual([{ kind: 'setup.import', include: ['claude'] }]);
    } finally {
      await s.view.unmount();
    }
  });

  it('a step with nothing to create is a plain Import', async () => {
    const calls: Call[] = [];
    const s = await start(daemon({ [SCAN_PATH]: scan({ runtimes: [], duplicates: [] }) }, calls));
    try {
      expect(s.q('[data-harness-name]')).toBeNull();
      expect(s.q('[data-harness-add-another]')).toBeNull();
      expect(s.q('[data-harness-runtime-line]')).toBeNull();
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(changeBodies(calls)).toEqual([{ kind: 'setup.import', include: ['claude'] }]);
    } finally {
      await s.view.unmount();
    }
  });

  it('What changed is ONE line with a deduped list behind it, one tick takes them all (O6)', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon(
        {
          [SCAN_PATH]: scan({
            updates: [
              { reference: 'mcp/slack', sources: ['/home/you/.claude.json'] },
              {
                reference: 'skills/skills',
                sources: ['/h/.claude/skills/agents-sdk', '/h/.codex/skills/agents-sdk', '/h/.claude/skills/pr-review'],
              },
            ],
          }),
        },
        calls,
      ),
    );
    try {
      expect(s.text('[data-harness-changed-summary]')).toBe(
        'Slack MCP server and 2 skills changed since the last import.',
      );
      // Not a set of choices: no radio circles, one tick.
      expect(s.q('[data-setup-choice]')).toBeNull();
      const lists = [...s.view.container.querySelectorAll('[data-harness-changed-line]')].map(line => line.textContent);
      expect(lists).toEqual(['MCP server: slack', 'Skills: agents-sdk, pr-review']);
      expect(s.q('[data-setup-disclosure="changed-list"]')?.hasAttribute('open')).toBe(false);
      const tick = s.q('[data-harness-update-all]') as HTMLInputElement;
      expect(tick.checked).toBe(false);
      await clickOn(tick, 'tick them all');
      expect(s.answers.at(-1)).toEqual({ accepted: ['mcp/slack', 'skills/skills'] });
      await clickOn(s.q('[data-harness-update-all]'), 'untick');
      expect(s.answers.at(-1)).toEqual({ accepted: [] });
      await clickOn(s.q('[data-harness-update-all]'), 'tick again');
      await clickOn(s.q('[data-change-submit]'), 'import');
      expect(changeBodies(calls)).toEqual([
        {
          kind: 'setup.import',
          include: ['claude'],
          names: { claude: 'claude-default' },
          acceptedUpdates: ['mcp/slack', 'skills/skills'],
        },
      ]);
    } finally {
      await s.view.unmount();
    }
  });

  it('says "it" for a single change', async () => {
    const s = await start(
      daemon({ [SCAN_PATH]: scan({ updates: [{ reference: 'settings/claude-settings', sources: ['/s.json'] }] }) }),
    );
    try {
      expect(s.text('[data-harness-changed-summary]')).toBe('Settings changed since the last import.');
      expect(s.text('[data-harness-changed]')).toContain('Update it too');
    } finally {
      await s.view.unmount();
    }
  });
});

describe('OnboardingHarnessStep: Codex', () => {
  it('offers to sign in later, shows a problem and the Same-as-CLAUDE.md badge once Claude has a runtime (E4, E9)', async () => {
    const withProblems = scan({
      harnesses: [CLAUDE_SCAN, { ...CODEX_SCAN, problems: ['Couldn’t read config.toml: it is not valid TOML.'] }],
    });
    const s = await start(
      daemon({ [SCAN_PATH]: withProblems, [RUNTIMES_PATH]: runtimes([runtimeView('claude-default')]) }),
      { harness: 'codex' },
    );
    try {
      const codex = s.text('[data-onboarding-step-body="codex"]');
      expect(codex).toContain('Same as your CLAUDE.md · one shared copy');
      expect(codex).not.toContain('share this login');
      expect(s.text('[data-setup-note="problem"]')).toBe('Couldn’t read config.toml: it is not valid TOML.');
      expect(s.text('[data-found-line="attention"]')).toContain('Not signed in — sign in now, or after importing');
      expect(s.text('[data-harness-sign-in]')).toBe('Sign in now');
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
      // Claude's runtime does not make Codex's step set.
      expect(s.q('[data-harness-has]')).toBeNull();
      expect(s.ready).toHaveLength(0);
    } finally {
      await s.view.unmount();
    }
  });

  it('says nothing about the match when Claude Code has no runtime yet', async () => {
    const s = await start(daemon(), { harness: 'codex' });
    try {
      expect(s.text('[data-onboarding-step-body="codex"]')).not.toContain('Same as your CLAUDE.md');
    } finally {
      await s.view.unmount();
    }
  });
});

describe('OnboardingHarnessStep: not installed', () => {
  it('offers the install as the page’s one primary, with no Skip of its own; a failed install offers Retry', async () => {
    const calls: Call[] = [];
    let attempts = 0;
    const s = await start(
      daemon(
        {
          [SCAN_PATH]: NOTHING_INSTALLED,
          [INSTALL_PATH]: () => {
            attempts += 1;
            return {
              outcomes: [
                {
                  harness: 'claude',
                  outcome: 'failed',
                  cause: 'needs-admin',
                  reason: 'npm needs administrator rights on studio-mac.',
                  manualCommand: 'sudo npm install -g @anthropic-ai/claude-code',
                },
              ],
            };
          },
        },
        calls,
      ),
    );
    try {
      expect(s.q('[data-setup-row="tool-claude"]')).toBeNull();
      expect(s.text('[data-tool-install]')).toContain('npm install -g @anthropic-ai/claude-code');
      expect(s.q('[data-setup-section="found"]')).toBeNull();
      expect(s.q('[data-harness-provider]')).toBeNull();
      expect(s.q('[data-install-skip]')).toBeNull();
      expect(s.text('[data-onboarding-primary]')).toBe('Install Claude Code');
      expect(s.view.container.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
      await clickOn(s.q('[data-onboarding-primary]'), 'install');
      expect(s.text('[data-setup-note="install-failed"]')).toContain('npm needs administrator rights on studio-mac.');
      expect(s.q('[data-install-skip]')).toBeNull();
      expect(s.text('[data-onboarding-primary]')).toBe('Retry');
      expect(s.view.container.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
      await clickOn(s.q('[data-onboarding-primary]'), 'retry');
      expect(attempts).toBe(2);
      expect(s.finished).toHaveLength(0);
    } finally {
      await s.view.unmount();
    }
  });

  it('a tool the scan does not list is not installed, and has nothing to install', async () => {
    const s = await start(daemon({ [SCAN_PATH]: scan({ tools: [], harnesses: [] }) }));
    try {
      expect(s.q('[data-tool-install]')).toBeNull();
      expect(s.q('[data-onboarding-primary]')).toBeNull();
      expect(s.text('[data-setup-note="not-installed"]')).toBe(
        'Claude Code isn’t installed on studio-mac. Skip this step and install it later in Settings › Machine.',
      );
    } finally {
      await s.view.unmount();
    }
  });

  it('installing reads the machine again and the found setup takes its place', async () => {
    const calls: Call[] = [];
    let installed = false;
    const afterInstall = scan({
      tools: [
        { harness: 'claude', label: 'Claude Code', installed: true },
        NOTHING_INSTALLED.tools[1] as FleetSetupScan['tools'][0],
      ],
      harnesses: [CLAUDE_SCAN, { ...CODEX_SCAN, installed: false }],
    });
    const s = await start(
      daemon(
        {
          [SCAN_PATH]: () => (installed ? afterInstall : NOTHING_INSTALLED),
          [INSTALL_PATH]: () => {
            installed = true;
            return {
              outcomes: [
                { harness: 'claude', outcome: 'installed', command: 'npm install -g @anthropic-ai/claude-code' },
              ],
            };
          },
        },
        calls,
      ),
    );
    try {
      expect(s.text('[data-onboarding-primary]')).toBe('Install Claude Code');
      await clickOn(s.q('[data-onboarding-primary]'), 'install');
      expect(calls.find(call => call.path === INSTALL_PATH)?.body).toEqual({ harnesses: ['claude'] });
      expect(calls.filter(call => call.path === SCAN_PATH)).toHaveLength(2);
      expect(s.q('[data-tool-install]')).toBeNull();
      expect(s.q('[data-setup-section="found"]')).not.toBeNull();
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
      expect(s.q('[data-harness-provider]')).not.toBeNull();
    } finally {
      await s.view.unmount();
    }
  });
});

const codexFlow = (state: 'awaiting-approval' | 'complete') => ({
  harness: 'codex',
  flowId: 'flow-1',
  credentialId: 'codex-you',
  identity: 'codex:you',
  startedAt: '2026-10-13T08:00:00.000Z',
  expiresAt: '2026-10-13T08:10:00.000Z',
  state,
  ...(state === 'awaiting-approval'
    ? { verificationUrl: 'https://auth.openai.com/codex/device', userCode: '0IER-FFQW6' }
    : {}),
});

const ownCodexLogin = credentialView('codex-you', { harness: 'codex', store: 'host', sharedWithTerminal: true });

describe('OnboardingHarnessStep: Sign in now', () => {
  it('makes the own login in place, signs it in, and returns to the step with it signed in', async () => {
    const calls: Call[] = [];
    let added = false;
    let signedIn = false;
    // The machine says the sign-in still waits for approval until the test has seen that screen.
    let approvedOnMachine = false;
    const signedInScan = scan({
      harnesses: [CLAUDE_SCAN, { ...CODEX_SCAN, account: { state: 'signed-in', email: 'you@example.com' } }],
    });
    const s = await start(
      daemon(
        {
          [SCAN_PATH]: () => (signedIn ? signedInScan : scan()),
          [CREDENTIALS_PATH]: () => credentials(added ? [ownCodexLogin] : []),
          [APPLY_PATH]: () => {
            added = true;
            return EXECUTED;
          },
          [LOGIN_PATH]: codexFlow('awaiting-approval'),
          [FLOW_PATH]: () => {
            if (!approvedOnMachine) return codexFlow('awaiting-approval');
            signedIn = true;
            return codexFlow('complete');
          },
        },
        calls,
      ),
      { harness: 'codex' },
    );
    try {
      await clickOn(s.q('[data-harness-sign-in]'), 'sign in now');
      // The sign-in replaces the Sign in now note until it is done or put off.
      expect(s.q('[data-first-run-sign-in="codex"]')).not.toBeNull();
      expect(s.q('[data-harness-sign-in]')).toBeNull();
      expect(s.text('[data-first-run-sign-in="codex"]')).toContain(
        'This is your own Codex login on studio-mac: codex in your terminal signs in too.',
      );
      // The sign-in's own button is the only primary while it is open.
      expect(s.q('[data-onboarding-primary]')).toBeNull();
      expect(s.text('[data-change-submit]')).toBe('Sign in to Codex');
      await clickOn(s.q('[data-change-submit]'), 'sign in to codex');
      expect(changeBodies(calls)).toEqual([
        { kind: 'credential.add', id: 'codex-you', harness: 'codex', store: 'host' },
      ]);
      expect(calls.find(call => call.path === LOGIN_PATH)?.body).toEqual({ credentialId: 'codex-you' });
      await until(() => s.q('[data-codex-login="awaiting-approval"]') !== null, 'the Codex login awaiting approval');
      approvedOnMachine = true;
      await until(
        () => s.q('[data-first-run-sign-in]') === null && s.text('[data-onboarding-primary]') === 'Import',
        'the step again, signed in',
      );
      expect(s.q('[data-harness-sign-in]')).toBeNull();
      expect(s.text('[data-setup-section="found"]')).toContain('Signed in');
    } finally {
      await s.view.unmount();
    }
  });

  it('reuses an own login that is already there, and Not now puts the sign-in off', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon(
        {
          [CREDENTIALS_PATH]: credentials([
            credentialView('codex-you', { harness: 'claude', store: 'host' }),
            ownCodexLogin,
          ]),
          [LOGIN_PATH]: new FyHttpError('a sign-in is already running', 409, 'conflict'),
        },
        calls,
      ),
      { harness: 'codex' },
    );
    try {
      await clickOn(s.q('[data-harness-sign-in]'), 'sign in now');
      await clickOn(s.q('[data-change-submit]'), 'sign in to codex');
      // Nothing is made: the machine already points at the person's own Codex login.
      expect(changeBodies(calls)).toEqual([]);
      expect(calls.find(call => call.path === LOGIN_PATH)?.body).toEqual({ credentialId: 'codex-you' });
      await clickOn(s.q('[data-first-run-sign-in-close]'), 'not now');
      expect(s.q('[data-first-run-sign-in]')).toBeNull();
      expect(s.q('[data-harness-sign-in]')).not.toBeNull();
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
    } finally {
      await s.view.unmount();
    }
  });

  it('says why the own login could not be made, and starts no sign-in', async () => {
    const calls: Call[] = [];
    const sentence = 'codex-you is already a login on studio-mac';
    const s = await start(daemon({ [CHANGES_PATH]: new FyHttpError(sentence, 409, 'fleet_change_refused') }, calls), {
      harness: 'codex',
    });
    try {
      await clickOn(s.q('[data-harness-sign-in]'), 'sign in now');
      await clickOn(s.q('[data-change-submit]'), 'sign in to codex');
      expect(s.text('[data-first-run-sign-in="codex"]')).toContain(sentence);
      expect(calls.some(call => call.path === LOGIN_PATH)).toBe(false);
    } finally {
      await s.view.unmount();
    }
  });

  it('starts nothing when the made login cannot be read back', async () => {
    const calls: Call[] = [];
    let added = false;
    const s = await start(
      daemon(
        {
          [CREDENTIALS_PATH]: () => (added ? new FyHttpError('gone', 500, 'x') : credentials([])),
          [APPLY_PATH]: () => {
            added = true;
            return EXECUTED;
          },
        },
        calls,
      ),
      { harness: 'codex' },
    );
    try {
      await clickOn(s.q('[data-harness-sign-in]'), 'sign in now');
      await clickOn(s.q('[data-change-submit]'), 'sign in to codex');
      expect(changeBodies(calls)).toHaveLength(1);
      expect(calls.some(call => call.path === LOGIN_PATH)).toBe(false);
      expect(s.q('[data-first-run-sign-in="codex"]')).not.toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('says why the logins could not be read, and starts nothing', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon(
        { [CREDENTIALS_PATH]: new FyHttpError('the setup could not be read', 409, 'fleet_catalog_unreadable') },
        calls,
      ),
      { harness: 'codex' },
    );
    try {
      await clickOn(s.q('[data-harness-sign-in]'), 'sign in now');
      await clickOn(s.q('[data-change-submit]'), 'sign in to codex');
      expect(s.text('[data-first-run-sign-in="codex"] [role="alert"]')).toContain('the setup could not be read');
      expect(calls.some(call => call.path === LOGIN_PATH)).toBe(false);
      await clickOn(s.q('[data-first-run-sign-in-close]'), 'not now');
      expect(s.q('[data-harness-sign-in]')).not.toBeNull();
    } finally {
      await s.view.unmount();
    }
  });
});

describe('providerProfile', () => {
  const data = (
    runtimeList: ReturnType<typeof runtimeView>[],
    profileList: FleetLayeredProfileView[],
  ): MachineData => ({
    credentials: credentials([]),
    runtimes: runtimes(runtimeList),
    profiles: profiles(profileList),
    components: null,
  });

  it('is the profile the CLI’s runtimes already use', () => {
    expect(
      providerProfile(
        data(
          [runtimeView('codex-default', { harness: 'codex', profile: 'codex-p' }), runtimeView('claude-default')],
          [profileView({ name: 'other' })],
        ),
        'claude',
      ),
    ).toBe('default');
  });

  it('else the first profile that fits the CLI', () => {
    const codexOnly = profileView({ name: 'codex-only', scope: { kind: 'scoped', scope: 'codex' } });
    expect(providerProfile(data([], [codexOnly, profileView({ name: 'generic' })]), 'claude')).toBe('generic');
  });

  it('else none', () => {
    const codexOnly = profileView({ name: 'codex-only', scope: { kind: 'scoped', scope: 'codex' } });
    expect(providerProfile(data([], [codexOnly]), 'claude')).toBeUndefined();
    expect(providerProfile(data([], []), 'claude')).toBeUndefined();
  });
});

describe('OnboardingHarnessStep: Use a provider key instead', () => {
  // The step's own Import button is on screen too: the runtime form's is the one inside it.
  const CREATE = '[data-harness-provider-runtime] [data-change-submit]';

  const openGrid = async (s: Step): Promise<void> => {
    await clickOn(s.q('[data-harness-provider-toggle]'), 'use a provider key');
    await until(() => s.q('[data-provider-grid]') !== null, 'the provider grid');
  };

  const addDeepseek = async (s: Step): Promise<void> => {
    await clickOn(s.q('[data-provider-tile="deepseek"]'), 'DeepSeek');
    await typeInto(s.q('[data-env-secret-input="DEEPSEEK_API_KEY"]'), 'a-pasted-deepseek-key', 'the key');
    await clickOn(s.q('[data-env-login="form"] [data-change-submit]'), 'Add');
  };

  it('is collapsed until opened, then offers only the providers with a half for this CLI', async () => {
    const s = await start(daemon());
    try {
      const toggle = must(s.q('[data-harness-provider-toggle]'), 'the toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.textContent).toBe('Use a provider key instead');
      expect(s.text('[data-harness-provider]')).toContain('GLM, DeepSeek, Kimi, OpenRouter, Bedrock and more');
      expect(s.q('[data-env-login]')).toBeNull();
      await openGrid(s);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const tiles = [...s.view.container.querySelectorAll('[data-provider-tile]')].map(tile =>
        tile.getAttribute('data-provider-tile'),
      );
      expect(tiles).toContain('deepseek');
      expect(tiles).not.toContain('azure-openai');
      await clickOn(toggle, 'close');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(s.q('[data-env-login]')).toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('is not offered for a CLI that is not installed', async () => {
    const s = await start(daemon({ [SCAN_PATH]: NOTHING_INSTALLED }));
    try {
      expect(s.q('[data-harness-provider-toggle]')).toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('adding a login names its runtime in place, on the profile this CLI already runs, and creates it', async () => {
    const calls: Call[] = [];
    let created = false;
    const s = await start(
      daemon(
        {
          [RUNTIMES_PATH]: () =>
            runtimes([runtimeView('claude-default'), ...(created ? [runtimeView('claude-deepseek')] : [])]),
          [APPLY_PATH]: () => {
            if (changeBodies(calls).some(change => (change as { kind: string }).kind === 'runtime.put')) created = true;
            return EXECUTED;
          },
        },
        calls,
      ),
    );
    try {
      await openGrid(s);
      await addDeepseek(s);
      await until(() => s.q('[data-harness-provider-runtime]') !== null, 'the runtime form');
      expect(s.q('[data-env-login]')).toBeNull();
      expect(s.text('[data-harness-provider-runtime]')).toContain('deepseek is added. Name its runtime.');
      expect((s.q('[data-provider-runtime-name]') as HTMLInputElement).value).toBe('claude-deepseek');
      expect(s.text('[data-harness-provider-runtime]')).toContain('Runs the default profile.');
      expect(s.text(CREATE)).toBe('Create claude-deepseek');
      const readsBefore = calls.filter(call => call.path === SCAN_PATH).length;
      await clickOn(s.q(CREATE), 'create');
      expect(changeBodies(calls).map(change => (change as { kind: string }).kind)).toEqual([
        'credential.add',
        'runtime.put',
      ]);
      expect(changeBodies(calls)[1]).toEqual({
        kind: 'runtime.put',
        name: 'claude-deepseek',
        credential: 'deepseek',
        profile: 'default',
        agent: true,
        create: true,
      });
      expect(s.text('[data-setup-note="provider-runtime-ready"]')).toContain('claude-deepseek is ready');
      expect(s.text('[data-setup-note="provider-runtime-ready"]')).toContain(
        'Claude Code · deepseek · default profile',
      );
      // The step reads the machine again, so it is set now that the CLI has a runtime.
      expect(calls.filter(call => call.path === SCAN_PATH).length).toBeGreaterThan(readsBefore);
      expect(s.ready.length).toBeGreaterThan(0);
      // Add another provider goes back to the grid.
      await clickOn(s.q('[data-harness-provider-another]'), 'add another provider');
      await until(() => s.q('[data-provider-grid]') !== null, 'the grid again');
      expect(s.q('[data-harness-provider-runtime]')).toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('falls back to the first profile that fits when the CLI has no runtime yet', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon(
        {
          [PROFILES_PATH]: profiles([
            profileView({ name: 'codex-only', scope: { kind: 'scoped', scope: 'codex' } }),
            profileView({ name: 'generic' }),
          ]),
        },
        calls,
      ),
    );
    try {
      await openGrid(s);
      await addDeepseek(s);
      await until(() => s.q('[data-harness-provider-runtime]') !== null, 'the runtime form');
      expect(s.text('[data-harness-provider-runtime]')).toContain('Runs the generic profile.');
      await clickOn(s.q(CREATE), 'create');
      expect(changeBodies(calls)[1]).toMatchObject({ kind: 'runtime.put', profile: 'generic' });
    } finally {
      await s.view.unmount();
    }
  });

  it('with no profile that fits it says the import makes one first, and creates nothing', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon(
        { [PROFILES_PATH]: profiles([profileView({ name: 'codex-only', scope: { kind: 'scoped', scope: 'codex' } })]) },
        calls,
      ),
    );
    try {
      await openGrid(s);
      await addDeepseek(s);
      await until(() => s.q('[data-setup-note="provider-no-profile"]') !== null, 'the no-profile note');
      expect(s.text('[data-setup-note="provider-no-profile"]')).toContain('deepseek is added');
      expect(s.text('[data-setup-note="provider-no-profile"]')).toContain(
        'Its runtime needs a profile for Claude Code. Import above first',
      );
      expect(s.q('[data-provider-runtime-name]')).toBeNull();
      expect(changeBodies(calls).map(change => (change as { kind: string }).kind)).toEqual(['credential.add']);
    } finally {
      await s.view.unmount();
    }
  });

  it('a name already used says why and holds Create; a good one frees it', async () => {
    const calls: Call[] = [];
    const s = await start(daemon({ [RUNTIMES_PATH]: runtimes([runtimeView('claude-default')]) }, calls));
    try {
      await openGrid(s);
      await addDeepseek(s);
      await until(() => s.q('[data-harness-provider-runtime]') !== null, 'the runtime form');
      await typeInto(s.q('[data-provider-runtime-name]'), ' claude-default ', 'a taken name');
      expect(s.q('[data-provider-runtime-name]')?.getAttribute('aria-invalid')).toBe('true');
      expect(s.text('[data-provider-runtime-problem]')).toBe('claude-default is already a runtime on studio-mac.');
      expect((s.q(CREATE) as HTMLButtonElement | null)?.disabled).toBe(true);
      await typeInto(s.q('[data-provider-runtime-name]'), '', 'an empty name');
      expect(s.text('[data-provider-runtime-problem]')).toBe('Give the runtime a name.');
      expect(s.text(CREATE)).toBe('Create runtime');
      expect((s.q(CREATE) as HTMLButtonElement | null)?.disabled).toBe(true);
      await typeInto(s.q('[data-provider-runtime-name]'), 'glm-work', 'a good name');
      expect(s.q('[data-provider-runtime-problem]')).toBeNull();
      expect((s.q(CREATE) as HTMLButtonElement | null)?.disabled).toBe(false);
    } finally {
      await s.view.unmount();
    }
  });

  it('a runtime the daemon refuses shows its sentence and stays on the form', async () => {
    const sentence = 'That name was taken a moment ago.';
    const s = await start(
      daemon({
        [CHANGES_PATH]: (call: Call) =>
          (call.body as { change: { kind: string } }).change.kind === 'runtime.put'
            ? new FyHttpError(sentence, 409, 'fleet_change_refused')
            : stagedFrom(call),
      }),
    );
    try {
      await openGrid(s);
      await addDeepseek(s);
      await until(() => s.q('[data-harness-provider-runtime]') !== null, 'the runtime form');
      const readsBefore = s.ready.length;
      await clickOn(s.q(CREATE), 'create');
      expect(s.text('[data-change-refusal]')).toBe(sentence);
      expect(s.q('[data-setup-note="provider-runtime-ready"]')).toBeNull();
      expect(s.q('[data-provider-runtime-name]')).not.toBeNull();
      expect(s.ready).toHaveLength(readsBefore);
    } finally {
      await s.view.unmount();
    }
  });
});

describe('OnboardingHarnessStep — auto-advance', () => {
  it('a revisit with a runtime already there and nothing ticked has a Continue that moves on without sending', async () => {
    const calls: Call[] = [];
    const s = await start(daemon({ [RUNTIMES_PATH]: runtimes([runtimeView('claude-default')]) }, calls));
    try {
      expect(s.text('[data-onboarding-primary]')).toBe('Continue');
      expect(s.view.container.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
      await clickOn(s.q('[data-onboarding-primary]'), 'continue');
      expect(s.finished).toEqual([null]);
      expect(changeBodies(calls)).toEqual([]);
    } finally {
      await s.view.unmount();
    }
  });

  it('ticking “import again” turns Continue into Import, and success then moves on', async () => {
    const calls: Call[] = [];
    const s = await start(daemon({ [RUNTIMES_PATH]: runtimes([runtimeView('claude-work')]) }, calls), {
      answers: { accepted: ['mcp/slack'] },
    });
    try {
      expect(s.text('[data-onboarding-primary]')).toBe('Import');
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(changeBodies(calls)).toHaveLength(1);
      expect(s.finished).toHaveLength(1);
    } finally {
      await s.view.unmount();
    }
  });

  it('keeps the passkey line and the grant sentence in the body while the primary sits apart', async () => {
    const s = await start(daemon());
    try {
      expect(s.q('[data-change-apply] button')).toBeNull();
      expect(s.q('[data-change-apply]')).not.toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('on a machine that wants a passkey, the passkey line stays in the body and the footer Import still sends', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon({ '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'step-up-required' }) }, calls),
    );
    try {
      expect(s.q('[data-onboarding-step-body] [data-change-step-up]')?.textContent).toContain('passkey');
      expect(s.q('[data-change-apply] button')).toBeNull();
      const primary = must(s.q('[data-onboarding-primary]') as HTMLButtonElement | null, 'the footer Import');
      expect(primary.textContent).toBe('Import');
      expect(primary.disabled).toBe(false);
      await clickOn(primary, 'import');
      expect(changeBodies(calls)).toHaveLength(1);
      expect(s.finished).toHaveLength(1);
    } finally {
      await s.view.unmount();
    }
  });

  it('on a machine that refuses this device, the grant sentence stays in the body and the footer Import is held', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon({ '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'not-granted' }) }, calls),
    );
    try {
      expect(s.text('[data-onboarding-step-body] [data-change-grant-refused]').length).toBeGreaterThan(0);
      const primary = must(s.q('[data-onboarding-primary]') as HTMLButtonElement | null, 'the footer Import');
      expect(primary.textContent).toBe('Import');
      expect(primary.disabled).toBe(true);
      await clickOn(primary, 'import');
      expect(changeBodies(calls)).toEqual([]);
      expect(s.finished).toHaveLength(0);
    } finally {
      await s.view.unmount();
    }
  });

  it('does not move on, or import conversations, when the apply is refused', async () => {
    const calls: Call[] = [];
    const s = await start(daemon({ [CHANGES_PATH]: new FyHttpError('Not now.', 409, 'fleet_change_refused') }, calls), {
      answers: { conversations: true },
    });
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(s.text('[data-change-refusal]')).toBe('Not now.');
      expect(s.finished).toHaveLength(0);
      expect(calls.some(call => call.path.startsWith('/v1/imports/conversations'))).toBe(false);
    } finally {
      await s.view.unmount();
    }
  });
});

describe('OnboardingHarnessStep — also bring my conversations', () => {
  const DAY = 86_400_000;
  const row = (id: string, daysAgo: number, adoptedBy?: string) => ({
    id,
    harness: 'claude',
    project: '/work/shop',
    preview: `conversation ${id}`,
    lastActivityAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
    turns: 3,
    ...(adoptedBy === undefined ? {} : { adoptedBy }),
  });
  const LISTING_PATH = '/v1/imports/conversations?harness=claude&limit=5000';
  const ADOPT_PATH = '/v1/imports/conversations/adopt';
  const listing = (rows: readonly object[]) => ({ conversations: rows, matched: rows.length, skipped: 0 });
  const adopted = (ids: readonly string[]) => ({
    adopted: ids.map(id => ({ id, session: `s-${id}`, name: `ferret-${id}`, status: 'stopped' })),
    refused: [],
  });
  const adoptCalls = (calls: readonly Call[]) => calls.filter(call => call.path === ADOPT_PATH);
  /** The runtimes the machine lists once the import has made claude-default. */
  const afterImport = () => {
    let created = false;
    return {
      [RUNTIMES_PATH]: () => runtimes(created ? [runtimeView('claude-default')] : []),
      [APPLY_PATH]: () => {
        created = true;
        return EXECUTED;
      },
    };
  };

  it('is a checkbox before Import, unticked by default, that keeps its answer with the rail', async () => {
    const s = await start(daemon());
    try {
      const box = must(s.q('[data-harness-conversations]') as HTMLInputElement | null, 'the checkbox');
      expect(box.checked).toBe(false);
      expect(box.closest('label')?.textContent).toBe('Also bring my conversations from the last 7 days');
      expect(s.q('[data-conversation-window]')).toBeNull();
      await clickOn(box, 'tick');
      expect(s.answers.at(-1)).toEqual({ conversations: true });
      expect((s.q('[data-harness-conversations]') as HTMLInputElement).checked).toBe(true);
    } finally {
      await s.view.unmount();
    }
  });

  it('unticked, imports no conversation and asks the machine for none', async () => {
    const calls: Call[] = [];
    const s = await start(daemon(afterImport(), calls));
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(calls.some(call => call.path.startsWith('/v1/imports/conversations'))).toBe(false);
      expect(s.finished[0]?.conversations).toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('ticked, brings the last 7 days in AFTER the runtime import, stopped, and reports it', async () => {
    const calls: Call[] = [];
    const s = await start(
      daemon(
        {
          ...afterImport(),
          [LISTING_PATH]: listing([row('a', 0.5), row('b', 2), row('c', 10), row('d', 40), row('e', 0.1, 'owned')]),
          [ADOPT_PATH]: adopted(['a', 'b']),
        },
        calls,
      ),
      { answers: { conversations: true } },
    );
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      const order = calls.map(call => call.path);
      expect(order.indexOf(APPLY_PATH)).toBeLessThan(order.indexOf(ADOPT_PATH));
      expect(adoptCalls(calls).map(call => call.body)).toEqual([
        {
          harness: 'claude',
          runtime: 'claude-default',
          conversations: [
            { id: 'a', start: false },
            { id: 'b', start: false },
          ],
        },
      ]);
      expect(s.finished[0]?.conversations).toBe('Brought in 2 conversations.');
      expect(s.text('[data-setup-note="import-ready"] > p')).toBe(
        'Imported 1 login, 2 skills, 3 MCP servers, 2 conversations',
      );
      expect(s.answers.at(-1)).toEqual({});
    } finally {
      await s.view.unmount();
    }
  });

  it('brings a big window in batches no bigger than one adoption may name', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => row(`c${index}`, 1 + index / 1000));
    const calls: Call[] = [];
    const s = await start(
      daemon(
        {
          ...afterImport(),
          [LISTING_PATH]: listing(rows),
          [ADOPT_PATH]: (call: Call) =>
            adopted((call.body as { conversations: { id: string }[] }).conversations.map(item => item.id)),
        },
        calls,
      ),
      { answers: { conversations: true } },
    );
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(adoptCalls(calls).map(call => (call.body as { conversations: unknown[] }).conversations.length)).toEqual([
        200, 1,
      ]);
      expect(s.finished[0]?.conversations).toBe('Brought in 201 conversations.');
    } finally {
      await s.view.unmount();
    }
  });

  it('says there was no runtime to put them in when the machine lists none after the import', async () => {
    const s = await start(daemon({ [APPLY_PATH]: EXECUTED }), { answers: { conversations: true } });
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(s.finished[0]?.conversations).toContain('no runtime to put them in');
    } finally {
      await s.view.unmount();
    }
  });

  it('says how many could not be brought in, and still moves on', async () => {
    const s = await start(
      daemon({
        ...afterImport(),
        [LISTING_PATH]: listing([row('a', 0.5), row('b', 0.6)]),
        [ADOPT_PATH]: {
          adopted: adopted(['a']).adopted,
          refused: [{ id: 'b', code: 'conflict', reason: 'b already has a different file there' }],
        },
      }),
      { answers: { conversations: true } },
    );
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(s.finished[0]?.conversations).toBe('Brought in 1 conversation; 1 conversation couldn’t be imported.');
    } finally {
      await s.view.unmount();
    }
  });

  it('says so when there are none in the window', async () => {
    const calls: Call[] = [];
    const s = await start(daemon({ ...afterImport(), [LISTING_PATH]: listing([row('old', 40)]) }, calls), {
      answers: { conversations: true },
    });
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(adoptCalls(calls)).toHaveLength(0);
      expect(s.finished[0]?.conversations).toBe('No Claude Code conversations from the last 7 days.');
    } finally {
      await s.view.unmount();
    }
  });

  it('a conversations failure never undoes the import: it says why and the page still moves on', async () => {
    const s = await start(daemon({ ...afterImport(), [LISTING_PATH]: new Error('offline') }), {
      answers: { conversations: true },
    });
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(s.finished).toHaveLength(1);
      expect(s.finished[0]?.conversations).toContain('Couldn’t bring in your Claude Code conversations');
      // The setup did import, so the headline stays the import's own and green.
      expect(s.q('[data-setup-note="import-ready"]')?.getAttribute('data-tone')).toBe('ok');
      expect(s.q('[data-harness-imported]')).not.toBeNull();
    } finally {
      await s.view.unmount();
    }
  });

  it('a refused adoption stops at the refused batch and says what it did', async () => {
    const s = await start(
      daemon({
        ...afterImport(),
        [LISTING_PATH]: listing([row('a', 0.5)]),
        [ADOPT_PATH]: new FyHttpError('nope', 403, 'forbidden'),
      }),
      { answers: { conversations: true } },
    );
    try {
      await clickOn(s.q('[data-onboarding-primary]'), 'import');
      expect(s.finished[0]?.conversations).toContain('Brought in 0 conversations, then:');
    } finally {
      await s.view.unmount();
    }
  });

  describe('on a revisit, with only conversations ticked', () => {
    const REVISIT = {
      [SCAN_PATH]: scan({
        runtimes: [{ harness: 'codex', name: 'codex-default', profile: 'default' }],
        duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
      }),
      [RUNTIMES_PATH]: runtimes([runtimeView('claude-default')]),
    };

    it('adopts them into the existing runtime and applies no setup.import', async () => {
      const calls: Call[] = [];
      const s = await start(
        daemon({ ...REVISIT, [LISTING_PATH]: listing([row('a', 0.5)]), [ADOPT_PATH]: adopted(['a']) }, calls),
        { answers: { conversations: true } },
      );
      try {
        expect(s.text('[data-onboarding-primary]')).toBe('Import');
        await clickOn(s.q('[data-onboarding-primary]'), 'import');
        expect(changeBodies(calls)).toEqual([]);
        expect(calls.some(call => call.path === APPLY_PATH)).toBe(false);
        expect(adoptCalls(calls).map(call => (call.body as { runtime: string }).runtime)).toEqual(['claude-default']);
        expect(s.finished).toEqual([
          {
            harness: 'claude',
            runtime: null,
            summary: null,
            conversations: 'Brought in 1 conversation.',
            conversationsFailed: false,
            signIn: [],
          },
        ]);
        // The result claims what happened — conversations — and no setup it did not re-import.
        expect(s.text('[data-setup-note="import-ready"] > p')).toBe('Brought in 1 conversation.');
        expect(s.q('[data-setup-note="import-note"]')).toBeNull();
      } finally {
        await s.view.unmount();
      }
    });

    it('a refused conversations import is a warning headline, not a green one', async () => {
      const s = await start(daemon({ ...REVISIT, [LISTING_PATH]: new Error('offline') }), {
        answers: { conversations: true },
      });
      try {
        await clickOn(s.q('[data-onboarding-primary]'), 'import');
        const note = must(s.q('[data-setup-note="import-ready"]'), 'the result note');
        expect(note.getAttribute('data-tone')).toBe('warn');
        expect(s.text('[data-setup-note="import-ready"] > p')).toContain(
          'Couldn’t bring in your Claude Code conversations',
        );
        expect(s.finished[0]?.conversationsFailed).toBe(true);
      } finally {
        await s.view.unmount();
      }
    });

    it('an adoption refused before anything came in is a warning too', async () => {
      const s = await start(
        daemon({
          ...REVISIT,
          [LISTING_PATH]: listing([row('a', 0.5)]),
          [ADOPT_PATH]: new FyHttpError('nope', 403, 'forbidden'),
        }),
        { answers: { conversations: true } },
      );
      try {
        await clickOn(s.q('[data-onboarding-primary]'), 'import');
        expect(s.q('[data-setup-note="import-ready"]')?.getAttribute('data-tone')).toBe('warn');
      } finally {
        await s.view.unmount();
      }
    });

    it('brought in some and then refused is still a green headline', async () => {
      let batch = 0;
      const rows = Array.from({ length: 201 }, (_, index) => row(`c${index}`, 1 + index / 1000));
      const s = await start(
        daemon({
          ...REVISIT,
          [LISTING_PATH]: listing(rows),
          [ADOPT_PATH]: (call: Call) => {
            batch += 1;
            if (batch > 1) return new FyHttpError('nope', 403, 'forbidden');
            return adopted((call.body as { conversations: { id: string }[] }).conversations.map(item => item.id));
          },
        }),
        { answers: { conversations: true } },
      );
      try {
        await clickOn(s.q('[data-onboarding-primary]'), 'import');
        expect(s.q('[data-setup-note="import-ready"]')?.getAttribute('data-tone')).toBe('ok');
        expect(s.finished[0]?.conversationsFailed).toBe(false);
      } finally {
        await s.view.unmount();
      }
    });

    it('with nothing to bring in it says so rather than “Imported”', async () => {
      const s = await start(daemon({ ...REVISIT, [LISTING_PATH]: listing([]) }), {
        answers: { conversations: true },
      });
      try {
        await clickOn(s.q('[data-onboarding-primary]'), 'import');
        expect(s.text('[data-setup-note="import-ready"] > p')).toBe(
          'No Claude Code conversations from the last 7 days.',
        );
      } finally {
        await s.view.unmount();
      }
    });

    it('still applies the setup import when an update is also taken', async () => {
      const calls: Call[] = [];
      const s = await start(daemon({ ...REVISIT, [LISTING_PATH]: listing([]) }, calls), {
        answers: { conversations: true, accepted: ['mcp/slack'] },
      });
      try {
        await clickOn(s.q('[data-onboarding-primary]'), 'import');
        expect(changeBodies(calls)).toHaveLength(1);
        expect(s.finished[0]?.summary).toBe('Imported 1 login, 2 skills, 3 MCP servers');
      } finally {
        await s.view.unmount();
      }
    });
  });
});
