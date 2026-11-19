/**
 * THE IMPORT WIZARD, mounted over a scripted machine: each tool's page, what it sends (`setup.import` with `include`, `names`
 * and a `skip` made from the unticked boxes), the old steps it settles, and what it never offers (hooks, project folders).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type PlacedPanel, WithSlotPanels } from '@ferretry/app/testing';
import { ImportStep } from '../../../../../app/features/import-wizard/import-step.tsx';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { type Call, CHANGE_ID, machine, scripted, stagedFrom } from '../fleet/account-support.ts';
import { ADD_RUNTIME_LOGIN_SLOT } from '../../../../../contract/index.ts';
import { CLAUDE_FULL, CODEX_FULL, scanOf, UPDATE_OK } from './scans.ts';
import type { SetupScan } from '../../../../../contract/index.ts';

const APPLY = `POST /v1/runtimes/proposals/${CHANGE_ID}/apply`;
const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
  window.history.pushState({}, '', '/');
});

const SENTENCES =
  'Runtimes: claude-code-default. Written by the parts that own them: mcp/notes.yaml, skills/review.yaml. Not written: mcp/issues.yaml (a secret-shaped value).';

const routes = (scan: SetupScan, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  'GET /v1/runtimes/setup/scan': scan,
  'GET /v1/claude-code/update': UPDATE_OK('2.1.0'),
  'GET /v1/codex/update': UPDATE_OK('0.9.0'),
  'GET /v1/runtimes/machine': machine(),
  'POST /v1/runtimes/proposals': (call: Call) => ({
    ...stagedFrom(call),
    preview: { kind: 'executor', executor: 'setup', description: 'Import.' },
  }),
  [APPLY]: { outcome: 'executed', executor: 'setup', summary: SENTENCES },
  'POST /v1/onboarding/steps/:plugin/:stepId': { ok: true },
  ...extra,
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const open = async (
  table: Record<string, unknown>,
  calls: Call[] = [],
  slots?: Record<string, readonly PlacedPanel[]>,
) => {
  const client = scripted(table, calls);
  const node = <ImportStep client={client} machineName="studio-mac" />;
  const view = await mount(slots === undefined ? node : <WithSlotPanels slots={slots}>{node}</WithSlotPanels>);
  mounted.push(view);
  await settle();
  return view;
};

const click = async (container: ParentNode, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
};

const text = (container: ParentNode, selector: string): string => container.querySelector(selector)?.textContent ?? '';

describe('a fresh machine', () => {
  it('Claude Code not installed: the command is shown first, import is off, and Install runs it', async () => {
    const calls: Call[] = [];
    const view = await open(
      routes(scanOf({ claude: 'absent', codex: 'absent' }), {
        'POST /v1/runtimes/machine/tools/install': {
          outcomes: [
            {
              harness: 'claude-code',
              outcome: 'installed',
              command: 'brew install --cask claude-code',
              output: ['==> Installed claude-code'],
            },
          ],
        },
      }),
      calls,
    );
    const root = view.container;
    expect(text(root, '[data-tool-headline]')).toBe('Not installed on this machine');
    expect(text(root, '[data-install-command]')).toBe('brew install --cask claude-code');
    expect(root.querySelector<HTMLButtonElement>('[data-change-submit]')?.disabled).toBe(true);
    await click(root, '[data-install-run="claude-code"]');
    await settle();
    expect(calls.find(call => call.route === 'POST /v1/runtimes/machine/tools/install')?.body).toEqual({
      harnesses: ['claude-code'],
    });
    expect(text(root, '[data-install-note]')).toContain('brew install --cask claude-code');
    expect(text(root, '[data-install-note]')).toContain('==> Installed claude-code');
  });
});

describe('everything found', () => {
  it('header, groups with what they become, the fixed lines, and no hook or project checkbox', async () => {
    const view = await open(routes(scanOf({ claude: CLAUDE_FULL, codex: CODEX_FULL })));
    const root = view.container;
    expect(text(root, '[data-tool-headline]')).toBe('Installed · version 2.1.0 · signed in as sam@example.test');
    expect(root.querySelectorAll('input[type="checkbox"]')).toHaveLength(7);
    expect(text(root, '[data-found-group="env"]')).toContain(
      'kept in the Vault: agents use them, and nothing can fetch a value back out of the Vault',
    );
    expect(text(root, '[data-found-group="env"]')).toContain('ANTHROPIC_API_KEY');
    expect(text(root, '[data-found-fixed="hooks"]')).toContain('Not imported: Ferretry doesn’t use hooks');
    expect(text(root, '[data-found-fixed="project-instructions"]')).toContain('2 folders');
    expect(text(root, '[data-found-fixed="project-instructions"]')).toContain(
      'Stay in each project; agents read them there',
    );
    expect(text(root, '[data-found-fixed="conversations"]')).toContain(
      'already read automatically, one way. Nothing to import.',
    );
    expect(root.querySelector('[data-found-fixed="hooks"] input')).toBeNull();
    expect(text(root, '[data-import-count]')).toBe('Bringing 7 items.');
  });

  it('unticked items go out as skip; the runtime name is what was typed; the answer names each file; the old steps are settled', async () => {
    const calls: Call[] = [];
    const view = await open(routes(scanOf({ claude: CLAUDE_FULL })), calls);
    const root = view.container;
    await click(root, '[data-found-item="claude-code:mcp:issues"] input');
    await click(root, '[data-found-item="claude-code:env"] input');
    expect(text(root, '[data-import-count]')).toBe('Bringing 5 items, leaving out 2.');
    const name = must(root.querySelector<HTMLInputElement>('[data-runtime-name]'), 'name');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'work-claude');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(root, '[data-change-submit]');
    await settle();
    const proposal = calls.find(call => call.route === 'POST /v1/runtimes/proposals');
    expect(proposal?.body).toEqual({
      change: {
        kind: 'setup.import',
        include: ['claude-code'],
        names: { 'claude-code': 'work-claude' },
        skip: ['claude-code:mcp:issues', 'claude-code:env'],
      },
    });
    const answer = text(root, '[data-import-answer]');
    expect(answer).toContain('Written by the parts that own them: mcp/notes.yaml, skills/review.yaml.');
    expect(answer).toContain('Not written: mcp/issues.yaml (a secret-shaped value).');
    const steps = calls.filter(call => call.route === 'POST /v1/onboarding/steps/:plugin/:stepId');
    expect(
      steps
        .map(step => `${step.params?.plugin}.${step.params?.stepId}:${(step.body as { state: string }).state}`)
        .sort(),
    ).toEqual(['claude-code.harness:found', 'logins.login:found']);
  });

  it('a retry on an import that already made its runtime asks for no new name and imports on that runtime', async () => {
    const calls: Call[] = [];
    const view = await open(
      routes(
        scanOf({
          claude: CLAUDE_FULL,
          duplicates: [{ harness: 'claude-code', existing: 'claude-default', suggested: 'claude-default-2' }],
        }),
      ),
      calls,
    );
    const root = view.container;
    expect(root.querySelector('[data-runtime-name]')).toBeNull();
    expect(text(root, '[data-duplicate-note]')).toBe(
      'A runtime named claude-default already uses this setup, so no second one is added.',
    );
    expect(root.querySelector<HTMLButtonElement>('[data-change-submit]')?.disabled).toBe(false);
    await click(root, '[data-change-submit]');
    await settle();
    expect(calls.find(call => call.route === 'POST /v1/runtimes/proposals')?.body).toMatchObject({
      change: { kind: 'setup.import', include: ['claude-code'] },
    });
    expect(text(root, '[data-import-answer]')).toContain('Claude Code is set up');
  });

  it('Go back after a first apply reads the scan again: the runtime it made is known, so no name is asked for or sent', async () => {
    const calls: Call[] = [];
    let applied = false;
    const view = await open(
      routes(scanOf({ claude: CLAUDE_FULL }), {
        // The machine reports the runtime only AFTER the import committed it.
        'GET /v1/runtimes/setup/scan': () =>
          scanOf({
            claude: CLAUDE_FULL,
            duplicates: applied
              ? [{ harness: 'claude-code', existing: 'work-claude', suggested: 'work-claude-2' }]
              : [],
          }),
        [APPLY]: () => {
          applied = true;
          return { outcome: 'executed', executor: 'setup', summary: SENTENCES };
        },
      }),
      calls,
    );
    const root = view.container;
    const name = must(root.querySelector<HTMLInputElement>('[data-runtime-name]'), 'name');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'work-claude');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(root, '[data-change-submit]');
    await settle();
    expect(text(root, '[data-import-answer]')).toContain('Claude Code is set up');
    await click(root, '[data-tool-reopen="claude-code"]');
    await settle();
    expect(root.querySelector('[data-runtime-name]')).toBeNull();
    expect(text(root, '[data-duplicate-note]')).toBe(
      'A runtime named work-claude already uses this setup, so no second one is added.',
    );
    expect(root.querySelector<HTMLButtonElement>('[data-change-submit]')?.disabled).toBe(false);
    await click(root, '[data-change-submit]');
    await settle();
    const proposals = calls.filter(call => call.route === 'POST /v1/runtimes/proposals');
    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.body).toMatchObject({ change: { names: { 'claude-code': 'work-claude' } } });
    const retry = must(proposals[1], 'the retry proposal').body as { change: Record<string, unknown> };
    expect(retry.change).not.toHaveProperty('names');
  });

  it('Next goes to Codex; its profiles are choices; Finish says where each ended', async () => {
    const view = await open(routes(scanOf({ claude: CLAUDE_FULL, codex: CODEX_FULL })));
    const root = view.container;
    await click(root, '[data-tool-skip="claude-code"]');
    expect(text(root, '[data-tool-page]')).toContain('You left Claude Code out. Nothing was changed.');
    await click(root, '[data-tool-next="claude-code"]');
    expect(text(root, '[data-tool-headline]')).toBe('Installed · version 0.9.0 · signed in as sam@example.test');
    expect(root.querySelectorAll('[data-found-group="profile"] input')).toHaveLength(2);
    await click(root, '[data-tool-skip="codex"]');
    await click(root, '[data-tool-next="codex"]');
    expect(text(root, '[data-import-finished]')).toContain('Claude Code: left out · Codex: left out');
  });
});

describe('a daemon that refuses', () => {
  it('a refused import says why, and nothing is marked done', async () => {
    const calls: Call[] = [];
    const view = await open(
      routes(scanOf({ claude: CLAUDE_FULL }), { 'POST /v1/runtimes/proposals': new Error('This machine is busy.') }),
      calls,
    );
    await click(view.container, '[data-change-submit]');
    await settle();
    expect(text(view.container, '[data-change-refusal]')).not.toBe('');
    expect(view.container.querySelector('[data-import-answer]')).toBeNull();
    expect(calls.some(call => call.route === 'POST /v1/onboarding/steps/:plugin/:stepId')).toBe(false);
  });

  it('an unreadable scan can be tried again', async () => {
    const view = await open({
      'GET /v1/runtimes/setup/scan': new Error('x'),
      'GET /v1/claude-code/update': {},
      'GET /v1/codex/update': {},
    });
    expect(view.container.querySelector('[data-import-unreadable]')).not.toBeNull();
  });
});

describe('not signed in', () => {
  it('the add-login panel is offered through the slot, and a login added re-reads the machine', async () => {
    window.history.pushState({}, '', '/d/d1/settings/runtimes/runtimes');
    const calls: Call[] = [];
    const view = await open(
      routes(scanOf({ claude: { ...CLAUDE_FULL, account: { state: 'not-signed-in' } } })),
      calls,
      {
        [ADD_RUNTIME_LOGIN_SLOT]: [
          {
            plugin: 'logins',
            id: 'add-runtime-login',
            view: props => (
              <button
                type="button"
                data-fake-add=""
                onClick={() => (props['onAdded'] as (id: string) => void)('claude-new')}
              >
                Add
              </button>
            ),
          },
        ],
      },
    );
    const root = view.container;
    expect(root.querySelector('[data-tool-sign-in]')).not.toBeNull();
    await click(root, '[data-add-row="login"]');
    await click(root, '[data-fake-add]');
    await settle();
    expect(root.querySelector('[data-tool-sign-in]')).toBeNull();
    expect(calls.filter(call => call.route === 'GET /v1/runtimes/setup/scan').length).toBeGreaterThanOrEqual(2);
  });
});

describe('GitHub-token variables in the environment', () => {
  const scan = scanOf({ claude: { secretKeys: ['env.ANTHROPIC_API_KEY', 'env.GITHUB_TOKEN', 'env.GH_TOKEN'] } });

  it('start unticked with the reason, and ticking one sends its name as tickedEnv', async () => {
    const calls: Call[] = [];
    const view = await open(routes(scan), calls);
    const root = view.container;
    expect(root.querySelector<HTMLInputElement>('[data-found-token="GITHUB_TOKEN"] input')?.checked).toBe(false);
    expect(text(root, '[data-found-token="GITHUB_TOKEN"]')).toContain('Not imported by default');
    expect(text(root, '[data-found-token="GITHUB_TOKEN"]')).toContain('kept in the Vault');
    await click(root, '[data-change-submit]');
    await settle();
    expect(calls.find(call => call.route === 'POST /v1/runtimes/proposals')?.body).not.toHaveProperty(
      'change.tickedEnv',
    );
  });

  it('a ticked one goes out by name; leaving the whole environment out turns the choice off', async () => {
    const calls: Call[] = [];
    const view = await open(routes(scan), calls);
    const root = view.container;
    await click(root, '[data-found-token="GH_TOKEN"] input');
    await click(root, '[data-change-submit]');
    await settle();
    expect(calls.find(call => call.route === 'POST /v1/runtimes/proposals')?.body).toMatchObject({
      change: { tickedEnv: ['GH_TOKEN'] },
    });
    window.history.replaceState(null, '', '/');
    const second = await open(routes(scan));
    await click(second.container, '[data-found-item="claude-code:env"] input');
    expect(second.container.querySelector<HTMLInputElement>('[data-found-token="GH_TOKEN"] input')?.disabled).toBe(
      true,
    );
  });
});

describe('a machine that wants a passkey for the scan', () => {
  const STEP_UP = { code: 'grant_step_up_required', message: 'confirm with your passkey' };

  it('reads the scan and the versions quietly, and a step-up answer waits for a press instead of a prompt', async () => {
    const calls: Call[] = [];
    let pressed = false;
    const view = await open(
      routes(scanOf({ claude: CLAUDE_FULL }), {
        'GET /v1/runtimes/setup/scan': (call: Call) =>
          call.quiet === true && !pressed ? STEP_UP : scanOf({ claude: CLAUDE_FULL }),
      }),
      calls,
    );
    const root = view.container;
    expect(root.querySelector('[data-import-confirm]')).not.toBeNull();
    expect(
      calls
        .filter(call => call.route.includes('/update') || call.route.includes('setup/scan'))
        .every(call => call.quiet === true),
    ).toBe(true);
    pressed = true;
    await click(root, '[data-import-look]');
    await settle();
    expect(calls.filter(call => call.route === 'GET /v1/runtimes/setup/scan').at(-1)?.quiet).toBe(false);
    expect(root.querySelector('[data-found-list]')).not.toBeNull();
  });
});

describe('a reload', () => {
  const ALL = scanOf({ claude: CLAUDE_FULL, codex: CODEX_FULL });

  it('keeps the open tool, the name and what was left out', async () => {
    const first = await open(routes(ALL));
    await click(first.container, '[data-found-item="claude-code:mcp:issues"] input');
    const name = must(first.container.querySelector<HTMLInputElement>('[data-runtime-name]'), 'name');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'work-claude');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(first.container, '[data-import-tab="codex"]');
    await click(first.container, '[data-found-item="codex:skill:review"] input');
    await first.unmount();
    mounted.splice(0);

    const second = await open(routes(ALL));
    mounted.push(second);
    const root = second.container;
    expect(text(root, '[data-tool-headline]')).toContain('0.9.0');
    expect(root.querySelector<HTMLInputElement>('[data-found-item="codex:skill:review"] input')?.checked).toBe(false);
    await click(root, '[data-import-tab="claude-code"]');
    expect(root.querySelector<HTMLInputElement>('[data-found-item="claude-code:mcp:issues"] input')?.checked).toBe(
      false,
    );
    expect(root.querySelector<HTMLInputElement>('[data-found-item="claude-code:mcp:notes"] input')?.checked).toBe(true);
    expect(must(root.querySelector<HTMLInputElement>('[data-runtime-name]'), 'name').value).toBe('work-claude');
  });
});

describe('the real refusal: a 403 grant_step_up_required thrown by the shell client', () => {
  const refusal = (): Error =>
    Object.assign(
      new Error('changing the settings for the agent fleet needs a passkey confirmation from this device.'),
      {
        status: 403,
        code: 'grant_step_up_required',
      },
    );

  it('shows the needs-your-OK state, not Try again, and its button presses a read that may open the prompt', async () => {
    const calls: Call[] = [];
    let confirmed = false;
    const view = await open(
      routes(scanOf({ claude: CLAUDE_FULL }), {
        'GET /v1/runtimes/setup/scan': (call: Call) => {
          if (call.quiet !== false && !confirmed) throw refusal();
          confirmed = true;
          return scanOf({ claude: CLAUDE_FULL });
        },
      }),
      calls,
    );
    const root = view.container;
    expect(root.querySelector('[data-import-confirm]')).not.toBeNull();
    expect(root.querySelector('[data-import-unreadable]')).toBeNull();
    await click(root, '[data-import-look]');
    await settle();
    expect(calls.filter(call => call.route === 'GET /v1/runtimes/setup/scan').map(call => call.quiet)).toEqual([
      true,
      false,
    ]);
    expect(root.querySelector('[data-found-list]')).not.toBeNull();
  });

  it('any other refusal is still a failure with Try again, and its press is a press too', async () => {
    const calls: Call[] = [];
    const view = await open(
      routes(scanOf({ claude: CLAUDE_FULL }), {
        'GET /v1/runtimes/setup/scan': Object.assign(new Error('nope'), { status: 403, code: 'grant_not_granted' }),
      }),
      calls,
    );
    expect(view.container.querySelector('[data-import-unreadable]')).not.toBeNull();
    await click(view.container, '[data-import-unreadable] button');
    await settle();
    expect(calls.filter(call => call.route === 'GET /v1/runtimes/setup/scan').at(-1)?.quiet).toBe(false);
  });
});

describe('a reload on a later step', () => {
  it('keeps which tools ended and that Finish was pressed, and says the files were written earlier', async () => {
    const ALL = scanOf({ claude: CLAUDE_FULL, codex: CODEX_FULL });
    const first = await open(routes(ALL));
    await click(first.container, '[data-tool-skip="claude-code"]');
    await click(first.container, '[data-tool-next="claude-code"]');
    await click(first.container, '[data-change-submit]');
    await settle();
    await click(first.container, '[data-tool-next="codex"]');
    expect(first.container.querySelector('[data-import-finished]')).not.toBeNull();
    await first.unmount();
    mounted.splice(0);
    const second = await open(routes(ALL));
    mounted.push(second);
    expect(second.container.querySelector('[data-import-finished]')).not.toBeNull();
    expect(text(second.container, '[data-import-finished]')).toContain('Claude Code: left out · Codex: done');
    await click(second.container, '[data-import-tab="codex"]');
    expect(text(second.container, '[data-import-answer-earlier]')).toContain('before this page was reloaded');
  });
});

describe('a re-import whose source changed', () => {
  const changed = {
    ...scanOf({ claude: CLAUDE_FULL }),
    updates: [{ reference: 'instructions/claude', sources: ['~/.claude/CLAUDE.md'] }],
  };

  it('lists it as changed and ticked, sends it as acceptedUpdates, and the answer says it was updated', async () => {
    const calls: Call[] = [];
    const view = await open(routes(changed), calls);
    const root = view.container;
    expect(text(root, '[data-found-group="updates"]')).toContain('Changed since you last brought it in');
    expect(root.querySelector<HTMLInputElement>('[data-found-group="updates"] input')?.checked).toBe(true);
    await click(root, '[data-change-submit]');
    await settle();
    expect(calls.find(call => call.route === 'POST /v1/runtimes/proposals')?.body).toMatchObject({
      change: { acceptedUpdates: ['instructions/claude'] },
    });
    expect(text(root, '[data-import-answer]')).toContain('Updated instructions/claude from its changed source.');
  });

  it('unticked, it is not sent and the answer says it was kept as it was', async () => {
    const calls: Call[] = [];
    const view = await open(routes(changed), calls);
    const root = view.container;
    await click(root, '[data-found-group="updates"] input');
    await click(root, '[data-change-submit]');
    await settle();
    expect(calls.find(call => call.route === 'POST /v1/runtimes/proposals')?.body).not.toHaveProperty(
      'change.acceptedUpdates',
    );
    expect(text(root, '[data-import-answer]')).toContain('instructions/claude kept as it was.');
  });
});

describe('a changed source is listed once', () => {
  it('not again as a new item, and the footer counts it as refreshed', async () => {
    const scan = {
      ...scanOf({ claude: CLAUDE_FULL }),
      updates: [
        { reference: 'instructions/claude', sources: ['~/.claude/CLAUDE.md'] },
        { reference: 'skills/review', sources: ['~/.claude/skills/review'] },
      ],
    };
    const view = await open(routes(scan));
    const root = view.container;
    expect(root.querySelector('[data-found-group="instructions"]')).toBeNull();
    expect(root.querySelector('[data-found-item="claude-code:skill:review"]')).toBeNull();
    expect(root.querySelector('[data-found-item="claude-code:skill:release-notes"]')).not.toBeNull();
    expect(text(root, '[data-import-count]')).toBe('Bringing 5 items, refreshing 2 changed sources.');
  });
});

describe('the only change is an update the person left unticked', () => {
  it('does not show the daemon\'s "Nothing new" as a failure: the tool finishes as set up and says it kept the source as it was', async () => {
    const calls: Call[] = [];
    const scan = {
      ...scanOf({ claude: CLAUDE_FULL }),
      updates: [{ reference: 'instructions/claude', sources: ['~/.claude/CLAUDE.md'] }],
    };
    const view = await open(
      routes(scan, {
        'POST /v1/runtimes/proposals': Object.assign(new Error('Nothing new to import.'), {
          status: 409,
          code: 'fleet_change_refused',
        }),
      }),
      calls,
    );
    const root = view.container;
    await click(root, '[data-found-group="updates"] input');
    await click(root, '[data-change-submit]');
    await settle();
    expect(root.querySelector('[data-change-refusal]')).toBeNull();
    const answer = text(root, '[data-import-answer]');
    expect(answer).toContain('Claude Code is set up');
    expect(answer).toContain('instructions/claude kept as it was.');
    expect(answer).toContain('Nothing new to bring in from Claude Code');
    expect(calls.some(call => call.route === 'POST /v1/onboarding/steps/:plugin/:stepId')).toBe(true);
  });

  it('any other refusal is still shown as one', async () => {
    const view = await open(
      routes(scanOf({ claude: CLAUDE_FULL }), {
        'POST /v1/runtimes/proposals': Object.assign(new Error('This machine is busy.'), {
          status: 409,
          code: 'fleet_change_refused',
        }),
      }),
    );
    await click(view.container, '[data-change-submit]');
    await settle();
    expect(view.container.querySelector('[data-change-refusal]')).not.toBeNull();
    expect(view.container.querySelector('[data-import-answer]')).toBeNull();
  });
});
