import { describe, it } from 'bun:test';
import should from 'should';
import { SIGN_IN_RULE_HONEST_LIMIT, SIGN_IN_RULE_ROOT_WARNING, SIGN_IN_RULES_SCREEN_PATH } from '../../../../contract/routes/index.ts';
import { RULES_HELP, rulesVerbs } from '../../../../cli/lib/rules/commands.ts';
import type { RulesController } from '../../../../cli/lib/rules/controller.ts';
import manifest from '../../../../manifest.ts';

function rig(fail?: Error) {
  const reached: unknown[][] = [];
  const errors: string[] = [];
  const record =
    (verb: string) =>
    async (...args: unknown[]): Promise<void> => {
      reached.push([verb, ...args]);
      if (fail !== undefined) throw fail;
    };
  const controller = {
    list: record('list'),
    add: record('add'),
    resume: record('resume'),
    renew: record('renew'),
    widen: record('widen'),
    narrow: record('narrow'),
    remove: record('remove'),
  } as unknown as RulesController;
  return { reached, errors, verbs: rulesVerbs(controller, { err: text => void errors.push(text) }) };
}

describe('fy rules verbs', () => {
  it('should reach each verb with its flags and arguments', async () => {
    const { reached, verbs } = rig();
    should(await verbs['rules ls']({ args: [], options: { json: true } })).equal(0);
    await verbs['rules add']({
      args: ['si_1'],
      options: { username: true, totp: true, 'i-understand-one-factor': true, expires: '7d', open: true },
    });
    await verbs['rules resume']({ args: ['sr_a'], options: {} });
    await verbs['rules renew']({ args: ['sr_a'], options: { expires: '2d' } });
    await verbs['rules narrow']({ args: ['sr_a'], options: { dropTotp: true, uses: '2' } });
    await verbs['rules rm']({ args: ['sr_a'], options: {} });
    should(reached.map(entry => entry[0])).eql(['list', 'add', 'resume', 'renew', 'narrow', 'remove']);
    should(reached[0]?.[1]).eql({ json: true });
    should(reached[1]?.[1]).equal('si_1');
    should(reached[1]?.[2]).containEql({
      username: true,
      totp: true,
      iUnderstandOneFactor: true,
      expires: '7d',
      open: true,
    });
    should(reached[4]?.[2]).containEql({ dropTotp: true, uses: '2' });
    should(reached[5]?.[1]).equal('sr_a');
  });

  it('should reach widen with its terms, renew with a cap, and rm for an account', async () => {
    const { reached, verbs } = rig();
    await verbs['rules widen']({
      args: ['sr_a'],
      options: { username: true, totp: true, iUnderstandOneFactor: true, scope: 'any', uses: '9' },
    });
    await verbs['rules renew']({ args: ['sr_a'], options: { uses: '3' } });
    await verbs['rules rm']({ args: [], options: { account: 'GITHUB_WORK', json: true } });
    should(reached.map(entry => entry[0])).eql(['widen', 'renew', 'remove']);
    should(reached[0]?.[2]).containEql({ username: true, totp: true, iUnderstandOneFactor: true, scope: 'any', uses: '9' });
    should(reached[1]?.[2]).containEql({ uses: '3' });
    should(reached[2]?.[1]).be.undefined();
    should(reached[2]?.[2]).containEql({ account: 'GITHUB_WORK', json: true });
  });

  it('should say a refusal as its sentence and exit 1', async () => {
    const { errors, verbs } = rig(new Error("this is the owner's command; a ferret's pane can't run it"));
    should(await verbs['rules add']({ args: ['si_1'], options: {} })).equal(1);
    should(errors).eql(["this is the owner's command; a ferret's pane can't run it"]);
  });

  it('S132 should have no commit verb, here or in the manifest', () => {
    const { verbs } = rig();
    should(Object.keys(verbs).filter(verb => verb.includes('commit'))).eql([]);
    const declared = manifest.actions.cli.map(verb => verb.verb as string).filter(verb => verb.startsWith('rules '));
    should([...declared].sort()).eql(Object.keys(verbs).sort());
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

});
