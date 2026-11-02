import { describe, it } from 'bun:test';
import { AUTOMATED_CODE_ACK_WORDS, AUTOMATED_CODE_WARNING, TASK_PLAN_HONEST_LIMIT } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerCopyCommands } from '../../../src/lib/plan/commands';
import type { CopyController } from '../../../src/lib/plan/controller';
import type { PlanController } from '../../../src/lib/plan/plan-controller';

/** A controller that records which verb each command line reached, and with what. */
function run(argv: string[]) {
  const reached: unknown[] = [];
  const record =
    (verb: string) =>
    async (...args: unknown[]): Promise<void> =>
      void reached.push([verb, ...args]);
  const controller = {
    list: record('list'),
    rules: record('rules'),
    addRule: record('addRule'),
    removeRule: record('removeRule'),
    profile: record('profile'),
  } as unknown as CopyController;
  const plans = {
    list: record('plan.list'),
    approve: record('plan.approve'),
    revoke: record('plan.revoke'),
  } as unknown as PlanController;
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerCopyCommands(program, controller, plans);
  return { reached, parsed: program.parseAsync(['node', 'fy', ...argv]) };
}

describe('fy copy commands', () => {
  it('should reach each verb with its flags and arguments', async () => {
    const lines = [
      ['copy', 'ls', '--session', 's1', '--json'],
      ['copy', 'rules', 'ls'],
      ['copy', 'rules', 'add', '--from', 'command:gh', '--to', 'terminal:vercel', '--count', '2', '--expires', '2h'],
      ['copy', 'rules', 'rm', 'a1b2'],
      ['copy', 'rules', 'profile', 'on', '--json'],
      ['copy', 'plan', 'ls', '--session', 's1'],
      ['copy', 'plan', 'approve', 'feed', '1', '3'],
      ['plan', 'ls', '--json'],
      [
        'plan',
        'approve',
        'feed',
        '1',
        '3',
        '--pick',
        '3=GITHUB_WORK',
        '--pick',
        '1=si_0123456789abcdef',
        '--totp',
        '1',
        '--i-understand-one-factor',
      ],
      ['plan', 'revoke', 'feed', '2'],
      ['plan', 'revoke', 'feed'],
    ];
    const reached: unknown[] = [];
    for (const line of lines) {
      const ran = run(line);
      await ran.parsed;
      reached.push(...ran.reached);
    }

    should(reached).match([
      ['list', { session: 's1', json: true }],
      ['rules', {}],
      ['addRule', { from: 'command:gh', to: 'terminal:vercel', count: '2', expires: '2h' }],
      ['removeRule', 'a1b2', {}],
      ['profile', 'on', { json: true }],
      ['plan.list', { session: 's1' }],
      ['plan.approve', 'feed', ['1', '3'], { pick: [], totp: [] }],
      ['plan.list', { json: true }],
      [
        'plan.approve',
        'feed',
        ['1', '3'],
        { pick: ['3=GITHUB_WORK', '1=si_0123456789abcdef'], totp: ['1'], iUnderstandOneFactor: true },
      ],
      ['plan.revoke', 'feed', ['2'], {}],
      ['plan.revoke', 'feed', [], {}],
    ]);
  });

  it('should put the honest limit and the one-factor flag in the plan help, and say paste rule in the copy help', () => {
    const program = new Command().name('fy').exitOverride();
    registerCopyCommands(program, {} as CopyController, {} as PlanController);
    const help = (name: string): string => {
      const chunks: string[] = [];
      const command = program.commands.find(each => each.name() === name);
      command?.configureOutput({ writeOut: chunk => void chunks.push(chunk), writeErr: () => {} });
      command?.outputHelp();
      return chunks.join('');
    };
    const approve = program.commands
      .find(each => each.name() === 'plan')
      ?.commands.find(each => each.name() === 'approve');
    const ack = approve?.options.find(option => option.long === '--i-understand-one-factor');

    should(help('plan')).containEql(TASK_PLAN_HONEST_LIMIT);
    should(help('plan')).containEql('[--totp 1 --i-understand-one-factor]');
    should(help('plan')).containEql(AUTOMATED_CODE_WARNING);
    should(help('plan')).not.containEql('goes around Ferretry');
    should(ack?.description).equal(AUTOMATED_CODE_ACK_WORDS);
    should(help('copy')).containEql('rules profile on|off');
    should(help('copy')).containEql('your paste rules');
    should(help('copy')).not.containEql('the routes you approved in advance');
  });

  it('should refuse a rule without its route before reaching the controller', async () => {
    const ran = run(['copy', 'rules', 'add', '--from', 'command:gh']);

    should(
      await ran.parsed.then(
        () => 'ran',
        () => 'refused',
      ),
    ).equal('refused');
    should(ran.reached).eql([]);
  });
});
