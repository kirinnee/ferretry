import { describe, it } from 'bun:test';
import {
  type AccountHintList,
  type AccountList,
  LOGIN_PASSWORD_MAX_LENGTH,
  type SignInSummary,
  type TwoFactorKeySummary,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import {
  renderAccountHint,
  renderAccountList,
  renderFactorLine,
  renderSignInLine,
  renderSignInList,
  renderSignInRecipe,
} from '../../../src/lib/secrets/account-render';
import {
  AT,
  BOX_SIGN_IN,
  FakePrompt,
  GITHUB,
  GITHUB_SIGN_IN,
  LIST,
  refusal,
  rig,
  SI_GITHUB,
  SI_TERMINAL,
  TF_AUTO,
} from './account-rig';

const PROPOSAL = 'rp_0123456789abcdef';
const DAMAGED: AccountList = { ...LIST, health: 'damaged', diagnosis: 'the seal key is gone' };

const proposal = (id: string) => ({
  id,
  recipe: 'Open github.com\nClick Sign in',
  base: 'Open github.com',
  why: 'the button moved',
  sessionId: 's1',
  proposedAt: AT,
});
const WITH_PROPOSALS: SignInSummary = {
  ...GITHUB_SIGN_IN,
  recipe: 'Open github.com',
  observed: [{ at: 'github.com', surface: 'page', identity: '0123456789abcdef', since: AT }],
  proposals: [proposal(PROPOSAL), proposal('rp_fedcba9876543210')],
};
const totp = (verified?: { worked: boolean; at: string }): TwoFactorKeySummary =>
  ({
    id: TF_AUTO,
    kind: 'totp',
    label: 'Authenticator app',
    addedAt: AT,
    addedBy: 'owner',
    automatic: true,
    params: { algorithm: 'SHA1', digits: 6, period: 30 },
    ...(verified === undefined ? {} : { verified }),
  }) as unknown as TwoFactorKeySummary;

describe('account renders', () => {
  it('should count the proposals waiting on a sign-in, in the singular and the plural', () => {
    // Arrange
    const one = { ...WITH_PROPOSALS, proposals: [proposal(PROPOSAL)] };

    // Act
    const singular = renderSignInLine(one);
    const plural = renderSignInLine(WITH_PROPOSALS);

    // Assert
    should(singular).containEql('[1 proposal waiting]');
    should(plural).containEql('[2 proposals waiting]');
  });

  it('should say whether Ferretry’s own codes have been tried, and whether they worked', () => {
    // Arrange + Act
    const untried = renderFactorLine(totp());
    const worked = renderFactorLine(totp({ worked: true, at: '2026-02-03T00:00:00.000Z' }));
    const failed = renderFactorLine(totp({ worked: false, at: '2026-02-04T00:00:00.000Z' }));

    // Assert
    should(untried).containEql('not tried yet');
    should(worked).containEql('worked 2026-02-03');
    should(failed).containEql('did NOT work 2026-02-04');
  });

  it('should say an account with no sign-ins is never offered, and an empty sign-in list in words', () => {
    // Arrange
    const bare = { ...GITHUB, signIns: [] };
    const list: AccountList = { ...LIST, accounts: [bare], signIns: [] };

    // Act
    const all = renderAccountList(list);
    const none = renderSignInList(undefined, []);
    const noneOnOne = renderSignInList(bare, []);

    // Assert
    should(all).containEql('sign-ins: (none');
    should(none).equal('No sign-ins on this daemon.');
    should(noneOnOne).containEql('GITHUB has no sign-ins yet');
  });

  it('should print the hints for a site, and the empty answer when none fit', () => {
    // Arrange
    const empty: AccountHintList = { v: 1, site: 'github.com', hints: [], passkeys: 'off' };
    const full: AccountHintList = {
      ...empty,
      hints: [
        {
          signIn: SI_GITHUB,
          account: { id: 'GITHUB', label: 'GitHub' },
          username: 'kirinnee',
          role: 'site',
          place: GITHUB_SIGN_IN.place,
          method: { kind: 'password' },
        },
      ],
    };

    // Act
    const some = renderAccountHint(full);
    const nothing = renderAccountHint(empty);

    // Assert
    should(some).containEql('Sign-ins for github.com');
    should(some).containEql('GitHub');
    should(nothing).containEql('github.com');
  });

  it('should show what was seen and each waiting proposal as the change it would make', () => {
    // Arrange + Act
    const text = renderSignInRecipe(WITH_PROPOSALS, GITHUB);
    const bare = renderSignInRecipe(GITHUB_SIGN_IN, undefined);

    // Assert
    should(text).containEql('Seen:');
    should(text).containEql(`${PROPOSAL}  2026-01-01`);
    should(text).containEql('The ferret says: the button moved');
    should(bare).containEql('Seen: nothing yet');
  });
});

describe('fy account, on edge input', () => {
  it('should refuse a label that is not one line, and a password that is too short, too long or has a line break', async () => {
    // Arrange
    const short = rig({ prompt: new FakePrompt(['short']) });
    const long = rig({ prompt: new FakePrompt(['x'.repeat(LOGIN_PASSWORD_MAX_LENGTH + 1)]) });
    const broken = rig({ prompt: new FakePrompt(['correct-horse\nbattery']) });

    // Act
    const label = await refusal(() => rig().run('account', 'add', 'NEW', '--label', ''));
    const tooShort = await refusal(() => short.run('account', 'add', 'NEW', '--label', 'New'));
    const tooLong = await refusal(() => long.run('account', 'add', 'NEW', '--label', 'New'));
    const control = await refusal(() => broken.run('account', 'add', 'NEW', '--label', 'New'));

    // Assert
    should(label).containEql('--label must be one line');
    should(tooShort).containEql('at least');
    should(tooLong).containEql('at most');
    should(control).containEql('control character');
    for (const room of [short, long, broken]) should(room.gateway.ops()).not.containEql('putAccount');
    should(tooShort).not.containEql('short"');
  });

  it('should send a username on add, and change or remove one on edit', async () => {
    // Arrange
    const added = rig();
    const changed = rig();
    const removed = rig();

    // Act
    await added.run('account', 'add', 'NEW', '--label', 'New', '--username', 'bob');
    await changed.run('account', 'edit', 'GITHUB', '--label', 'GH', '--username', 'alice');
    await removed.run('account', 'edit', 'GITHUB', '--no-username');

    // Assert
    should((added.gateway.last('putAccount')[1] as { username?: string }).username).equal('bob');
    should(changed.gateway.last('putAccount')[1]).deepEqual({ label: 'GH', username: 'alice' });
    should(removed.gateway.last('putAccount')[1]).deepEqual({ username: null });
  });

  it('should print the look-alike groups as JSON, and say when none look alike', async () => {
    // Arrange
    const { run, messages } = rig();

    // Act
    await run('account', 'look-alike', '--json');

    // Assert
    should(JSON.parse(messages[0] ?? '')).deepEqual({ v: 1, groups: [['GITHUB', 'SUDO_BOX']] });
  });

  it('should say when no accounts look alike', async () => {
    // Arrange
    const { run, messages, gateway } = rig();
    gateway.lookAlike = async () => ({ v: 1, groups: [] });

    // Act
    await run('account', 'look-alike');

    // Assert
    should(messages[0]).equal('No accounts look like one another.');
  });

  it('should refuse a default for something that is not a place', async () => {
    // Arrange + Act
    const message = await refusal(() => rig().run('account', 'default', 'set', 'not a host', 'GITHUB'));

    // Assert
    should(message).containEql('not a place a default is for');
  });

  it('should say what the daemon meant when a default is refused', async () => {
    // Arrange
    const noSignIn = rig();
    noSignIn.gateway.failures.set('putDefault', new FyHttpError('no', 409, 'no_sign_in_here'));
    const invalid = rig();
    invalid.gateway.failures.set('putDefault', new FyHttpError('the file is not YAML', 500, 'defaults_file_invalid'));
    const other = rig();
    other.gateway.failures.set('putDefault', new FyHttpError('busy', 503, 'busy'));

    // Act
    const a = await refusal(() => noSignIn.run('account', 'default', 'set', 'github.com', 'SUDO_BOX'));
    const b = await refusal(() => invalid.run('account', 'default', 'set', 'github.com', 'GITHUB'));
    const c = await refusal(() => other.run('account', 'default', 'rm', 'github.com'));

    // Assert
    should(a).containEql('has no sign-in for github.com');
    should(b).containEql('Fix config/account-defaults.yaml');
    should(c).equal('busy');
  });

  it('should refuse every account write on a store the daemon cannot read, and change nothing', async () => {
    // Arrange
    const verbs = [
      ['account', 'rm', 'GITHUB', '--yes'],
      ['account', 'edit', 'GITHUB', '--label', 'x'],
      ['account', 'site', 'ls', 'GITHUB'],
      ['account', 'site', 'recipe', 'show', SI_GITHUB],
      ['account', 'site', 'rm', SI_GITHUB, '--yes'],
      ['account', 'factor', 'ls'],
      ['account', 'factor', 'add', 'GITHUB', '--sms', '--label', 'Phone'],
    ];

    // Act + Assert
    for (const words of verbs) {
      const room = rig({ list: DAMAGED });
      const message = await refusal(() => room.run(...words));
      should(message).containEql('NOT gone');
      should(room.gateway.ops().filter(op => op !== 'list')).deepEqual([]);
    }
  });

  it('should refuse to remove a sign-in without a terminal to ask at, unless told --yes', async () => {
    // Arrange
    const piped = rig({ interactive: false });
    const sure = rig({ interactive: false });

    // Act
    const message = await refusal(() => piped.run('account', 'site', 'rm', SI_GITHUB));
    await sure.run('account', 'site', 'rm', SI_GITHUB, '--yes');

    // Assert
    should(message).containEql('needs a terminal');
    should(piped.gateway.ops()).not.containEql('removeSignIn');
    should(sure.gateway.ops()).containEql('removeSignIn');
  });

  it('should print a sign-in’s recipe as JSON, and ask for the Markdown source', async () => {
    // Arrange
    const { run, messages } = rig();

    // Act
    await run('account', 'site', 'recipe', 'show', SI_GITHUB, '--json');
    const missing = await refusal(() => rig().controllers.signIns.recipeSet(SI_GITHUB, {}));

    // Assert
    should(JSON.parse(messages[0] ?? '').id).equal(SI_GITHUB);
    should(missing).containEql('--file');
  });

  it('should pass an unexpected refusal of a recipe decision through as the daemon said it', async () => {
    // Arrange
    const { run, gateway } = rig();
    const boom = new FyHttpError('the disk is full', 500, 'disk_full');
    gateway.failures.set('decideRecipe', boom);

    // Act
    const error = await run('account', 'site', 'recipe', 'approve', SI_GITHUB, PROPOSAL).catch((x: unknown) => x);

    // Assert
    should(error).equal(boom);
  });
});

describe('fy account site, on places', () => {
  const ssh: AccountList = {
    ...LIST,
    signIns: [GITHUB_SIGN_IN, { ...BOX_SIGN_IN, place: { kind: 'terminal', tool: 'ssh', host: 'box', dest: 'prod' } }],
  };

  it('should refuse a place that is both a site and a terminal', async () => {
    // Arrange + Act
    const message = await refusal(() =>
      rig().run('account', 'site', 'add', 'GITHUB', '--domain', 'a.com', '--tool', 'sudo'),
    );

    // Assert
    should(message).containEql('not both');
  });

  it('should not turn a site sign-in into a terminal one, nor the reverse, by editing', async () => {
    // Arrange + Act
    const terminal = await refusal(() => rig().run('account', 'site', 'edit', SI_TERMINAL, '--domain', 'a.com'));
    const site = await refusal(() => rig().run('account', 'site', 'edit', SI_GITHUB, '--tool', 'sudo'));

    // Assert
    should(terminal).containEql('is in a terminal');
    should(site).containEql('is on a site');
  });

  it('should keep a terminal sign-in’s destination when only the host changes, and lower-case a new one', async () => {
    // Arrange
    const kept = rig({ list: ssh });
    const set = rig({ list: ssh });

    // Act
    await kept.run('account', 'site', 'edit', SI_TERMINAL, '--host', 'Other');
    await set.run('account', 'site', 'edit', SI_TERMINAL, '--dest', 'STAGING');

    // Assert
    should((kept.gateway.last('putSignIn')[1] as { place: unknown }).place).deepEqual({
      kind: 'terminal',
      tool: 'ssh',
      host: 'other',
      dest: 'prod',
    });
    should((set.gateway.last('putSignIn')[1] as { place: { dest: string } }).place.dest).equal('staging');
  });

  it('should refuse a provider account on a password sign-in', async () => {
    // Arrange + Act
    const message = await refusal(() =>
      rig().run('account', 'site', 'add', 'GITHUB', '--domain', 'a.com', '--via', 'GOOGLE_KIRIN'),
    );

    // Assert
    should(message).containEql('--via is for a provider method');
  });
});

describe('fy account factor, on edge input', () => {
  it('should refuse an account that is not there, when listing, adding or removing', async () => {
    // Arrange + Act
    const ls = await refusal(() => rig().run('account', 'factor', 'ls', 'NOPE'));
    const add = await refusal(() => rig().run('account', 'factor', 'add', 'NOPE', '--sms', '--label', 'Phone'));
    const rm = await refusal(() => rig().run('account', 'factor', 'rm', 'NOPE', 'tf_0123456789ab', '--yes'));

    // Assert
    for (const message of [ls, add, rm]) should(message).containEql('no account NOPE');
  });

  it('should print one account’s keys as JSON, and say when an account has none', async () => {
    // Arrange
    const json = rig();
    const none = rig();

    // Act
    await json.run('account', 'factor', 'ls', 'GITHUB', '--json');
    await none.run('account', 'factor', 'ls', 'SUDO_BOX');

    // Assert
    const printed = JSON.parse(json.messages[0] ?? '[]') as { account: string; factors: unknown[] }[];
    should(printed.map(row => row.account)).deepEqual(['GITHUB']);
    should(printed[0]?.factors).have.length(2);
    should(none.messages[0]).containEql('SUDO_BOX has no 2FA keys');
  });

  it('should say so when no account on the daemon has a key', async () => {
    // Arrange
    const bare = rig({ list: { ...LIST, accounts: LIST.accounts.map(account => ({ ...account, factors: [] })) } });

    // Act
    await bare.run('account', 'factor', 'ls');

    // Assert
    should(bare.messages[0]).equal('No 2FA keys on this daemon.');
  });

  it('should refuse to remove a key without a terminal to ask at, and the key that is not there', async () => {
    // Arrange
    const piped = rig({ interactive: false });

    // Act
    const noTerminal = await refusal(() => piped.run('account', 'factor', 'rm', 'GITHUB', 'tf_ba9876543210'));
    const unknown = await refusal(() => rig().run('account', 'factor', 'rm', 'GITHUB', 'tf_000000000000', '--yes'));

    // Assert
    should(noTerminal).containEql('needs a terminal');
    should(unknown).containEql('has no 2FA key tf_000000000000');
    should(piped.gateway.ops()).not.containEql('removeFactor');
  });
});
