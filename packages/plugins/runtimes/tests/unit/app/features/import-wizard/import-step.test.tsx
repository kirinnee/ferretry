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
          outcomes: [{ harness: 'claude-code', outcome: 'installed', command: 'brew install --cask claude-code' }],
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
  });
});

describe('everything found', () => {
  it('header, groups with what they become, the fixed lines, and no hook or project checkbox', async () => {
    const view = await open(routes(scanOf({ claude: CLAUDE_FULL, codex: CODEX_FULL })));
    const root = view.container;
    expect(text(root, '[data-tool-headline]')).toBe('Installed · version 2.1.0 · signed in as sam@example.test');
    expect(root.querySelectorAll('input[type="checkbox"]')).toHaveLength(7);
    expect(text(root, '[data-found-group="env"]')).toContain(
      'kept in the Vault: agents use it, nobody can read it back',
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
        .map(step => `${step.params?.['plugin']}.${step.params?.['stepId']}:${(step.body as { state: string }).state}`)
        .sort(),
    ).toEqual(['claude-code.harness:found', 'logins.login:found', 'runtimes.runtimes:done']);
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
