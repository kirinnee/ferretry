import { describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { Command } from 'commander';
import should from 'should';
import {
  type AccountControllers,
  registerAccountCommands,
  registerLoginEntryCommands,
} from '../../../src/lib/secrets/account-commands';
import {
  BOX_SIGN_IN,
  FakePrompt,
  GITHUB_SIGN_IN,
  LIST,
  refusal,
  rig,
  SI_GITHUB,
  SI_TERMINAL,
  TF_AUTO,
  TF_SMS,
} from './account-rig';

const PASSWORD = 'correct-horse-battery';
const PROPOSAL = 'rp_0123456789abcdef';

describe('fy account ls', () => {
  it('should list accounts with their sign-in and 2FA key ids, and print no value', async () => {
    // Arrange
    const { run, messages } = rig();

    // Act
    await run('account', 'ls');

    // Assert
    const text = messages.join('\n');
    should(text).containEql('GitHub  [GITHUB]');
    should(text).containEql(SI_GITHUB);
    should(text).containEql(TF_AUTO);
    should(text).containEql('terminal sudo@box');
  });

  it('should list when no verb is given, and print the protocol document with --json', async () => {
    // Arrange
    const bare = rig();
    const json = rig();

    // Act
    await bare.run('account');
    await json.run('account', 'ls', '--json');

    // Assert
    should(bare.gateway.ops()).deepEqual(['list']);
    should(JSON.parse(json.messages[0] ?? '{}').accounts).have.length(2);
  });

  it('should say a damaged store is NOT gone instead of listing nothing', async () => {
    // Arrange
    const { run, messages } = rig({
      list: { v: 1, health: 'damaged', diagnosis: 'bad seal', accounts: [], signIns: [] },
    });

    // Act
    await run('account', 'ls');

    // Assert
    should(messages[0]).containEql('NOT gone');
  });
});

describe('fy account add', () => {
  it('should take the password at a hidden prompt, save the account, and add the first sign-in', async () => {
    // Arrange
    const { run, gateway, prompt, messages } = rig();

    // Act
    await run('account', 'add', 'NEW_ONE', '--label', 'New one', '--domain', 'gitlab.com', '--for', 'gitlab.com');

    // Assert
    should(prompt.hidden).have.length(1);
    should(gateway.ops()).deepEqual(['list', 'putAccount', 'addSignIn']);
    should(gateway.last('putAccount')).deepEqual(['NEW_ONE', { label: 'New one', password: PASSWORD }]);
    should(gateway.last('addSignIn')[1]).deepEqual({
      place: { kind: 'site', domains: ['gitlab.com'], match: ['gitlab.com'] },
    });
    should(messages.join('\n')).not.containEql(PASSWORD);
  });

  it('should save an account with no password, and say it has no sign-in yet', async () => {
    // Arrange
    const { run, gateway, prompt, messages } = rig();

    // Act
    await run('account', 'add', 'NEW_ONE', '--label', 'New one', '--no-password');

    // Assert
    should(prompt.hidden).have.length(0);
    should(gateway.last('putAccount')).deepEqual(['NEW_ONE', { label: 'New one' }]);
    should(messages.join('\n')).containEql('no sign-in yet');
  });

  it('should refuse an existing handle, a bad handle, a method with no place, and a piped password', async () => {
    // Arrange
    const piped = rig({ interactive: false });

    // Act
    const exists = await refusal(() => rig().run('account', 'add', 'GITHUB', '--label', 'x'));
    const bad = await refusal(() => rig().run('account', 'add', 'lower', '--label', 'x'));
    const noPlace = await refusal(() => rig().run('account', 'add', 'NEW_ONE', '--label', 'x', '--method', 'google'));
    const noTerminal = await refusal(() => piped.run('account', 'add', 'NEW_ONE', '--label', 'x'));

    // Assert
    should(exists).containEql('already exists');
    should(bad).containEql('account handle');
    should(noPlace).containEql('needs a place');
    should(noTerminal).containEql('terminal');
    should(piped.gateway.ops().includes('putAccount')).be.false();
  });

  it('should say the account was saved when its sign-in is refused', async () => {
    // Arrange
    const { run, gateway } = rig();
    gateway.failures.set('addSignIn', new Error('the daemon says no'));

    // Act
    const message = await refusal(() => run('account', 'add', 'NEW_ONE', '--label', 'x', '--domain', 'a.com'));

    // Assert
    should(message).containEql('NEW_ONE was saved, but its sign-in was not');
  });
});

describe('fy account edit | rename | rm', () => {
  it('should change only the fields named, and remove a username with --no-username', async () => {
    // Arrange
    const label = rig();
    const none = rig();

    // Act
    await label.run('account', 'edit', 'GITHUB', '--label', 'GH');
    await none.run('account', 'edit', 'GITHUB', '--no-username');

    // Assert
    should(label.gateway.last('putAccount')).deepEqual(['GITHUB', { label: 'GH' }]);
    should(none.gateway.last('putAccount')).deepEqual(['GITHUB', { username: null }]);
  });

  it('should read a new password hidden, and point --totp at the confirm-in-app flow', async () => {
    // Arrange
    const pass = rig();

    // Act
    await pass.run('account', 'edit', 'GITHUB', '--password');
    const totp = await refusal(() => rig().run('account', 'edit', 'GITHUB', '--totp'));
    const nothing = await refusal(() => rig().run('account', 'edit', 'GITHUB'));

    // Assert
    should(pass.gateway.last('putAccount')).deepEqual(['GITHUB', { password: PASSWORD }]);
    should(totp).containEql('factor add GITHUB --totp');
    should(nothing).containEql('nothing to change');
  });

  it('should rename a handle', async () => {
    // Arrange
    const { run, gateway } = rig();

    // Act
    await run('account', 'rename', 'GITHUB', 'GH_MAIN');

    // Assert
    should(gateway.last('renameAccount')).deepEqual(['GITHUB', 'GH_MAIN']);
  });

  it('should say what goes with an account before it asks, and delete only on yes', async () => {
    // Arrange
    const yes = rig();
    const no = rig({ prompt: new FakePrompt([], ['no']) });
    const skip = rig();

    // Act
    await yes.run('account', 'rm', 'GITHUB');
    await no.run('account', 'rm', 'GITHUB');
    await skip.run('account', 'rm', 'GITHUB', '--yes');

    // Assert
    should(yes.prompt.asked[0]).containEql('1 sign-in and 2 2FA keys');
    should(yes.gateway.ops()).containEql('removeAccount');
    should(no.gateway.ops()).not.containEql('removeAccount');
    should(skip.prompt.asked).have.length(0);
    should(skip.gateway.ops()).containEql('removeAccount');
  });

  it('should refuse an account that is not there, and a piped delete without --yes', async () => {
    // Arrange + Act
    const missing = await refusal(() => rig().run('account', 'rm', 'NOPE'));
    const piped = await refusal(() => rig({ interactive: false }).run('account', 'rm', 'GITHUB'));

    // Assert
    should(missing).containEql('no account NOPE');
    should(piped).containEql('--yes');
  });
});

describe('fy account merge | apart | look-alike | hint', () => {
  it('should merge FROM into KEEP after a yes, and not on a no', async () => {
    // Arrange
    const yes = rig();
    const no = rig({ prompt: new FakePrompt([], ['no']) });

    // Act
    await yes.run('account', 'merge', 'GITHUB', 'SUDO_BOX');
    await no.run('account', 'merge', 'GITHUB', 'SUDO_BOX');
    const same = await refusal(() => rig().run('account', 'merge', 'GITHUB', 'GITHUB'));

    // Assert
    should(yes.gateway.last('merge')).deepEqual(['GITHUB', 'SUDO_BOX']);
    should(no.gateway.ops()).not.containEql('merge');
    should(same).containEql('two different accounts');
  });

  it('should keep two accounts apart', async () => {
    // Arrange
    const { run, gateway } = rig();

    // Act
    await run('account', 'apart', 'GITHUB', 'SUDO_BOX');

    // Assert
    should(gateway.last('apart')).deepEqual(['GITHUB', 'SUDO_BOX']);
  });

  it('should list look-alike groups by handle only', async () => {
    // Arrange
    const { run, messages } = rig();

    // Act
    await run('account', 'look-alike');

    // Assert
    should(messages[0]).containEql('GITHUB, SUDO_BOX');
  });

  it('should ask for the hint of a site, given a host or a URL', async () => {
    // Arrange
    const host = rig();
    const url = rig();

    // Act
    await host.run('account', 'hint', 'github.com');
    await url.run('account', 'hint', 'https://github.com/kirinnee');
    const bad = await refusal(() => rig().run('account', 'hint', 'not a site'));

    // Assert
    should(host.gateway.last('hint')).deepEqual(['github.com']);
    should(url.gateway.last('hint')).deepEqual(['github.com']);
    should(bad).containEql('not a site');
  });
});

describe('fy account default', () => {
  it('should star an account for a site, a project or a folder through the owner route', async () => {
    // Arrange
    const site = rig();
    const project = rig();
    const folder = rig();

    // Act
    await site.run('account', 'default', 'set', 'github.com', 'GITHUB');
    await project.run('account', 'default', 'set', 'github.com', 'GITHUB', '--project', 'ferretry');
    await folder.run('account', 'default', 'set', 'github.com', 'GITHUB', '--folder', '~/work');

    // Assert
    should(site.gateway.last('putDefault')).deepEqual([{ scope: 'sites', key: 'github.com', account: 'GITHUB' }]);
    should(project.gateway.last('putDefault')).deepEqual([
      { scope: 'projects', within: 'ferretry', key: 'github.com', account: 'GITHUB' },
    ]);
    should(folder.gateway.last('putDefault')).deepEqual([
      { scope: 'folders', within: '~/work', key: 'github.com', account: 'GITHUB' },
    ]);
  });

  it('should clear a default with rm, and refuse both --project and --folder', async () => {
    // Arrange
    const { run, gateway } = rig();

    // Act
    await run('account', 'default', 'rm', 'github.com');
    const both = await refusal(() =>
      rig().run('account', 'default', 'rm', 'github.com', '--project', 'p', '--folder', '~/f'),
    );

    // Assert
    should(gateway.last('putDefault')).deepEqual([{ scope: 'sites', key: 'github.com', account: null }]);
    should(both).containEql('not both');
  });

  it('should explain a daemon refusal in the owner’s words', async () => {
    // Arrange
    const none = rig();
    none.gateway.failures.set('putDefault', new FyHttpError('no', 409, 'no_sign_in_here'));
    const broken = rig();
    broken.gateway.failures.set('putDefault', new FyHttpError('the file is wrong', 409, 'defaults_file_invalid'));

    // Act
    const noSignIn = await refusal(() => none.run('account', 'default', 'set', 'gitlab.com', 'GITHUB'));
    const invalid = await refusal(() => broken.run('account', 'default', 'set', 'github.com', 'GITHUB'));

    // Assert
    should(noSignIn).containEql('has no sign-in for gitlab.com');
    should(invalid).containEql('account-defaults.yaml');
  });
});

describe('fy account site', () => {
  it('should list every sign-in, or one account’s', async () => {
    // Arrange
    const all = rig();
    const one = rig();

    // Act
    await all.run('account', 'site');
    await one.run('account', 'site', 'ls', 'SUDO_BOX', '--json');
    const missing = await refusal(() => rig().run('account', 'site', 'ls', 'NOPE'));

    // Assert
    should(all.messages[0]).containEql(SI_GITHUB).and.containEql(SI_TERMINAL);
    should(JSON.parse(one.messages[0] ?? '[]').map((s: { id: string }) => s.id)).deepEqual([SI_TERMINAL]);
    should(missing).containEql('no account NOPE');
  });

  it('should add a site sign-in through a provider, and a terminal sign-in with a destination', async () => {
    // Arrange
    const site = rig();
    const terminal = rig();

    // Act
    await site.run(
      'account',
      'site',
      'add',
      'SUDO_BOX',
      '--domain',
      'vercel.com',
      '--for',
      'app.vercel.com',
      '--method',
      'google',
      '--via',
      'GITHUB',
    );
    await terminal.run('account', 'site', 'add', 'SUDO_BOX', '--tool', 'ssh', '--host', 'box', '--dest', 'prod');

    // Assert
    should(site.gateway.last('addSignIn')).deepEqual([
      'SUDO_BOX',
      {
        place: { kind: 'site', domains: ['vercel.com'], match: ['app.vercel.com'] },
        method: { kind: 'google', via: 'GITHUB' },
      },
    ]);
    should((terminal.gateway.last('addSignIn')[1] as { place: unknown }).place).deepEqual({
      kind: 'terminal',
      tool: 'ssh',
      host: 'box',
      dest: 'prod',
    });
  });

  it('should refuse a sign-in with no place, both kinds of place, an unknown account and a passkey', async () => {
    // Arrange + Act
    const none = await refusal(() => rig().run('account', 'site', 'add', 'GITHUB'));
    const both = await refusal(() =>
      rig().run('account', 'site', 'add', 'GITHUB', '--domain', 'a.com', '--tool', 'ssh', '--host', 'box'),
    );
    const unknown = await refusal(() => rig().run('account', 'site', 'add', 'NOPE', '--domain', 'a.com'));
    const passkey = await refusal(() =>
      rig().run('account', 'site', 'add', 'GITHUB', '--domain', 'a.com', '--method', 'passkey'),
    );
    const noDest = await refusal(() => rig().run('account', 'site', 'add', 'GITHUB', '--tool', 'ssh', '--host', 'box'));

    // Assert
    should(none).containEql('say where it signs in');
    should(both).containEql('not both');
    should(unknown).containEql('no account NOPE');
    should(passkey).containEql('passkeys are off');
    should(noDest.length).be.above(0);
  });

  it('should edit only the part named, keeping the rest of the place', async () => {
    // Arrange
    const { run, gateway } = rig();

    // Act
    await run('account', 'site', 'edit', SI_GITHUB, '--domain', 'gitlab.com');
    const wrongKind = await refusal(() => rig().run('account', 'site', 'edit', SI_GITHUB, '--tool', 'sudo'));
    const nothing = await refusal(() => rig().run('account', 'site', 'edit', SI_GITHUB));
    const unknown = await refusal(() =>
      rig().run('account', 'site', 'edit', 'si_ffffffffffffffff', '--domain', 'a.com'),
    );

    // Assert
    should(gateway.last('putSignIn')).deepEqual([
      SI_GITHUB,
      { place: { kind: 'site', domains: ['gitlab.com'], match: ['github.com'] } },
    ]);
    should(wrongKind).containEql('on a site');
    should(nothing).containEql('nothing to change');
    should(unknown).containEql('no sign-in');
  });

  it('should turn auto-apply on and off, and refuse another word', async () => {
    // Arrange
    const { run, gateway } = rig();

    // Act
    await run('account', 'site', 'edit', SI_GITHUB, '--auto-apply-recipe', 'on');
    const bad = await refusal(() => rig().run('account', 'site', 'edit', SI_GITHUB, '--auto-apply-recipe', 'maybe'));

    // Assert
    should(gateway.last('putSignIn')).deepEqual([SI_GITHUB, { autoApplyRecipe: true }]);
    should(bad).containEql('on or off');
  });

  it('should remove a sign-in on yes, keep it on no, and take a si_ id only', async () => {
    // Arrange
    const yes = rig();
    const no = rig({ prompt: new FakePrompt([], ['no']) });

    // Act
    await yes.run('account', 'site', 'rm', SI_GITHUB);
    await no.run('account', 'site', 'rm', SI_GITHUB);
    const handle = await refusal(() => rig().run('account', 'site', 'rm', 'GITHUB'));

    // Assert
    should(yes.gateway.last('removeSignIn')).deepEqual([SI_GITHUB]);
    should(no.gateway.ops()).not.containEql('removeSignIn');
    should(handle).containEql('not a sign-in id');
  });
});

describe('fy account site recipe', () => {
  it('should show the recipe state of a sign-in', async () => {
    // Arrange
    const { run, messages } = rig();

    // Act
    await run('account', 'site', 'recipe', SI_GITHUB);

    // Assert
    should(messages[0]).containEql('no recipe yet');
  });

  it('should set the recipe from a file or standard input, and refuse one that holds a value', async () => {
    // Arrange
    const set = rig({ recipe: 'Open github.com, press Sign in.' });
    const holds = rig();
    holds.gateway.failures.set('putSignIn', new FyHttpError('no', 422, 'recipe_holds_value'));

    // Act
    await set.run('account', 'site', 'recipe', 'set', SI_GITHUB, '--file', '-');
    const message = await refusal(() => holds.run('account', 'site', 'recipe', 'set', SI_GITHUB, '--file', 'r.md'));

    // Assert
    should(set.gateway.last('putSignIn')).deepEqual([SI_GITHUB, { recipe: 'Open github.com, press Sign in.' }]);
    should(message).containEql('never may');
  });

  it('should refuse an empty recipe without sending it, and a missing file flag', async () => {
    // Arrange
    const empty = rig({ recipe: '   ' });

    // Act
    const message = await refusal(() => empty.run('account', 'site', 'recipe', 'set', SI_GITHUB, '--file', 'r.md'));
    const noFile = await refusal(() => rig().run('account', 'site', 'recipe', 'set', SI_GITHUB));

    // Assert
    should(message).containEql('not a usable recipe');
    should(empty.gateway.ops()).not.containEql('putSignIn');
    should(noFile).containEql('--file');
  });

  it('should clear a recipe only when there is one', async () => {
    // Arrange
    const withRecipe = rig({ list: { ...LIST, signIns: [{ ...GITHUB_SIGN_IN, recipe: 'Open it.' }, BOX_SIGN_IN] } });
    const without = rig();

    // Act
    await withRecipe.run('account', 'site', 'recipe', 'clear', SI_GITHUB);
    await without.run('account', 'site', 'recipe', 'clear', SI_GITHUB);

    // Assert
    should(withRecipe.gateway.last('putSignIn')).deepEqual([SI_GITHUB, { recipe: null }]);
    should(without.gateway.ops()).not.containEql('putSignIn');
  });

  it('should approve and decline a ferret’s proposal, and explain a stale or unknown one', async () => {
    // Arrange
    const approve = rig();
    const decline = rig();
    const stale = rig();
    stale.gateway.failures.set('decideRecipe', new FyHttpError('no', 409, 'stale_proposal'));
    const unknown = rig();
    unknown.gateway.failures.set('decideRecipe', new FyHttpError('no', 404, 'unknown_proposal'));

    // Act
    await approve.run('account', 'site', 'recipe', 'approve', SI_GITHUB, PROPOSAL);
    await decline.run('account', 'site', 'recipe', 'decline', SI_GITHUB, PROPOSAL);
    const staleMessage = await refusal(() => stale.run('account', 'site', 'recipe', 'approve', SI_GITHUB, PROPOSAL));
    const unknownMessage = await refusal(() =>
      unknown.run('account', 'site', 'recipe', 'approve', SI_GITHUB, PROPOSAL),
    );
    const badId = await refusal(() => rig().run('account', 'site', 'recipe', 'approve', SI_GITHUB, 'nope'));

    // Assert
    should(approve.gateway.last('decideRecipe')).deepEqual([SI_GITHUB, PROPOSAL, 'approve']);
    should(decline.gateway.last('decideRecipe')).deepEqual([SI_GITHUB, PROPOSAL, 'decline']);
    should(staleMessage).containEql('changed after the ferret proposed');
    should(unknownMessage).containEql('no such proposal');
    should(badId).containEql('not a proposal id');
  });
});

describe('fy account factor', () => {
  it('should list the 2FA keys of one account or all', async () => {
    // Arrange
    const all = rig();
    const one = rig();

    // Act
    await all.run('account', 'factor');
    await one.run('account', 'factor', 'ls', 'SUDO_BOX');

    // Assert
    should(all.messages[0]).containEql(TF_AUTO).and.containEql(TF_SMS);
    should(one.messages[0]).containEql('has no 2FA keys');
  });

  it('should add each kind of key that holds no value', async () => {
    // Arrange
    const sms = rig();
    const authenticator = rig();
    const email = rig();
    const push = rig();
    const key = rig();

    // Act
    await sms.run('account', 'factor', 'add', 'GITHUB', '--sms', '--ends-with', '42', '--label', 'Phone');
    await authenticator.run('account', 'factor', 'add', 'GITHUB', '--authenticator', '--label', 'Authy');
    await email.run('account', 'factor', 'add', 'GITHUB', '--email', '--to', 'k***@x.com', '--label', 'Mail');
    await push.run('account', 'factor', 'add', 'GITHUB', '--push', '--app', 'duo', '--label', 'Duo');
    await key.run('account', 'factor', 'add', 'GITHUB', '--security-key', '--label', 'YubiKey');

    // Assert
    should(sms.gateway.last('addFactor')).deepEqual(['GITHUB', { label: 'Phone', kind: 'sms', endsWith: '42' }]);
    should(authenticator.gateway.last('addFactor')).deepEqual(['GITHUB', { label: 'Authy', kind: 'totp' }]);
    should(email.gateway.last('addFactor')).deepEqual(['GITHUB', { label: 'Mail', kind: 'email', to: 'k***@x.com' }]);
    should(push.gateway.last('addFactor')).deepEqual(['GITHUB', { label: 'Duo', kind: 'push', app: 'duo' }]);
    should(key.gateway.last('addFactor')).deepEqual(['GITHUB', { label: 'YubiKey', kind: 'security-key' }]);
  });

  it('should refuse no kind, two kinds, no label, a whole phone number, a stray flag and an unknown app', async () => {
    // Arrange + Act
    const none = await refusal(() => rig().run('account', 'factor', 'add', 'GITHUB', '--label', 'x'));
    const two = await refusal(() => rig().run('account', 'factor', 'add', 'GITHUB', '--sms', '--push', '--label', 'x'));
    const noLabel = await refusal(() => rig().run('account', 'factor', 'add', 'GITHUB', '--sms'));
    const number = await refusal(() =>
      rig().run('account', 'factor', 'add', 'GITHUB', '--sms', '--ends-with', '5551234567', '--label', 'x'),
    );
    const stray = await refusal(() =>
      rig().run('account', 'factor', 'add', 'GITHUB', '--email', '--ends-with', '42', '--label', 'x'),
    );
    const app = await refusal(() =>
      rig().run('account', 'factor', 'add', 'GITHUB', '--push', '--app', 'bogus', '--label', 'x'),
    );

    // Assert
    should(none).containEql('exactly one kind');
    should(two).containEql('exactly one kind');
    should(noLabel).containEql('--label');
    should(number).containEql('last 2 to 4 digits');
    should(stray).containEql('is for sms');
    should(app).containEql('--app is one of');
  });

  it('should stage a TOTP seed with --totp and never add or commit one itself', async () => {
    // Arrange
    const { run, seeds, gateway, messages } = rig({ session: 'lead-1' });

    // Act
    await run('account', 'factor', 'add', 'GITHUB', '--totp', '--i-understand-totp');
    const mixed = await refusal(() => rig().run('account', 'factor', 'add', 'GITHUB', '--totp', '--sms'));

    // Assert
    should(seeds.calls[0]).equal('stage GITHUB');
    should(seeds.calls.some(call => call.includes('commit'))).be.false();
    should(gateway.ops()).not.containEql('addFactor');
    should(messages.join('\n')).containEql('!A7').and.not.containEql('JBSWY3DPEHPK3PXP');
    should(mixed).containEql('kind of its own');
  });

  it('should warn that a seed goes with its key before asking, and remove on yes only', async () => {
    // Arrange
    const yes = rig();
    const no = rig({ prompt: new FakePrompt([], ['no']) });

    // Act
    await yes.run('account', 'factor', 'rm', 'GITHUB', TF_AUTO);
    await no.run('account', 'factor', 'rm', 'GITHUB', TF_SMS);
    const unknown = await refusal(() => rig().run('account', 'factor', 'rm', 'GITHUB', 'tf_ffffffffffff'));
    const badId = await refusal(() => rig().run('account', 'factor', 'rm', 'GITHUB', 'nope'));

    // Assert
    should(yes.prompt.asked[0]).containEql('seed is deleted');
    should(yes.gateway.last('removeFactor')).deepEqual(['GITHUB', TF_AUTO]);
    should(no.gateway.ops()).not.containEql('removeFactor');
    should(unknown).containEql('has no 2FA key');
    should(badId).containEql('not a 2FA key id');
  });

  it('should take no value on the command line: no flag carries a password or a seed', async () => {
    // Arrange
    const { root } = rig();
    const account = root.commands.find(command => command.name() === 'account');
    const valued = (command: Command | undefined): string[] =>
      (command?.options ?? []).filter(option => option.required || option.optional).map(option => option.long ?? '');
    const add = account?.commands.find(command => command.name() === 'add');
    const edit = account?.commands.find(command => command.name() === 'edit');
    const factorAdd = account?.commands
      .find(command => command.name() === 'factor')
      ?.commands.find(command => command.name() === 'add');

    // Act + Assert
    should(valued(add).sort()).deepEqual(
      [
        '--domain',
        '--dest',
        '--for',
        '--host',
        '--label',
        '--method',
        '--sso-name',
        '--tool',
        '--username',
        '--via',
      ].sort(),
    );
    should(valued(edit).sort()).deepEqual(['--label', '--username']);
    should(valued(factorAdd).sort()).deepEqual(['--app', '--ends-with', '--label', '--session', '--to']);
  });
});

describe('fy secret entry (the old spelling)', () => {
  const mountBoth = (root: Command, controllers: AccountControllers): void => {
    registerAccountCommands(root, controllers);
    registerLoginEntryCommands(root.command('secret'), controllers);
  };

  it('should run the same verbs as fy account, and stay out of fy secret --help', async () => {
    // Arrange
    const viaAlias = rig({ mount: mountBoth });
    const direct = rig({ mount: mountBoth });

    // Act
    await viaAlias.run('secret', 'entry', 'ls');
    await direct.run('account', 'ls');
    await viaAlias.run('secret', 'entry', 'site', 'rm', SI_GITHUB, '-y');
    await viaAlias.run('secret', 'entry', 'factor', 'rm', 'GITHUB', TF_SMS, '-y');

    // Assert
    const entry = viaAlias.root.commands.find(c => c.name() === 'secret')?.commands.find(c => c.name() === 'entry');
    should(viaAlias.messages[0]).equal(direct.messages[0]);
    should(viaAlias.gateway.ops()).containEql('removeSignIn').and.containEql('removeFactor');
    should((entry as unknown as { _hidden: boolean })._hidden).be.true();
    should(entry?.description()).containEql('alias of `fy account`');
  });
});
