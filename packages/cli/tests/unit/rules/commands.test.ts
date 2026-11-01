import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerRulesCommands } from '../../../src/lib/rules/commands';
import type { RulesController } from '../../../src/lib/rules/controller';

function run(argv: string[]) {
  const reached: unknown[] = [];
  const record =
    (verb: string) =>
    async (...args: unknown[]): Promise<void> =>
      void reached.push([verb, ...args]);
  const controller = {
    list: record('list'),
    add: record('add'),
    resume: record('resume'),
    renew: record('renew'),
    narrow: record('narrow'),
    remove: record('remove'),
  } as unknown as RulesController;
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRulesCommands(program, controller);
  return { reached, parsed: program.parseAsync(['node', 'fy', ...argv]) };
}

describe('fy rules commands', () => {
  it('should reach each verb with its flags and arguments', async () => {
    const lines = [
      ['rules', 'ls', '--json'],
      ['rules', 'add', 'si_1', '--username', '--totp', '--i-understand-one-factor', '--expires', '7d', '--open'],
      ['rules', 'resume', 'sr_a'],
      ['rules', 'renew', 'sr_a', '--expires', '2d'],
      ['rules', 'narrow', 'sr_a', '--drop-totp', '--uses', '2'],
      ['rules', 'rm', 'sr_a'],
    ];
    const seen: unknown[] = [];
    for (const line of lines) {
      const { reached, parsed } = run(line);
      await parsed;
      seen.push(...reached);
    }
    const verbs = seen.map(entry => (entry as unknown[])[0]);
    should(verbs).eql(['list', 'add', 'resume', 'renew', 'narrow', 'remove']);
    should((seen[1] as unknown[])[1]).equal('si_1');
    should((seen[1] as unknown[])[2]).containEql({
      username: true,
      totp: true,
      iUnderstandOneFactor: true,
      expires: '7d',
      open: true,
    });
    should((seen[4] as unknown[])[2]).containEql({ dropTotp: true, uses: '2' });
  });

  it('should have no commit verb', async () => {
    const { parsed } = run(['rules', 'commit', 'srs_a']);
    await parsed.then(
      () => should.fail('', '', 'a commit verb exists'),
      () => undefined,
    );
  });
});
