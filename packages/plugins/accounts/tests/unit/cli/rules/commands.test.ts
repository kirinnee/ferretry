import { describe, it } from 'bun:test';
import { SIGN_IN_RULE_HONEST_LIMIT, SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULES_SCREEN_PATH } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { RULES_HELP, registerRulesCommands } from '../../../src/lib/rules/commands';
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
    widen: record('widen'),
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

  it('should reach widen with its terms, renew with a cap, and take revoke as rm', async () => {
    const lines = [
      ['rules', 'widen', 'sr_a', '--username', '--totp', '--i-understand-one-factor', '--scope', 'any', '--uses', '9'],
      ['rules', 'renew', 'sr_a', '--uses', '3'],
      ['rules', 'revoke', 'sr_a'],
      ['rules', 'revoke', '--account', 'GITHUB_WORK', '--json'],
    ];
    const seen: unknown[][] = [];
    for (const line of lines) {
      const { reached, parsed } = run(line);
      await parsed;
      seen.push(...(reached as unknown[][]));
    }
    should(seen.map(entry => entry[0])).eql(['widen', 'renew', 'remove', 'remove']);
    should(seen[0]?.[1]).equal('sr_a');
    should(seen[0]?.[2]).containEql({
      username: true,
      totp: true,
      iUnderstandOneFactor: true,
      scope: 'any',
      uses: '9',
    });
    should(seen[1]?.[2]).containEql({ uses: '3' });
    should(seen[2]?.[1]).equal('sr_a');
    should(seen[3]?.[2]).containEql({ account: 'GITHUB_WORK', json: true });
  });

  it("should quote the protocol's honest limit, root line and screen path in the help, and name the code flags", () => {
    should(RULES_HELP).containEql(SIGN_IN_RULE_HONEST_LIMIT);
    should(RULES_HELP).containEql(SIGN_IN_RULE_ROOT_WARNING);
    should(RULES_HELP).containEql(SIGN_IN_RULES_SCREEN_PATH);
    should(RULES_HELP).containEql('fy account site ls').and.not.containEql('fy accounts');
    should(RULES_HELP).not.containEql('stopped');
    for (const verb of ['add', 'resume', 'renew', 'widen'])
      should(RULES_HELP.split('\n').find(line => line.trimStart().startsWith(`${verb} `))).containEql(
        '[--totp --i-understand-one-factor]',
      );
  });

  it('should have no commit verb', async () => {
    const { parsed } = run(['rules', 'commit', 'srs_a']);
    await parsed.then(
      () => should.fail('', '', 'a commit verb exists'),
      () => undefined,
    );
  });
});
