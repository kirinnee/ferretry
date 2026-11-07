import { describe, expect, test } from 'bun:test';
import { OnboardController } from '../../../cli/lib/controller.ts';
import { linkCosts } from '../../../cli/lib/words.ts';
import {
  CLAUDE_ROUTE,
  deps,
  FakeDaemon,
  installedClaude,
  LOGINS_ROUTE,
  NIX_ROUTE,
  nixAbsent,
  nixPresent,
  noClaude,
  printed,
  Sequence,
  signedInLogin,
  step,
} from './fixtures.ts';

const harness = () => step('claude-code', 'harness', 'Claude Code', 20);
const login = () => step('logins', 'login', 'Sign in', 30);
const nix = () => step('shells', 'nix', 'Shells', 80);

function run(
  daemon: FakeDaemon,
  flags: Parameters<OnboardController['run']>[0] = {},
  input: Parameters<typeof deps>[1] = {},
) {
  const made = deps(daemon, input);
  return new OnboardController(made.deps)
    .run(flags)
    .then(code => ({ code, ...made.recorded, recorded: made.recorded }));
}

describe('fy onboard: find before asking', () => {
  test('a machine with Claude Code installed and a harness sign-in asks zero questions and records found', async () => {
    const daemon = new FakeDaemon([harness(), login()], {
      [CLAUDE_ROUTE]: installedClaude,
      [LOGINS_ROUTE]: signedInLogin('host'),
    });
    const result = await run(daemon, {}, { interactive: true });
    expect(result.code).toBe(0);
    expect(result.questions).toEqual([]);
    expect(daemon.recorded).toEqual([
      { plugin: 'claude-code', id: 'harness', state: 'found' },
      { plugin: 'logins', id: 'login', state: 'found' },
    ]);
    expect(printed(result.recorded)).toContain('Ferretry is set up.');
  });

  test('the linked sign-in says its costs in ONE line, and offers a separate login later', async () => {
    const daemon = new FakeDaemon([login()], { [LOGINS_ROUTE]: signedInLogin('host') });
    const result = await run(daemon);
    const lines = result.reports.filter(line => line.includes('share your quota'));
    expect(lines).toEqual([linkCosts('fy')]);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain('signing out in your terminal signs them out too');
    expect(lines[0]).toContain('Usage cannot tell your spend from theirs');
    expect(lines[0]).toContain('`fy login add`');
  });

  test('a login Ferretry holds itself is found without the costs line', async () => {
    const daemon = new FakeDaemon([login()], { [LOGINS_ROUTE]: signedInLogin('ferretry') });
    const result = await run(daemon);
    expect(printed(result.recorded)).not.toContain('share your quota');
  });

  test('steps are shown in the order the daemon gave them, one row each', async () => {
    const daemon = new FakeDaemon([harness(), login(), nix()], {
      [CLAUDE_ROUTE]: installedClaude,
      [LOGINS_ROUTE]: signedInLogin(),
      [NIX_ROUTE]: nixPresent,
    });
    const result = await run(daemon);
    const rows = result.reports.filter(line => line.startsWith('  '));
    expect(rows).toEqual([
      '  ✓ Claude Code  found: Claude Code 2.1.0 is installed.',
      '  ✓ Sign in      found: A login is signed in.',
      '  ✓ Shells       found: nix 2.4.1 is on this machine.'.replace('2.4.1', '2.24.1'),
    ]);
  });

  test('an answered step is shown and left alone: no check, no record', async () => {
    const daemon = new FakeDaemon([step('claude-code', 'harness', 'Claude Code', 20, 'later')], {});
    const result = await run(daemon);
    expect(daemon.checked).toEqual([]);
    expect(daemon.recorded).toEqual([]);
    expect(result.reports[0]).toBe('  - Claude Code  left for later');
    expect(result.code).toBe(0);
  });

  test('running it twice is the same as once', async () => {
    const daemon = new FakeDaemon([harness()], { [CLAUDE_ROUTE]: installedClaude });
    await run(daemon);
    await run(daemon);
    expect(daemon.recorded).toHaveLength(1);
    expect(daemon.checked).toHaveLength(1);
  });

  test('no plugin adds a step: says so and exits 0', async () => {
    const result = await run(new FakeDaemon([]));
    expect(result.reports).toEqual(['No plugin adds a first-run step.']);
    expect(result.code).toBe(0);
  });
});

describe('fy onboard: asking only what is missing', () => {
  test('a missing step names what to do and asks later, skip or done; the default is later', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: nixAbsent });
    const result = await run(daemon, {}, { interactive: true, answers: [''] });
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toContain(nixAbsent.consequence);
    expect(result.questions[0]).toContain(nixAbsent.remedy);
    expect(result.questions[0]).toContain('[L]ater, [s]kip, or [d]one');
    expect(daemon.recorded).toEqual([{ plugin: 'shells', id: 'nix', state: 'later' }]);
    expect(result.code).toBe(0);
  });

  test('skip records skipped', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: nixAbsent });
    await run(daemon, {}, { interactive: true, answers: ['s'] });
    expect(daemon.recorded).toEqual([{ plugin: 'shells', id: 'nix', state: 'skipped' }]);
  });

  test('done looks again: now found records found', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: new Sequence([nixAbsent, nixPresent]) });
    const result = await run(daemon, {}, { interactive: true, answers: ['d'] });
    expect(daemon.checked).toEqual([NIX_ROUTE, NIX_ROUTE]);
    expect(daemon.recorded).toEqual([{ plugin: 'shells', id: 'nix', state: 'found' }]);
    expect(result.code).toBe(0);
  });

  test('done but still missing leaves it for later and says so', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: nixAbsent });
    const result = await run(daemon, {}, { interactive: true, answers: ['done'] });
    expect(daemon.recorded).toEqual([{ plugin: 'shells', id: 'nix', state: 'later' }]);
    expect(printed(result.recorded)).toContain('Still not found.');
  });

  test('an answer it does not know is asked again', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: nixAbsent });
    const result = await run(daemon, {}, { interactive: true, answers: ['what', 'l'] });
    expect(result.questions).toHaveLength(2);
    expect(result.warnings).toEqual(['Answer l, s or d.']);
    expect(daemon.recorded).toEqual([{ plugin: 'shells', id: 'nix', state: 'later' }]);
  });

  test('a step with no check is asked, not looked for', async () => {
    const daemon = new FakeDaemon([step('voice', 'keys', 'Voice', 90)]);
    const result = await run(daemon, {}, { interactive: true, answers: ['s'] });
    expect(daemon.checked).toEqual([]);
    expect(result.questions[0]).toContain('Nothing to look for here.');
    expect(daemon.recorded).toEqual([{ plugin: 'voice', id: 'keys', state: 'skipped' }]);
  });

  test('a found step is never asked about even on a terminal', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: nixPresent });
    const result = await run(daemon, {}, { interactive: true });
    expect(result.questions).toEqual([]);
  });
});

describe('fy onboard: flags and no terminal', () => {
  test('--yes leaves every missing step for later without asking', async () => {
    const daemon = new FakeDaemon([harness(), nix()], { [CLAUDE_ROUTE]: noClaude, [NIX_ROUTE]: nixAbsent });
    const result = await run(daemon, { yes: true }, { interactive: true });
    expect(result.questions).toEqual([]);
    expect(daemon.recorded.map(each => each.state)).toEqual(['later', 'later']);
    expect(result.code).toBe(0);
    expect(printed(result.recorded)).toContain('Left for later: Claude Code, Shells.');
  });

  test('off a terminal without --yes a missing step stays pending, nothing is recorded, exit 2 and it says what to do', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: nixAbsent });
    const result = await run(daemon);
    expect(daemon.recorded).toEqual([]);
    expect(result.code).toBe(2);
    expect(result.warnings).toEqual([
      'Some steps are waiting for you. Run `fy onboard` in a terminal to answer them, or add --yes to leave them for later.',
    ]);
    expect(printed(result.recorded)).toContain('Next:');
    expect(printed(result.recorded)).toContain(`1. Shells: ${nixAbsent.remedy}`);
  });

  test('--check changes nothing, asks nothing, and reports what is found', async () => {
    const daemon = new FakeDaemon([harness(), nix()], { [CLAUDE_ROUTE]: installedClaude, [NIX_ROUTE]: nixAbsent });
    const result = await run(daemon, { check: true }, { interactive: true });
    expect(daemon.recorded).toEqual([]);
    expect(result.questions).toEqual([]);
    expect(result.code).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(printed(result.recorded)).toContain('Claude Code 2.1.0 is installed.');
  });

  test('--json prints one summary and nothing else, without a prompt', async () => {
    const daemon = new FakeDaemon([harness(), nix()], { [CLAUDE_ROUTE]: installedClaude, [NIX_ROUTE]: nixAbsent });
    const result = await run(daemon, { json: true }, { interactive: true });
    expect(result.questions).toEqual([]);
    expect(result.reports).toHaveLength(1);
    const summary = JSON.parse(result.reports[0] ?? '') as {
      schema: number;
      complete: boolean;
      exitCode: number;
      steps: { id: string; state: string }[];
      next: { step: string; why: string }[];
    };
    expect(summary.schema).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.exitCode).toBe(2);
    expect(summary.steps.map(each => `${each.id}:${each.state}`)).toEqual(['harness:found', 'nix:pending']);
    expect(summary.next).toEqual([{ step: 'Shells', why: nixAbsent.remedy }]);
    expect(result.warnings).toEqual([]);
  });
});

describe('fy onboard: when a check cannot be called', () => {
  test('the step stays pending, is never recorded, and says why', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: new Error('Shells is paused') });
    const result = await run(daemon, { yes: true }, { interactive: true });
    expect(daemon.recorded).toEqual([]);
    expect(printed(result.recorded)).toContain('Could not check (Shells is paused).');
    expect(result.code).toBe(2);
  });

  test('an answer in an unknown shape is the same: not found, not decided', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: { surprise: true } });
    const result = await run(daemon, { yes: true });
    expect(daemon.recorded).toEqual([]);
    expect(printed(result.recorded)).toContain('Could not check (the answer was not in a form this fy can read');
  });

  test('a route nobody declares is reported, not hidden', async () => {
    const daemon = new FakeDaemon([harness()]);
    const result = await run(daemon);
    expect(printed(result.recorded)).toContain(
      'Could not check (no plugin declares the route GET /v1/claude-code/update).',
    );
  });

  test('a record that fails is reported and the step stays pending', async () => {
    const daemon = new FakeDaemon([nix()], { [NIX_ROUTE]: nixPresent });
    daemon.recordFails = new Error('the daemon answered HTTP 503');
    const result = await run(daemon);
    expect(result.warnings[0]).toBe('the daemon answered HTTP 503');
    expect(result.code).toBe(2);
  });

  test('the daemon being unreachable is exit 1 with its own sentence', async () => {
    const daemon = new FakeDaemon([nix()]);
    daemon.viewFails = new Error('Onboarding is paused');
    const result = await run(daemon);
    expect(result.code).toBe(1);
    expect(result.warnings).toEqual(['Onboarding is paused']);
    expect(result.reports).toEqual([]);
  });
});

describe('fy onboard status and reset', () => {
  test('status shows where each step stands and checks nothing', async () => {
    const daemon = new FakeDaemon([
      step('claude-code', 'harness', 'Claude Code', 20, 'found'),
      login(),
      step('shells', 'nix', 'Shells', 80, 'skipped'),
    ]);
    const made = deps(daemon);
    const code = await new OnboardController(made.deps).status({});
    expect(code).toBe(0);
    expect(made.recorded.reports).toEqual([
      [
        'The first run is not finished.',
        '',
        '  ✓ Claude Code  found',
        '  ! Sign in      not looked at yet',
        '  - Shells       skipped',
      ].join('\n'),
    ]);
    expect(daemon.checked).toEqual([]);
  });

  test('status --json is the view with a schema number', async () => {
    const daemon = new FakeDaemon([step('shells', 'nix', 'Shells', 80, 'done')]);
    const made = deps(daemon);
    await new OnboardController(made.deps).status({ json: true });
    expect(JSON.parse(made.recorded.reports[0] ?? '')).toMatchObject({ schema: 1, complete: true });
  });

  test('status of a finished run says Ferretry is set up', async () => {
    const made = deps(new FakeDaemon([step('shells', 'nix', 'Shells', 80, 'done')]));
    await new OnboardController(made.deps).status({});
    expect(made.recorded.reports[0]).toStartWith('Ferretry is set up.');
  });

  test('reset forgets the answers and names the next command', async () => {
    const daemon = new FakeDaemon([step('shells', 'nix', 'Shells', 80, 'done')]);
    const made = deps(daemon);
    const code = await new OnboardController(made.deps).reset();
    expect(code).toBe(0);
    expect(daemon.resets).toBe(1);
    expect(daemon.steps[0]?.state).toBe('pending');
    expect(made.recorded.reports).toEqual(['The first run starts again. Run `fy onboard` to go through it.']);
  });

  test('reset that fails is exit 1 with the sentence', async () => {
    const daemon = new FakeDaemon([]);
    daemon.reset = async () => {
      throw new Error('refused');
    };
    const made = deps(daemon);
    expect(await new OnboardController(made.deps).reset()).toBe(1);
    expect(made.recorded.warnings).toEqual(['refused']);
  });
});
