/** The Claude segment's "Install Claude Code" page, over a scripted daemon: when it skips itself, what it shows first, and what it never does. */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { InstalledPage } from '../../../../app/features/onboarding/installed-page.tsx';
import { type Call, scripted, stepHarness } from '../../../fixtures/onboarding/harness.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const VERSION = { harness: 'claude-code', installed: { state: 'ok', version: '2.1.0' } };
const absent = { location: { state: 'absent', searched: ['/fake/bin'] } };
const located = { location: { state: 'located', path: '/fake/bin/claude', rule: 'PATH', declaredBy: 'PATH' } };
const update = (location: object): unknown => ({
  ...VERSION,
  ...location,
  method: null,
  plan: null,
  check: { state: 'never' },
  verified: { version: '2.1.0', url: 'https://example.invalid/claude' },
  verification: 'verified',
  available: false,
  job: null,
});
const scan = (tool: object) => ({ tools: [{ harness: 'claude-code', label: 'Claude Code', ...tool }] });
const RUNNABLE = scan({ installed: false, install: { kind: 'runnable', command: 'npm install -g @fake/claude' } });

const open = async (table: Record<string, unknown>, calls: Call[] = []) => {
  const client = scripted(table, calls);
  const run = stepHarness();
  const view = await mount(<InstalledPage client={client} step={run.step} />);
  mounted.push(view);
  await settle();
  return { view, run, calls };
};

describe('the install page', () => {
  it('skips itself, drawing nothing, when Claude Code is already on the machine', async () => {
    const { view, run } = await open({ 'GET /v1/claude-code/update': update(located) });
    expect(run.events).toEqual(['skip:not-needed']);
    expect(view.container.textContent).toBe('');
  });

  it('shows the exact command first and runs nothing until the person presses the button', async () => {
    const { view, run, calls } = await open({
      'GET /v1/claude-code/update': update(absent),
      'GET /v1/runtimes/setup/scan': RUNNABLE,
    });
    expect(run.events).toEqual(['ready']);
    expect(must(view.container.querySelector('[data-install-command]'), 'the command').textContent).toBe(
      'npm install -g @fake/claude',
    );
    expect(calls.some(call => call.route === 'POST /v1/runtimes/machine/tools/install')).toBe(false);
  });

  it('installs on the press: busy while it runs, the install asked for Claude Code only, done after', async () => {
    const calls: Call[] = [];
    const { view, run } = await open(
      {
        'GET /v1/claude-code/update': update(absent),
        'GET /v1/runtimes/setup/scan': RUNNABLE,
        'POST /v1/runtimes/machine/tools/install': {
          outcomes: [
            {
              harness: 'claude-code',
              outcome: 'installed',
              command: 'npm install -g @fake/claude',
              output: ['added 1 package'],
            },
          ],
        },
      },
      calls,
    );
    const button = [...view.container.querySelectorAll('button')].find(b => b.textContent === 'Install Claude Code');
    await interact(() => must(button, 'the install button').click());
    await settle();
    // The request names the very command that was on the screen, so the daemon can refuse if its plan has moved.
    expect(calls.find(call => call.route === 'POST /v1/runtimes/machine/tools/install')?.init?.body).toEqual({
      harnesses: ['claude-code'],
      shown: [{ harness: 'claude-code', command: 'npm install -g @fake/claude' }],
    });
    expect(run.events).toEqual(['ready', 'busy:Installing Claude Code…', 'done', 'busy:null']);
    expect(view.container.querySelector('[data-installed]')?.textContent).toContain('added 1 package');
  });

  it('re-shows the new command, runs nothing and does not say done, when the daemon says its plan changed', async () => {
    let planned = RUNNABLE;
    const refused = Object.assign(
      new Error('The install command for Claude Code changed. It is now: brew install fake-claude.'),
      {
        code: 'fleet_setup_plan_changed',
      },
    );
    const { view, run, calls } = await open({
      'GET /v1/claude-code/update': update(absent),
      'GET /v1/runtimes/setup/scan': () => planned,
      'POST /v1/runtimes/machine/tools/install': () => {
        planned = scan({ installed: false, install: { kind: 'runnable', command: 'brew install fake-claude' } });
        return refused;
      },
    });
    const button = [...view.container.querySelectorAll('button')].find(b => b.textContent === 'Install Claude Code');
    await interact(() => must(button, 'the install button').click());
    await settle();
    expect(must(view.container.querySelector('[data-install-command]'), 'the command').textContent).toBe(
      'brew install fake-claude',
    );
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'It is now: brew install fake-claude',
    );
    expect(run.events).not.toContain('done');
    expect(calls.filter(call => call.route === 'POST /v1/runtimes/machine/tools/install')).toHaveLength(1);
    // A new press sends the new command.
    const again = [...view.container.querySelectorAll('button')].find(b => b.textContent === 'Install Claude Code');
    await interact(() => must(again, 'the install button').click());
    await settle();
    const bodies = calls
      .filter(call => call.route === 'POST /v1/runtimes/machine/tools/install')
      .map(call => call.init?.body);
    expect(bodies[1]).toEqual({
      harnesses: ['claude-code'],
      shown: [{ harness: 'claude-code', command: 'brew install fake-claude' }],
    });
  });

  it('says the daemon’s reason and the manual command when the install fails, and does not say done', async () => {
    const { view, run } = await open({
      'GET /v1/claude-code/update': update(absent),
      'GET /v1/runtimes/setup/scan': RUNNABLE,
      'POST /v1/runtimes/machine/tools/install': {
        outcomes: [
          {
            harness: 'claude-code',
            outcome: 'failed',
            cause: 'failed',
            reason: 'The installer exited with 1.',
            manualCommand: 'npm i -g @fake/claude',
            output: [],
          },
        ],
      },
    });
    const button = [...view.container.querySelectorAll('button')].find(b => b.textContent === 'Install Claude Code');
    await interact(() => must(button, 'the install button').click());
    await settle();
    expect(view.container.textContent).toContain(
      'The installer exited with 1. To do it yourself, run: npm i -g @fake/claude',
    );
    expect(run.events).not.toContain('done');
  });

  it('offers only the manual command, and no install button, when no package manager is there', async () => {
    const { view } = await open({
      'GET /v1/claude-code/update': update(absent),
      'GET /v1/runtimes/setup/scan': scan({
        installed: false,
        install: {
          kind: 'no-package-manager',
          reason: 'No package manager found.',
          manualCommand: 'curl -fsSL https://example.invalid | sh',
        },
      }),
    });
    expect(view.container.querySelector('[data-install-command]')?.textContent).toBe(
      'curl -fsSL https://example.invalid | sh',
    );
    expect([...view.container.querySelectorAll('button')].some(b => b.textContent === 'Install Claude Code')).toBe(
      false,
    );
  });

  it('waits for a press before asking for the passkey that shows the plan', async () => {
    const stepUp = Object.assign(new Error('step up'), { status: 403, code: 'grant_step_up_required' });
    const calls: Call[] = [];
    const { view } = await open(
      {
        'GET /v1/claude-code/update': update(absent),
        'GET /v1/runtimes/setup/scan': (init?: Call['init']) => {
          if (init?.quiet === true) throw stepUp;
          return RUNNABLE;
        },
      },
      calls,
    );
    expect(calls.filter(call => call.route === 'GET /v1/runtimes/setup/scan').map(call => call.init?.quiet)).toEqual([
      true,
    ]);
    const show = [...view.container.querySelectorAll('button')].find(b => b.textContent === 'Show the install command');
    await interact(() => must(show, 'the show button').click());
    await settle();
    expect(view.container.querySelector('[data-install-command]')?.textContent).toBe('npm install -g @fake/claude');
  });
});
