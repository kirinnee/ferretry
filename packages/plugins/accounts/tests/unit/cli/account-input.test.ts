import { describe, it } from 'bun:test';
import should from 'should';
import {
  accountHandle,
  factorHandle,
  methodOf,
  namesPlace,
  oneLine,
  onOrOff,
  passwordProblem,
  placeOf,
  proposalHandle,
  recipeRefusal,
  signInHandle,
} from '../../../cli/lib/account-input.ts';
import { LOGIN_PASSWORD_MAX_LENGTH, LOGIN_PASSWORD_MIN_LENGTH, type Place } from '../../../contract/routes/index.ts';
import { FyHttpError } from '../../../cli/shell.ts';

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('did not throw');
};

describe('the handles a verb takes', () => {
  it('should trim an account handle and refuse one that is not uppercase letters, digits and underscores', () => {
    should(accountHandle('  SUDO_KIRIN_BOX ')).equal('SUDO_KIRIN_BOX');
    should(messageOf(() => accountHandle('sudo kirin'))).containEql('"sudo kirin" is not a usable account handle');
  });

  it('should trim a sign-in id and refuse text that is not si_ and 16 hex digits', () => {
    should(signInHandle(` si_${'a'.repeat(16)} `)).equal(`si_${'a'.repeat(16)}`);
    should(messageOf(() => signInHandle('si_nope'))).containEql('"si_nope" is not a sign-in id');
  });

  it('should trim a 2FA key id and refuse text that is not tf_ and 12 hex digits', () => {
    should(factorHandle(` tf_${'b'.repeat(12)}`)).equal(`tf_${'b'.repeat(12)}`);
    should(messageOf(() => factorHandle('tf_9'))).containEql('"tf_9" is not a 2FA key id');
  });

  it('should trim a proposal id and refuse text that is not rp_ and 16 hex digits', () => {
    should(proposalHandle(`rp_${'c'.repeat(16)} `)).equal(`rp_${'c'.repeat(16)}`);
    should(messageOf(() => proposalHandle('rp_'))).containEql('"rp_" is not a proposal id');
  });
});

describe('oneLine', () => {
  it('should trim and return one line of the allowed length', () => {
    should(oneLine('  work github ', '--label', 20)).equal('work github');
  });

  it('should name the flag when the text is empty, too long or has a control or format character', () => {
    for (const bad of ['   ', 'x'.repeat(21), 'two\nlines', 'zero​width'])
      should(messageOf(() => oneLine(bad, '--label', 20))).equal('--label must be one line of 1 to 20 characters');
  });
});

describe('onOrOff', () => {
  it('should read on and off in any case and refuse anything else', () => {
    should(onOrOff(' ON ')).be.true();
    should(onOrOff('off')).be.false();
    should(messageOf(() => onOrOff('maybe'))).equal('--auto-apply-recipe is on or off');
  });
});

describe('passwordProblem', () => {
  it('should accept a password of the allowed length with no control character', () => {
    should(passwordProblem('x'.repeat(LOGIN_PASSWORD_MIN_LENGTH))).be.undefined();
    should(passwordProblem('x'.repeat(LOGIN_PASSWORD_MAX_LENGTH))).be.undefined();
  });

  it('should refuse a short, long or line-broken one without repeating what was typed', () => {
    const short = passwordProblem('abc');
    const long = passwordProblem('y'.repeat(LOGIN_PASSWORD_MAX_LENGTH + 1));
    const broken = passwordProblem('has a\nline break');
    should(short)
      .containEql(`at least ${String(LOGIN_PASSWORD_MIN_LENGTH)} characters`)
      .and.not.containEql('abc');
    should(long).equal(`a saved password is at most ${String(LOGIN_PASSWORD_MAX_LENGTH)} characters`);
    should(broken)
      .equal('a password with a control character or line break would press keys')
      .and.not.containEql('has a');
  });
});

describe('namesPlace', () => {
  it('should be true when any place flag is given and false when none is', () => {
    should(namesPlace({})).be.false();
    for (const flags of [{ domain: [] }, { for: [] }, { tool: 'sudo' }, { host: 'box' }, { dest: 'box' }])
      should(namesPlace(flags)).be.true();
  });
});

describe('placeOf', () => {
  const site: Place = { kind: 'site', domains: ['accounts.google.com'], match: ['vercel.com'] };
  const ssh: Place = { kind: 'terminal', tool: 'ssh', host: 'laptop', dest: 'build.example.com' };
  const sudo: Place = { kind: 'terminal', tool: 'sudo', host: 'kirin-box' };

  it('should make a site from login domains and what it is for, normalising each host', () => {
    should(placeOf({ domain: ['https://Accounts.Google.com/login'], for: ['Vercel.com'] })).eql(site);
    should(placeOf({ for: ['vercel.com'] })).eql({ kind: 'site', domains: [], match: ['vercel.com'] });
  });

  it('should refuse a host that is not a web host', () => {
    should(messageOf(() => placeOf({ domain: ['not a host!'] }))).equal(
      '"not a host!" is not a web host, like accounts.google.com',
    );
  });

  it('should make a terminal from the tool and host, lowercased and trimmed, with a destination for ssh', () => {
    should(placeOf({ tool: ' SUDO ', host: 'Kirin-Box' })).eql(sudo);
    should(placeOf({ tool: 'ssh', host: 'laptop', dest: ' Build.Example.com ' })).eql(ssh);
  });

  it('should say what the schema says when a terminal place is not a place', () => {
    should(messageOf(() => placeOf({ tool: 'ssh', host: 'laptop' }))).containEql('name their destination');
    should(messageOf(() => placeOf({ tool: 'sudo', host: 'box', dest: 'elsewhere' }))).containEql(
      'only ssh, scp and sftp have a destination',
    );
  });

  it('should refuse flags that name both a site and a terminal, or neither', () => {
    should(messageOf(() => placeOf({ domain: ['github.com'], tool: 'sudo' }))).containEql('not both');
    should(messageOf(() => placeOf({}))).containEql('say where it signs in');
  });

  it("should keep the other half of the current place: a site's other list, a terminal's other fields", () => {
    should(placeOf({ domain: ['github.com'] }, site)).eql({
      kind: 'site',
      domains: ['github.com'],
      match: ['vercel.com'],
    });
    should(placeOf({ for: ['npmjs.com'] }, site)).eql({
      kind: 'site',
      domains: ['accounts.google.com'],
      match: ['npmjs.com'],
    });
    should(placeOf({ host: 'other' }, ssh)).eql({ ...ssh, host: 'other' });
    should(placeOf({ tool: 'scp' }, ssh)).eql({ ...ssh, tool: 'scp' });
    should(placeOf({ dest: 'elsewhere.example.com' }, ssh)).eql({ ...ssh, dest: 'elsewhere.example.com' });
    should(placeOf({ host: 'other' }, sudo)).eql({ kind: 'terminal', tool: 'sudo', host: 'other' });
  });

  it('should refuse turning a site into a terminal or back by an edit', () => {
    should(messageOf(() => placeOf({ domain: ['github.com'] }, sudo))).containEql('that sign-in is in a terminal');
    should(messageOf(() => placeOf({ tool: 'sudo' }, site))).containEql('that sign-in is on a site');
  });
});

describe('methodOf', () => {
  it('should say nothing was asked when no method flag is given', () => {
    should(methodOf(undefined, {})).be.undefined();
  });

  it('should read a provider method, in any case', () => {
    should(methodOf(undefined, { method: ' Google ' })).eql({ kind: 'google' });
  });

  it('should refuse a passkey method and an unknown one', () => {
    should(messageOf(() => methodOf(undefined, { method: 'passkey' }))).containEql('passkeys are off');
    should(messageOf(() => methodOf(undefined, { method: 'carrier-pigeon' }))).containEql(
      '--method is one of password',
    );
  });

  it('should send --via only to a provider method, naming the provider by its account handle', () => {
    should(messageOf(() => methodOf(undefined, { via: 'GOOGLE_KIRIN' }))).containEql('--via is for a provider method');
    should(methodOf(undefined, { method: 'google', via: ' GOOGLE_KIRIN ' })).eql({
      kind: 'google',
      via: 'GOOGLE_KIRIN',
    });
    should(messageOf(() => methodOf(undefined, { method: 'google', via: 'not a handle' }))).containEql(
      'not a usable account handle',
    );
  });

  it('should keep the current method with --via alone, and the current via with --method alone', () => {
    const current = { kind: 'google', via: 'GOOGLE_KIRIN' } as const;
    should(methodOf(current, { via: 'GOOGLE_WORK' })).eql({ kind: 'google', via: 'GOOGLE_WORK' });
    should(methodOf(current, { method: 'github' })).eql({ kind: 'github', via: 'GOOGLE_KIRIN' });
  });

  it('should drop the provider with --no-via, and never send one with a password method', () => {
    const current = { kind: 'google', via: 'GOOGLE_KIRIN' } as const;
    should(methodOf(current, { via: false })).eql({ kind: 'google' });
    should(methodOf(current, { method: 'password' })).eql({ kind: 'password' });
  });

  it('should take an SSO name from the flag, or keep the current one when the method stays SSO', () => {
    should(methodOf(undefined, { method: 'sso', ssoName: ' Okta ' })).eql({ kind: 'sso', name: 'Okta' });
    should(methodOf({ kind: 'sso', name: 'Okta' }, { method: 'sso' })).eql({ kind: 'sso', name: 'Okta' });
  });

  it("should say the contract's reason when the method it makes is not one", () => {
    should(messageOf(() => methodOf(undefined, { method: 'sso' }))).containEql('name the SSO provider');
    should(messageOf(() => methodOf(undefined, { ssoName: 'Okta' }))).containEql('only other SSO takes a name');
  });
});

describe('recipeRefusal', () => {
  it('should leave an error that is not the daemon refusing as it is', () => {
    const plain = new Error('offline');
    should(recipeRefusal(plain)).equal(plain);
  });

  it("should put each known code in the owner's words", () => {
    should((recipeRefusal(new FyHttpError('x', 400, 'recipe_holds_value')) as Error).message).containEql(
      'a recipe never may',
    );
    should((recipeRefusal(new FyHttpError('x', 409, 'stale_proposal')) as Error).message).containEql(
      'the recipe changed after the ferret proposed this one',
    );
    should((recipeRefusal(new FyHttpError('x', 404, 'unknown_proposal')) as Error).message).containEql(
      'there is no such proposal',
    );
  });

  it('should leave a refusal with any other code, or none, as the daemon said it', () => {
    const other = new FyHttpError('nope', 500, 'something_else');
    const bare = new FyHttpError('nope', 500, undefined);
    should(recipeRefusal(other)).equal(other);
    should(recipeRefusal(bare)).equal(bare);
  });
});
