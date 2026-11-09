import { describe, it } from 'bun:test';
import type { VerbHandler } from '@ferretry/kernel/manifest';
import should from 'should';
import { type AccountControllers, accountVerbs } from '../../../cli/lib/commands.ts';
import { ExitStatus } from '../../../cli/shell.ts';
import manifest from '../../../manifest.ts';

type Options = Record<string, string | boolean | readonly string[]>;

/** Controllers that record `[group.method, ...args]` and fail with `fail` when it is given. */
function rig(fail?: Error) {
  const reached: unknown[][] = [];
  const errors: string[] = [];
  const exit = new ExitStatus();
  const group = (name: string, methods: readonly string[]) =>
    Object.fromEntries(
      methods.map(method => [
        method,
        async (...args: unknown[]): Promise<void> => {
          reached.push([`${name}.${method}`, ...args]);
          if (fail !== undefined) throw fail;
        },
      ]),
    );
  const controllers = {
    accounts: group('accounts', [
      'list',
      'add',
      'edit',
      'rename',
      'remove',
      'merge',
      'apart',
      'lookAlike',
      'hint',
      'defaultSet',
      'defaultRemove',
    ]),
    signIns: group('signIns', [
      'list',
      'add',
      'edit',
      'remove',
      'recipeShow',
      'recipeSet',
      'recipeClear',
      'recipeDecide',
    ]),
    factorKeys: group('factorKeys', ['list', 'add', 'remove']),
    seeds: group('seeds', ['add']),
  } as unknown as AccountControllers;
  return {
    reached,
    errors,
    exit,
    verbs: accountVerbs(() => controllers, { err: text => void errors.push(text) }, exit),
  };
}

async function run(verbs: Readonly<Record<string, VerbHandler>>, verb: string, args: string[], options: Options = {}) {
  const handler = verbs[verb];
  if (handler === undefined) throw new Error(`no verb ${verb}`);
  return await handler({ args, options });
}

describe('fy account verbs', () => {
  it('should reach the account controller with the arguments and flags each verb takes', async () => {
    const { reached, verbs } = rig();
    should(await run(verbs, 'account ls', [], { json: true })).equal(0);
    await run(verbs, 'account add', ['SUDO_KIRIN_BOX'], {
      label: 'sudo',
      username: 'kirin',
      domain: ['github.com', 'gist.github.com'],
      for: ['npmjs.com'],
      tool: 'sudo',
      host: 'box',
      dest: 'elsewhere',
      method: 'google',
      'sso-name': 'Okta',
      via: 'GOOGLE_KIRIN',
      password: false,
    });
    await run(verbs, 'account edit', ['GITHUB_WORK'], { label: 'x', username: false, password: true });
    await run(verbs, 'account rename', ['GITHUB_WORK', 'GITHUB_JOB']);
    await run(verbs, 'account rm', ['GITHUB_WORK'], { y: true });
    await run(verbs, 'account merge', ['GITHUB_WORK', 'GITHUB_HOME'], { yes: true });
    await run(verbs, 'account apart', ['GITHUB_WORK', 'GITHUB_HOME']);
    await run(verbs, 'account look-alike', [], { json: true });
    await run(verbs, 'account hint', ['github.com'], { json: true });
    await run(verbs, 'account default set', ['github.com', 'GITHUB_WORK'], { project: 'ferretry' });
    await run(verbs, 'account default rm', ['github.com'], { folder: '~/scratch' });

    should(reached.map(entry => entry[0])).eql([
      'accounts.list',
      'accounts.add',
      'accounts.edit',
      'accounts.rename',
      'accounts.remove',
      'accounts.merge',
      'accounts.apart',
      'accounts.lookAlike',
      'accounts.hint',
      'accounts.defaultSet',
      'accounts.defaultRemove',
    ]);
    should(reached[0]?.[1]).eql({ json: true });
    should(reached[1]?.[1]).equal('SUDO_KIRIN_BOX');
    should(reached[1]?.[2]).eql({
      label: 'sudo',
      username: 'kirin',
      domain: ['github.com', 'gist.github.com'],
      for: ['npmjs.com'],
      tool: 'sudo',
      host: 'box',
      dest: 'elsewhere',
      method: 'google',
      ssoName: 'Okta',
      via: 'GOOGLE_KIRIN',
      password: false,
    });
    should(reached[2]).eql(['accounts.edit', 'GITHUB_WORK', { label: 'x', username: false, password: true }]);
    should(reached[3]).eql(['accounts.rename', 'GITHUB_WORK', 'GITHUB_JOB']);
    should(reached[4]).eql(['accounts.remove', 'GITHUB_WORK', { yes: true }]);
    should(reached[5]).eql(['accounts.merge', 'GITHUB_WORK', 'GITHUB_HOME', { yes: true }]);
    should(reached[6]).eql(['accounts.apart', 'GITHUB_WORK', 'GITHUB_HOME']);
    should(reached[7]).eql(['accounts.lookAlike', { json: true }]);
    should(reached[8]).eql(['accounts.hint', 'github.com', { json: true }]);
    should(reached[9]).eql(['accounts.defaultSet', 'github.com', 'GITHUB_WORK', { project: 'ferretry' }]);
    should(reached[10]).eql(['accounts.defaultRemove', 'github.com', { folder: '~/scratch' }]);
  });

  it('should reach the sign-in controller with the arguments and flags each verb takes', async () => {
    const { reached, verbs } = rig();
    await run(verbs, 'account site ls', [], { json: true });
    await run(verbs, 'account site ls', ['GITHUB_WORK']);
    await run(verbs, 'account site add', ['GITHUB_WORK'], {
      domain: ['github.com'],
      for: ['npmjs.com'],
      method: 'sso',
      'sso-name': 'Okta',
      'auto-apply-recipe': 'on',
    });
    await run(verbs, 'account site edit', ['si_1'], { via: false, tool: 'ssh', host: 'laptop', dest: 'box' });
    await run(verbs, 'account site rm', ['si_1'], { yes: true });
    await run(verbs, 'account site recipe show', ['si_1'], { json: true });
    await run(verbs, 'account site recipe set', ['si_1'], { file: 'steps.md' });
    await run(verbs, 'account site recipe clear', ['si_1']);
    await run(verbs, 'account site recipe approve', ['si_1', 'rp_1']);
    await run(verbs, 'account site recipe decline', ['si_1', 'rp_1']);

    should(reached).eql([
      ['signIns.list', undefined, { json: true }],
      ['signIns.list', 'GITHUB_WORK', {}],
      [
        'signIns.add',
        'GITHUB_WORK',
        { domain: ['github.com'], for: ['npmjs.com'], method: 'sso', ssoName: 'Okta', autoApplyRecipe: 'on' },
      ],
      ['signIns.edit', 'si_1', { via: false, tool: 'ssh', host: 'laptop', dest: 'box' }],
      ['signIns.remove', 'si_1', { yes: true }],
      ['signIns.recipeShow', 'si_1', { json: true }],
      ['signIns.recipeSet', 'si_1', { file: 'steps.md' }],
      ['signIns.recipeClear', 'si_1'],
      ['signIns.recipeDecide', 'si_1', 'rp_1', 'approve'],
      ['signIns.recipeDecide', 'si_1', 'rp_1', 'decline'],
    ]);
  });

  it('should reach the 2FA key controller, and the seed controller only for --totp', async () => {
    const { reached, verbs } = rig();
    await run(verbs, 'account factor ls', [], { json: true });
    await run(verbs, 'account factor ls', ['GITHUB_HOME']);
    await run(verbs, 'account factor add', ['GITHUB_WORK'], { sms: true, label: 'text', 'ends-with': '42' });
    await run(verbs, 'account factor add', ['GITHUB_WORK'], {
      totp: true,
      label: 'authy',
      s: 'inside',
      'i-understand-totp': true,
    });
    await run(verbs, 'account factor rm', ['GITHUB_HOME', 'tf_1'], { y: true });

    should(reached).eql([
      ['factorKeys.list', undefined, { json: true }],
      ['factorKeys.list', 'GITHUB_HOME', {}],
      ['factorKeys.add', 'GITHUB_WORK', { sms: true, label: 'text', endsWith: '42' }],
      ['seeds.add', 'GITHUB_WORK', { totp: true, label: 'authy', session: 'inside', iUnderstandTotp: true }],
      ['factorKeys.remove', 'GITHUB_HOME', 'tf_1', { yes: true }],
    ]);
  });

  it('should refuse --totp combined with another kind, and reach neither controller', async () => {
    const { reached, errors, verbs } = rig();
    for (const other of ['authenticator', 'sms', 'email', 'push', 'security-key']) {
      should(await run(verbs, 'account factor add', ['GITHUB_WORK'], { totp: true, [other]: true })).equal(1);
    }
    should(reached).eql([]);
    should(errors).have.length(5);
    should(errors[0]).equal('error: --totp is a kind of its own: do not combine it with another kind\n');
  });

  it('should say a controller refusal as commander did, and exit 1', async () => {
    const { errors, verbs } = rig(new Error('no account NOPE'));
    should(await run(verbs, 'account rm', ['NOPE'], { yes: true })).equal(1);
    should(errors).eql(['error: no account NOPE\n']);
  });

  it("should refuse words a verb doesn't take with commander's sentences, and reach no controller", async () => {
    const { reached, errors, verbs } = rig();
    should(await run(verbs, 'account add', ['A_B'], {})).equal(1);
    should(await run(verbs, 'account ls', ['extra'], {})).equal(1);
    should(await run(verbs, 'account rename', ['A_B'], {})).equal(1);
    should(await run(verbs, 'account rm', ['A_B'], { force: true })).equal(1);
    should(errors).eql([
      "error: required option '--label' not specified\n",
      "error: too many arguments for 'ls'. Expected 0 arguments but got 1.\n",
      "error: missing required argument 'new-id'\n",
      "error: unknown option '--force'\n",
    ]);
    should(reached).eql([]);
  });

  it('should answer the exit status a controller set', async () => {
    const { exit, verbs } = rig();
    exit.setExitCode(3);
    should(await run(verbs, 'account ls', [])).equal(3);
  });

  it('should declare exactly the verbs the manifest declares under fy account', () => {
    const { verbs } = rig();
    const declared = manifest.actions.cli.map(verb => verb.verb as string).filter(verb => verb.startsWith('account '));
    should([...declared].sort()).eql(Object.keys(verbs).sort());
  });
});
