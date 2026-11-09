import { describe, it } from 'bun:test';
import should from 'should';
import { AccountController } from '../../../cli/lib/account-controller.ts';
import { FyHttpError } from '../../../cli/shell.ts';
import { DAMAGED, LIST, accountPorts, rejection, type RigOptions } from './accounts-rig.ts';

const PASSWORD = 'correct horse battery';

function rig(options: RigOptions = {}) {
  const made = accountPorts(options);
  return { ...made, controller: new AccountController(made.ports) };
}

describe('AccountController list', () => {
  it('should print the accounts as text, or as JSON when asked', async () => {
    const text = rig();
    await text.controller.list({});
    should(text.said[0]).startWith('work github  [GITHUB_WORK]');
    const json = rig();
    await json.controller.list({ json: true });
    should(JSON.parse(json.said[0] ?? '')).eql(JSON.parse(JSON.stringify(LIST)));
  });
});

describe('AccountController add', () => {
  it('should read the password hidden at the prompt, send it once in the PUT body and say it has no sign-in yet', async () => {
    const { controller, gateway, said, askedHidden } = rig({
      list: { ...LIST, accounts: [] },
      hidden: [PASSWORD],
    });
    await controller.add(' SUDO_KIRIN_BOX ', { label: ' sudo on box ', username: ' kirin ' });
    should(askedHidden).eql(['password for SUDO_KIRIN_BOX (hidden): ']);
    should(gateway.calls.at(-1)).eql([
      'putAccount',
      'SUDO_KIRIN_BOX',
      { label: 'sudo on box', username: 'kirin', password: PASSWORD },
    ]);
    should(said[0]).startWith('Added SUDO_KIRIN_BOX  sudo on box');
    should(said[1]).containEql('SUDO_KIRIN_BOX has no sign-in yet').and.containEql('account site add SUDO_KIRIN_BOX');
    should(said.join('\n')).not.containEql(PASSWORD);
  });

  it('should save an account with no password when --no-password is given, and ask nothing', async () => {
    const { controller, gateway, askedHidden } = rig({ list: { ...LIST, accounts: [] } });
    await controller.add('SUDO_KIRIN_BOX', { label: 'sudo', password: false });
    should(askedHidden).eql([]);
    should(gateway.calls.at(-1)).eql(['putAccount', 'SUDO_KIRIN_BOX', { label: 'sudo' }]);
  });

  it('should add the first sign-in too when a place is named, with the method when one is', async () => {
    const { controller, gateway, said } = rig({ list: { ...LIST, accounts: [] }, hidden: [PASSWORD] });
    await controller.add('GOOGLE_KIRIN', { label: 'google', domain: ['accounts.google.com'] });
    should(gateway.calls.at(-1)).eql([
      'addSignIn',
      'GOOGLE_KIRIN',
      { place: { kind: 'site', domains: ['accounts.google.com'], match: [] } },
    ]);
    should(said.at(-1)).startWith('Sign-in si_').and.containEql('site signs in on accounts.google.com');

    const withMethod = rig({ list: { ...LIST, accounts: [] }, hidden: [PASSWORD] });
    await withMethod.controller.add('VERCEL_KIRIN', {
      label: 'vercel',
      domain: ['vercel.com'],
      method: 'github',
      via: 'GITHUB_WORK',
    });
    should(withMethod.gateway.calls.at(-1)?.[2]).eql({
      place: { kind: 'site', domains: ['vercel.com'], match: [] },
      method: { kind: 'github', via: 'GITHUB_WORK' },
    });
  });

  it('should say the account was saved when its sign-in was not, with the daemon reason or a plain one', async () => {
    const refused = rig({
      list: { ...LIST, accounts: [] },
      hidden: [PASSWORD],
      fail: { addSignIn: new Error('too many') },
    });
    const message = await rejection(() =>
      refused.controller.add('GOOGLE_KIRIN', { label: 'google', domain: ['accounts.google.com'] }),
    );
    should(message).startWith('GOOGLE_KIRIN was saved, but its sign-in was not: too many.');
    should(message).containEql('account site add GOOGLE_KIRIN');
    should(refused.gateway.calls.map(call => call[0])).containEql('putAccount');

    const odd = rig({ list: { ...LIST, accounts: [] }, hidden: [PASSWORD], fail: { addSignIn: 'nope' } });
    should(
      await rejection(() => odd.controller.add('GOOGLE_KIRIN', { label: 'g', domain: ['accounts.google.com'] })),
    ).containEql('its sign-in was not: the daemon refused it.');
  });

  it('should refuse a method without a place, an account that exists and a damaged store, before writing anything', async () => {
    const noPlace = rig({ list: { ...LIST, accounts: [] } });
    should(await rejection(() => noPlace.controller.add('A_B', { label: 'x', method: 'google' }))).containEql(
      'a sign-in method needs a place',
    );
    const exists = rig();
    should(await rejection(() => exists.controller.add('GITHUB_WORK', { label: 'x' }))).containEql(
      'GITHUB_WORK already exists: change it with `account edit GITHUB_WORK`',
    );
    const damaged = rig({ list: DAMAGED });
    should(await rejection(() => damaged.controller.add('A_B', { label: 'x' }))).containEql(
      'its accounts are NOT gone, so nothing was changed',
    );
    for (const made of [noPlace, exists, damaged])
      should(made.gateway.calls.map(call => call[0]).filter(name => name !== 'list')).eql([]);
  });

  it('should refuse a bad handle, label or username before reading the account list', async () => {
    const { controller, gateway } = rig();
    should(await rejection(() => controller.add('lower', { label: 'x' }))).containEql('not a usable account handle');
    should(await rejection(() => controller.add('A_B', { label: '' }))).containEql('--label must be one line');
    should(await rejection(() => controller.add('A_B', { label: 'x', username: ' ' }))).containEql(
      '--username must be one line',
    );
    should(gateway.calls).eql([]);
  });

  it('should refuse to ask for a password away from a terminal, and a password that is not usable', async () => {
    const away = rig({ list: { ...LIST, accounts: [] }, interactive: false });
    should(await rejection(() => away.controller.add('A_B', { label: 'x' }))).containEql(
      'this needs a terminal you are sitting at: the password is typed at a prompt, never given as a flag',
    );
    const weak = rig({ list: { ...LIST, accounts: [] }, hidden: ['abc'] });
    const message = await rejection(() => weak.controller.add('A_B', { label: 'x' }));
    should(message).containEql('at least').and.not.containEql('abc');
    should(weak.gateway.calls.map(call => call[0])).not.containEql('putAccount');
  });
});

describe('AccountController edit', () => {
  it('should refuse when no field is named', async () => {
    const { controller, gateway } = rig();
    should(await rejection(() => controller.edit('GITHUB_WORK', {}))).containEql('nothing to change');
    should(gateway.calls).eql([]);
  });

  it('should send only the fields named: a label, a username, or null for --no-username', async () => {
    const both = rig();
    await both.controller.edit('GITHUB_WORK', { label: ' renamed ', username: ' kirin ' });
    should(both.gateway.calls.at(-1)).eql(['putAccount', 'GITHUB_WORK', { label: 'renamed', username: 'kirin' }]);
    should(both.said[0]).startWith('Updated GITHUB_WORK');

    const none = rig();
    await none.controller.edit('GITHUB_WORK', { username: false });
    should(none.gateway.calls.at(-1)).eql(['putAccount', 'GITHUB_WORK', { username: null }]);
  });

  it('should read a new password hidden and send it in the body', async () => {
    const { controller, gateway, askedHidden } = rig({ hidden: [PASSWORD] });
    await controller.edit('GITHUB_WORK', { password: true });
    should(askedHidden).eql(['new password for GITHUB_WORK (hidden): ']);
    should(gateway.calls.at(-1)).eql(['putAccount', 'GITHUB_WORK', { password: PASSWORD }]);
  });

  it('should refuse an account that does not exist, before asking for anything', async () => {
    const { controller, askedHidden, gateway } = rig({ hidden: [PASSWORD] });
    should(await rejection(() => controller.edit('NOPE', { password: true }))).equal(
      'no account NOPE (see `account ls`)',
    );
    should(askedHidden).eql([]);
    should(gateway.calls.map(call => call[0])).not.containEql('putAccount');
  });
});

describe('AccountController rename', () => {
  it('should rename through the gateway and say what follows the account', async () => {
    const { controller, gateway, said } = rig();
    await controller.rename('GITHUB_WORK', 'GITHUB_JOB');
    should(gateway.calls).eql([['renameAccount', 'GITHUB_WORK', 'GITHUB_JOB']]);
    should(said).eql(['Renamed GITHUB_WORK to GITHUB_JOB. Its sign-ins, 2FA keys and defaults follow it.']);
  });
});

describe('AccountController remove', () => {
  it('should remove at once with --yes, saying how many sign-ins and keys went', async () => {
    const { controller, gateway, said, asked } = rig();
    await controller.remove('GITHUB_WORK', { yes: true });
    should(asked).eql([]);
    should(gateway.calls.at(-1)).eql(['removeAccount', 'GITHUB_WORK']);
    should(said).eql(['Removed GITHUB_WORK.']);
  });

  it('should ask first, naming what goes with the account, and remove on yes', async () => {
    const one = rig({ typed: [' YES '] });
    await one.controller.remove('GITHUB_WORK', {});
    should(one.asked[0]).equal(
      'Remove GITHUB_WORK (work github) with its 1 sign-in and 0 2FA keys? This cannot be undone. Type yes: ',
    );
    should(one.gateway.calls.at(-1)).eql(['removeAccount', 'GITHUB_WORK']);
    const many = rig({ typed: ['yes'] });
    await many.controller.remove('GITHUB_HOME', {});
    should(many.asked[0]).containEql('with its 0 sign-ins and 2 2FA keys?');
  });

  it('should keep the account on any other answer', async () => {
    const { controller, gateway, said } = rig({ typed: ['no'] });
    await controller.remove('GITHUB_WORK', {});
    should(said).eql(['Kept GITHUB_WORK.']);
    should(gateway.calls.map(call => call[0])).not.containEql('removeAccount');
  });

  it('should refuse to ask away from a terminal, and an account that does not exist', async () => {
    const away = rig({ interactive: false });
    should(await rejection(() => away.controller.remove('GITHUB_WORK', {}))).containEql(
      'this asks first; pass --yes to skip the question',
    );
    const missing = rig();
    should(await rejection(() => missing.controller.remove('NOPE', { yes: true }))).containEql('no account NOPE');
  });
});

describe('AccountController merge', () => {
  it('should refuse the same account twice, and an account that does not exist', async () => {
    const { controller, gateway } = rig();
    should(await rejection(() => controller.merge('GITHUB_WORK', 'GITHUB_WORK', { yes: true }))).containEql(
      'name two different accounts',
    );
    should(await rejection(() => controller.merge('GITHUB_WORK', 'NOPE', { yes: true }))).containEql('no account NOPE');
    should(await rejection(() => controller.merge('NOPE', 'GITHUB_WORK', { yes: true }))).containEql('no account NOPE');
    should(gateway.calls.map(call => call[0])).not.containEql('merge');
  });

  it('should fold the second into the first once the owner says yes', async () => {
    const { controller, gateway, said, asked } = rig({ typed: ['yes'] });
    await controller.merge('GITHUB_WORK', 'GITHUB_HOME', {});
    should(asked[0]).startWith('Merge GITHUB_HOME (home github) into GITHUB_WORK (work github)?');
    should(gateway.calls.at(-1)).eql(['merge', 'GITHUB_WORK', 'GITHUB_HOME']);
    should(said[0]).startWith('Merged GITHUB_HOME into GITHUB_WORK  work github');
  });

  it('should merge without asking with --yes, and keep both on any other answer', async () => {
    const yes = rig();
    await yes.controller.merge('GITHUB_WORK', 'GITHUB_HOME', { yes: true });
    should(yes.asked).eql([]);
    should(yes.gateway.calls.at(-1)?.[0]).equal('merge');
    const no = rig({ typed: ['nope'] });
    await no.controller.merge('GITHUB_WORK', 'GITHUB_HOME', {});
    should(no.said).eql(['Kept both.']);
    should(no.gateway.calls.map(call => call[0])).not.containEql('merge');
  });
});

describe('AccountController apart', () => {
  it('should record two different accounts as apart', async () => {
    const { controller, gateway, said } = rig();
    await controller.apart('GITHUB_WORK', 'GITHUB_HOME');
    should(gateway.calls).eql([['apart', 'GITHUB_WORK', 'GITHUB_HOME']]);
    should(said[0]).equal(
      'GITHUB_WORK and GITHUB_HOME are kept apart: they are not offered as look-alikes of each other.',
    );
  });

  it('should refuse the same account twice', async () => {
    const { controller, gateway } = rig();
    should(await rejection(() => controller.apart('GITHUB_WORK', 'GITHUB_WORK'))).equal('name two different accounts');
    should(gateway.calls).eql([]);
  });
});

describe('AccountController lookAlike', () => {
  it('should say no accounts look alike, list the groups, or print JSON', async () => {
    const none = rig();
    await none.controller.lookAlike({});
    should(none.said).eql(['No accounts look like one another.']);

    const groups = rig({ lookAlike: { v: 1, groups: [['GITHUB_HOME', 'GITHUB_WORK']] } });
    await groups.controller.lookAlike({});
    should(groups.said[0]?.split('\n')).eql([
      'These look like one account each (same username and password):',
      '  GITHUB_HOME, GITHUB_WORK',
      'Merge them with `account merge <keep> <from>`, or say they differ with `account apart <a> <b>`.',
    ]);

    const json = rig({ lookAlike: { v: 1, groups: [['GITHUB_HOME', 'GITHUB_WORK']] } });
    await json.controller.lookAlike({ json: true });
    should(JSON.parse(json.said[0] ?? '')).eql({ v: 1, groups: [['GITHUB_HOME', 'GITHUB_WORK']] });
  });
});

describe('AccountController hint', () => {
  it('should ask the gateway for the site a URL names, and print the hint as text or JSON', async () => {
    const text = rig();
    await text.controller.hint('https://GitHub.com/login', {});
    should(text.gateway.calls).eql([['hint', 'github.com']]);
    should(text.said[0]).startWith('No account for github.com;');
    const json = rig();
    await json.controller.hint('github.com', { json: true });
    should(JSON.parse(json.said[0] ?? '')).eql({ v: 1, site: 'github.com', hints: [], passkeys: 'off' });
  });

  it('should refuse text that is not a site', async () => {
    const { controller, gateway } = rig();
    should(await rejection(() => controller.hint('not a site!', {}))).equal(
      '"not a site!" is not a site: use a host like github.com, or a URL',
    );
    should(gateway.calls).eql([]);
  });
});

describe('AccountController defaults', () => {
  it('should star an account for a site on this machine and print the lines now in effect', async () => {
    const { controller, gateway, said } = rig();
    await controller.defaultSet(' GitHub.com ', 'GITHUB_WORK', {});
    should(gateway.calls).eql([['putDefault', { scope: 'sites', key: 'github.com', account: 'GITHUB_WORK' }]]);
    should(said[0]?.split('\n')).eql([
      'GITHUB_WORK is offered first for github.com (every session on this machine).',
      '',
      'github.com -> GITHUB_WORK  (every session on this machine)',
    ]);
  });

  it('should scope a default to one project or one folder', async () => {
    const project = rig();
    await project.controller.defaultSet('github.com', 'GITHUB_WORK', { project: ' ferretry ' });
    should(project.gateway.calls[0]?.[1]).eql({
      scope: 'projects',
      within: 'ferretry',
      key: 'github.com',
      account: 'GITHUB_WORK',
    });
    should(project.said[0]).containEql('(project ferretry)');
    const folder = rig();
    await folder.controller.defaultSet('sudo@kirin-box', 'SUDO_KIRIN', { folder: '~/scratch' });
    should(folder.gateway.calls[0]?.[1]).eql({
      scope: 'folders',
      within: '~/scratch',
      key: 'sudo@kirin-box',
      account: 'SUDO_KIRIN',
    });
    should(folder.said[0]).containEql('(folder ~/scratch)');
  });

  it('should remove a default and say none is starred now', async () => {
    const { controller, gateway, said } = rig();
    await controller.defaultRemove('github.com', {});
    should(gateway.calls).eql([['putDefault', { scope: 'sites', key: 'github.com', account: null }]]);
    should(said[0]?.split('\n')).eql([
      'No account is starred for github.com (every session on this machine) now.',
      '',
      'No default accounts are set.',
    ]);
  });

  it('should refuse a project and a folder together, an empty one, a key that is not a place and a bad handle', async () => {
    const { controller, gateway } = rig();
    should(
      await rejection(() => controller.defaultSet('github.com', 'GITHUB_WORK', { project: 'p', folder: '/f' })),
    ).containEql('not both');
    should(await rejection(() => controller.defaultSet('github.com', 'GITHUB_WORK', { project: '  ' }))).equal(
      '--project and --folder need a project name or a folder path',
    );
    should(await rejection(() => controller.defaultRemove('not a place!', {}))).containEql(
      '"not a place!" is not a place a default is for',
    );
    should(await rejection(() => controller.defaultSet('github.com', 'lower', {}))).containEql(
      'not a usable account handle',
    );
    should(gateway.calls).eql([]);
  });

  it('should explain a refusal for an account with no sign-in there, naming the account or a stand-in', async () => {
    const noSignIn = new FyHttpError('no sign-in', 409, 'no_sign_in_here');
    const set = rig({ fail: { putDefault: noSignIn } });
    should(await rejection(() => set.controller.defaultSet('github.com', 'GITHUB_HOME', {}))).equal(
      'GITHUB_HOME has no sign-in for github.com, so it cannot be offered first there: add one with `account site add`. Nothing was changed',
    );
    const remove = rig({ fail: { putDefault: noSignIn } });
    should(await rejection(() => remove.controller.defaultRemove('github.com', {}))).startWith(
      'that account has no sign-in for github.com',
    );
  });

  it('should explain an unreadable defaults file, and pass any other failure through', async () => {
    const invalid = rig({
      fail: { putDefault: new FyHttpError('line 3 is not an account', 422, 'defaults_file_invalid') },
    });
    should(await rejection(() => invalid.controller.defaultSet('github.com', 'GITHUB_WORK', {}))).equal(
      'line 3 is not an account. Fix config/account-defaults.yaml, then run this again. Nothing was changed',
    );
    const other = rig({ fail: { putDefault: new Error('offline') } });
    should(await rejection(() => other.controller.defaultSet('github.com', 'GITHUB_WORK', {}))).equal('offline');
    const otherCode = rig({ fail: { putDefault: new FyHttpError('odd', 500, 'something_else') } });
    should(await rejection(() => otherCode.controller.defaultSet('github.com', 'GITHUB_WORK', {}))).equal('odd');
  });
});

describe('AccountController and a damaged store', () => {
  it('should refuse to change anything it cannot read, and say the accounts are not gone', async () => {
    const { controller, gateway } = rig({ list: DAMAGED });
    const message = await rejection(() => controller.edit('GITHUB_WORK', { label: 'x' }));
    should(message).containEql('index is not valid JSON').and.containEql('NOT gone');
    should(gateway.calls.map(call => call[0])).eql(['list']);
    const noDiagnosis = rig({ list: { ...DAMAGED, diagnosis: undefined as never } });
    should(await rejection(() => noDiagnosis.controller.remove('A_B', { yes: true }))).containEql(
      'no diagnosis was given',
    );
  });
});
