import { describe, it } from 'bun:test';
import type { ConfigFilePutResult, ConfigFileView, FleetCredentialBudget } from '@ferretry/protocol';
import should from 'should';
import { budgetWords, editedBudget, parseLevel } from '../../../src/lib/credential/budget.ts';
import { registerCredentialCommands } from '../../../src/lib/credential/commands.ts';
import { renderCredentialList } from '../../../src/lib/credential/render.ts';
import { credential, type FakeWorld, fakeWorld, runCommand } from '../fleet/account-fakes.ts';

const LOGIN = '# the Liftoff seat, billed by use\nharness: claude\nstore: ferretry\nlabel: liftoff\n';

/** The daemon's config files: a write that raises or removes a limit comes back held, as the daemon does it. */
class FakeConfig {
  readonly files = new Map<string, string>();
  readonly writes: { path: string; text: string; ifMatch: string | undefined }[] = [];
  holdNext = false;

  constructor(files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) this.files.set(path, text);
  }

  async file(path: string): Promise<ConfigFileView> {
    const text = this.files.get(path);
    return {
      path,
      absolutePath: `/fy/config/${path}`,
      kind: path === 'machine.yaml' ? 'machine' : 'login',
      schema: path === 'machine.yaml' ? 'machine' : 'login',
      exists: text !== undefined,
      text: text ?? '',
      etag: text === undefined ? 'absent' : `etag-${String(text.length)}`,
      state: 'ok',
      issues: [],
    } as unknown as ConfigFileView;
  }

  async write(path: string, text: string, ifMatch: string | undefined): Promise<ConfigFilePutResult> {
    this.writes.push({ path, text, ifMatch });
    this.files.set(path, text);
    if (!this.holdNext) return { path, etag: 'new', outcome: 'applied' };
    this.holdNext = false;
    return {
      path,
      etag: 'new',
      outcome: 'pending',
      pending: {
        path,
        etag: 'new',
        changes: ['login "claude-liftoff"\'s daily trigger in dollars goes up from 40 to 80'],
      },
    };
  }
}

function worldWith(config: FakeConfig | undefined): FakeWorld {
  const world = fakeWorld();
  return { ...world, deps: { ...world.deps, ...(config === undefined ? {} : { config }) } };
}

const run = async (world: FakeWorld, ...argv: string[]) =>
  await runCommand(registerCredentialCommands, world, ['login', 'budget', ...argv]);

describe('fy login budget', () => {
  it('should show the budget the file has when given no levels', async () => {
    const config = new FakeConfig({
      'logins/claude-liftoff.yaml': `${LOGIN}budget:\n  daily:\n    trigger: 40\n    hard: 60\n`,
    });
    const world = worldWith(config);
    await run(world, 'claude-liftoff');
    should(world.out.text('report')).equal(
      'claude-liftoff: daily: trigger $40.00, hard $60.00. What it spent: `fz login check claude-liftoff`.',
    );
    const json = worldWith(config);
    await run(json, 'claude-liftoff', '--json');
    should(JSON.parse(json.out.text('report'))).eql({
      login: 'claude-liftoff',
      budget: { daily: { trigger: 40, hard: 60 } },
    });
    should(config.writes).eql([]);
  });

  it('should add a budget, keeping every other key and comment, through the checked write', async () => {
    const config = new FakeConfig({ 'logins/claude-liftoff.yaml': LOGIN });
    const world = worldWith(config);
    await run(world, 'claude-liftoff', '--daily-trigger', '40', '--daily-hard', '$60', '--weekly-hard', '200');
    should(config.writes).have.length(1);
    should(config.writes[0]?.ifMatch).equal(`etag-${String(LOGIN.length)}`);
    should(config.writes[0]?.text).equal(
      `${LOGIN}budget:\n  daily:\n    trigger: 40\n    hard: 60\n  weekly:\n    hard: 200\n`,
    );
    should(world.out.text('report')).equal(
      "claude-liftoff's budget is now daily: trigger $40.00, hard $60.00 · weekly: hard $200.00.",
    );
  });

  it('should say a raise is held for the owner and how they confirm it', async () => {
    const config = new FakeConfig({ 'logins/claude-liftoff.yaml': `${LOGIN}budget:\n  daily:\n    trigger: 40\n` });
    config.holdNext = true;
    const world = worldWith(config);
    await run(world, 'claude-liftoff', '--daily-trigger', '80', '--json');
    should(JSON.parse(world.out.text('report'))).eql({
      login: 'claude-liftoff',
      budget: { daily: { trigger: 80 } },
      outcome: 'pending',
    });
    const words = worldWith(
      new FakeConfig({ 'logins/claude-liftoff.yaml': `${LOGIN}budget:\n  daily:\n    trigger: 40\n` }),
    );
    (words.deps.config as FakeConfig).holdNext = true;
    await run(words, 'claude-liftoff', '--daily-trigger', '80');
    should(words.out.text('report')).match(/held for the owner \(login "claude-liftoff"'s daily trigger/u);
    should(words.out.text('report')).match(/`fz config confirm logins\/claude-liftoff\.yaml`/u);
  });

  it('should take a level off with "off", the whole budget off with --clear, and say when nothing changes', async () => {
    const config = new FakeConfig({
      'logins/claude-liftoff.yaml': `${LOGIN}budget:\n  daily:\n    trigger: 40\n    hard: 60\n`,
    });
    const world = worldWith(config);
    await run(world, 'claude-liftoff', '--daily-hard', 'off');
    should(config.files.get('logins/claude-liftoff.yaml')).equal(`${LOGIN}budget:\n  daily:\n    trigger: 40\n`);
    await run(world, 'claude-liftoff', '--clear');
    should(config.files.get('logins/claude-liftoff.yaml')).equal(LOGIN);
    const same = worldWith(config);
    await run(same, 'claude-liftoff', '--daily-trigger', 'off');
    should(same.out.text('report')).equal("claude-liftoff's budget is already no budget.");
  });

  it('should set the time zone in machine.yaml, and change nothing on a dry run', async () => {
    const config = new FakeConfig({ 'logins/claude-liftoff.yaml': LOGIN });
    const dry = worldWith(config);
    await run(dry, 'claude-liftoff', '--daily-trigger', '40', '--time-zone', 'America/Los_Angeles', '--dry-run');
    should(config.writes).eql([]);
    should(dry.out.text('report')).equal(
      "Would set claude-liftoff's budget to daily: trigger $40.00.\nWould count budgets in America/Los_Angeles.",
    );
    const world = worldWith(config);
    await run(world, 'claude-liftoff', '--time-zone', 'America/Los_Angeles', '--json');
    should(config.files.get('machine.yaml')).equal('timeZone: America/Los_Angeles\n');
    should(JSON.parse(world.out.text('report'))).match({ timeZone: 'America/Los_Angeles', timeZoneOutcome: 'applied' });
    const words = worldWith(config);
    await run(words, 'claude-liftoff', '--time-zone', 'UTC');
    should(words.out.text('report')).match(/Budgets now count days in UTC\./u);
  });

  it('should refuse what the file would refuse, and a login that is not there', async () => {
    const config = new FakeConfig({ 'logins/claude-liftoff.yaml': LOGIN, 'logins/broken.yaml': 'harness: nope\n' });
    const refusal = async (...argv: string[]): Promise<string> => {
      try {
        await run(worldWith(config), ...argv);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return 'no refusal';
    };
    should(await refusal('claude-liftoff', '--daily-trigger', '60', '--daily-hard', '40')).match(
      /not valid: the hard limit \(\$40\) must not be below the trigger \(\$60\)/u,
    );
    should(await refusal('claude-liftoff', '--daily-trigger', 'lots')).match(/--daily-trigger takes a dollar amount/u);
    should(await refusal('claude-liftoff', '--weekly-hard', '-3')).match(/--weekly-hard takes/u);
    should(await refusal('claude-liftoff', '--clear', '--weekly-trigger', '5')).match(
      /--clear removes the whole budget/u,
    );
    should(await refusal('claude-liftoff', '--time-zone', 'Mars/Base')).match(/not a time zone/u);
    should(await refusal('nobody', '--daily-trigger', '5')).equal('No login "nobody" on this machine.');
    should(await refusal('broken', '--daily-trigger', '5')).match(/logins\/broken\.yaml does not check/u);
    let unwired = 'no refusal';
    await run(worldWith(undefined), 'claude-liftoff').catch((error: Error) => {
      unwired = error.message;
    });
    should(unwired).equal('This build cannot reach the configuration files.');
  });
});

describe('budget helpers', () => {
  it('should merge levels into the budget there is, and word it', () => {
    should(editedBudget(undefined, {})).be.undefined();
    should(editedBudget({ daily: { trigger: 40 } }, { weeklyTrigger: 100, dailyTrigger: 'off' })).eql({
      weekly: { trigger: 100 },
    });
    should(budgetWords(undefined)).equal('no budget');
    should(parseLevel('daily-hard', 'OFF')).equal('off');
  });
});

describe('the budget lines under a login', () => {
  const period = { spentUsd: 41.2, startsAt: '2026-10-30T00:00:00.000Z', resetsAt: '2026-10-31T07:00:00.000Z' };
  const budget = (overrides: Partial<FleetCredentialBudget>): FleetCredentialBudget => ({
    timeZone: 'America/Los_Angeles',
    timeZoneSet: true,
    daily: { trigger: 40, hard: 60, level: 'over_trigger', ...period },
    level: 'over_trigger',
    unpriced: 0,
    measured: true,
    ...overrides,
  });
  const list = (value: FleetCredentialBudget) =>
    renderCredentialList(
      { format: 2, machine: 'liftoff-ec2', credentials: [credential({ id: 'claude-liftoff', budget: value })] },
      'fz',
    );

  it('should say what was spent on this machine against which limits, and what holds the login', () => {
    const over = list(budget({}));
    should(over).match(
      /Budget, spent on this machine only \(America\/Los_Angeles\): today \$41\.20 of \$40\.00 trigger, \$60\.00 hard/u,
    );
    should(over).match(
      /Over its trigger: nothing new starts on it until Sat 00:00; ferrets already on it keep running\./u,
    );

    const hard = list(
      budget({
        daily: undefined,
        weekly: { hard: 40, level: 'over_hard', ...period },
        level: 'over_hard',
        timeZoneSet: false,
        unpriced: 3,
        measured: false,
        partial: true,
      }),
    );
    should(hard).match(/America\/Los_Angeles, the host’s zone\): this week \$41\.20 of \$40\.00 hard/u);
    should(hard).match(/Not measured yet/u);
    should(hard).match(/Partial: a transcript is too large to read back/u);
    should(hard).match(/3 request\(s\) used a model with no price/u);
    should(hard).match(/Over its hard limit: its ferrets were stopped .* `fz migrate <id> -a <runtime>`/u);

    const ok = list(budget({ daily: { trigger: 40, level: 'ok', ...period, spentUsd: 1 }, level: 'ok' }));
    should(ok).not.match(/Over its/u);
  });
});
