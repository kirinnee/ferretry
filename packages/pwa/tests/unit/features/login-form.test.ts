import { describe, expect, it } from 'bun:test';
import {
  domainsWords,
  METHOD_OPTIONS,
  methodWords,
  parseDomains,
  signInDraftOf,
  signInProblem,
  viaChoices,
  addTotpBody,
  canAddLogin,
  editLoginBody,
  fieldWords,
  handleFromLabel,
  newLoginBody,
  newLoginProblem,
  parseMatch,
  passwordProblem,
  removeTotpBody,
  replacePasswordBody,
} from '../../../src/lib/login-form.ts';
import { login, signInLogins } from '../../support/input-fixtures.ts';

const draft = {
  label: 'GitHub (kirinnee)',
  id: 'GITHUB_KIRINNEE',
  match: 'github.com',
  username: 'kirinnee',
  password: 'longenough1',
  method: 'password' as const,
  ssoName: '',
  via: '',
  domains: '',
};
const signIn = { method: 'password' as const, ssoName: '', via: '', domains: 'github.com' };

describe('adding a login', () => {
  it('builds the body with the match as a list and leaves a blank username out', () => {
    expect(newLoginBody({ ...draft, match: 'GitHub.com, sudo@kirin-box', username: ' ' })).toEqual({
      label: 'GitHub (kirinnee)',
      match: ['github.com', 'sudo@kirin-box'],
      password: 'longenough1',
    });
  });

  it('needs a long enough password, a free handle and a valid match', () => {
    expect(canAddLogin(draft, [])).toBe(true);
    expect(canAddLogin({ ...draft, password: 'short' }, [])).toBe(false);
    expect(newLoginProblem({ ...draft, password: 'short' }, [])).toContain('at least 8');
    expect(newLoginProblem(draft, ['GITHUB_KIRINNEE'])).toContain('already exists');
    expect(newLoginProblem({ ...draft, match: 'not a host!' }, [])).toContain('not a program@host');
  });

  it('suggests a handle from the label', () => {
    expect(handleFromLabel('GitHub (kirinnee)')).toBe('GITHUB_KIRINNEE');
    expect(parseMatch(' A.com ,, b@c ')).toEqual(['a.com', 'b@c']);
  });
});

describe('editing a login', () => {
  it('sends only what changed, so the password and the 2FA seed are kept', () => {
    const entry = login();
    expect(
      editLoginBody(entry, { label: entry.label, match: 'github.com', username: 'kirinnee', ...signIn }),
    ).toBeUndefined();
    expect(editLoginBody(entry, { label: 'GH', match: 'github.com', username: 'kirinnee', ...signIn })).toEqual({
      label: 'GH',
    });
  });

  it('removes a username with null', () => {
    expect(
      editLoginBody(login(), { label: 'GitHub (kirinnee)', match: 'github.com', username: '', ...signIn }),
    ).toEqual({
      username: null,
    });
  });

  it('replaces a password with nothing else in the body', () => {
    expect(replacePasswordBody('another-long-one')).toEqual({ password: 'another-long-one' });
  });
});

describe('2FA', () => {
  it('builds nothing without the tick, then the seed with the acknowledgement', () => {
    expect(addTotpBody('JBSWY3DPEHPK3PXP', false)).toBeUndefined();
    expect(addTotpBody('JBSWY3DPEHPK3PXP', true)).toEqual({
      totp: { seed: 'JBSWY3DPEHPK3PXP' },
      totpAcknowledged: true,
    });
  });

  it('refuses something that is not a seed, and removes with null', () => {
    expect(addTotpBody('nope', true)).toBeUndefined();
    expect(removeTotpBody()).toEqual({ totp: null });
  });
});

describe('what a row says about an entry', () => {
  it('names which secret fields exist and nothing about their values', () => {
    expect(fieldWords(login())).toEqual(['password ✓', 'no 2FA']);
    expect(fieldWords(login({ fields: { password: true, totp: true } }))).toEqual(['password ✓', '2FA ✓']);
  });
});

describe('the sentences under the add form', () => {
  it('says a label or a handle that will not do, before the button is pressed', () => {
    expect(newLoginProblem({ ...draft, label: 'x'.repeat(81) }, [])).toBe('A label is at most 80 characters.');
    expect(newLoginProblem({ ...draft, id: 'github-kirinnee' }, [])).toContain('uppercase letters, digits');
  });

  it('says a password is too short only once something is typed', () => {
    expect(passwordProblem('')).toBeUndefined();
    expect(passwordProblem('abc')).toBe('At least 8 characters.');
    expect(passwordProblem('long enough')).toBeUndefined();
  });
});

describe('how a login signs in', () => {
  const entries = signInLogins().entries;
  const [vercel, google] = entries;

  it('sends no method for a plain password, and the method whole for a provider', () => {
    expect(newLoginBody(draft)).not.toHaveProperty('method');
    expect(newLoginBody({ ...draft, method: 'google', via: 'GOOGLE_KIRIN' })).toMatchObject({
      method: { kind: 'google', via: 'GOOGLE_KIRIN' },
    });
    expect(newLoginBody({ ...draft, method: 'google', via: '' }).method).toEqual({ kind: 'google' });
    expect(newLoginBody({ ...draft, method: 'sso', ssoName: ' Okta ' }).method).toEqual({ kind: 'sso', name: 'Okta' });
  });

  it('drops a via that a password sign-in could not carry', () => {
    expect(newLoginBody({ ...draft, method: 'password', via: 'GOOGLE_KIRIN' })).not.toHaveProperty('method');
  });

  it('needs a name for other SSO and refuses a passkey one', () => {
    expect(signInProblem({ ...signIn, method: 'sso' })).toContain('Name the SSO provider');
    expect(canAddLogin({ ...draft, method: 'sso', ssoName: '' }, [])).toBe(false);
    expect(signInProblem({ ...signIn, method: 'sso', ssoName: 'Passkey' })).toContain('passkeys are off');
    expect(signInProblem({ ...signIn, method: 'sso', ssoName: 'my security key' })).toContain('passkeys are off');
    expect(newLoginProblem({ ...draft, method: 'sso', ssoName: 'WebAuthn' }, [])).toContain('passkeys are off');
    expect(signInProblem({ ...signIn, method: 'sso', ssoName: 'Okta' })).toBeUndefined();
  });

  it('has no passkey among the methods', () => {
    expect(METHOD_OPTIONS.map(option => option.label)).toEqual([
      'Password',
      'Sign in with Google',
      'Sign in with GitHub',
      'Sign in with Microsoft',
      'Sign in with Apple',
      'Other SSO',
    ]);
  });

  it('parses and normalises login domains, and says which one is not a host', () => {
    expect(parseDomains(' https://App.Vercel.com/login , accounts.google.com,, ')).toEqual([
      'app.vercel.com',
      'accounts.google.com',
    ]);
    expect(signInProblem({ ...signIn, domains: 'app.vercel.com, not a host!' })).toBe(
      '"not a host!" is not a web host, like app.vercel.com.',
    );
    expect(newLoginBody({ ...draft, domains: 'App.Vercel.com, https://accounts.google.com/x' }).domains).toEqual([
      'app.vercel.com',
      'accounts.google.com',
    ]);
    expect(newLoginBody(draft)).not.toHaveProperty('domains');
  });

  it('offers every other login as a via, never the one being edited', () => {
    expect(viaChoices(entries, 'VERCEL').map(choice => choice.id)).toEqual(['GOOGLE_KIRIN', 'GITHUB_KIRINNEE']);
    expect(viaChoices(entries, undefined)).toHaveLength(3);
  });

  it('sends the whole method only when it changed, and the domains only when they changed', () => {
    const same = signInDraftOf(vercel, entries);
    const base = { label: 'Vercel', match: 'vercel.com', username: '', ...same };
    expect(editLoginBody(vercel!, base)).toBeUndefined();
    expect(editLoginBody(vercel!, { ...base, method: 'github' })).toEqual({
      method: { kind: 'github', via: 'GOOGLE_KIRIN' },
    });
    expect(editLoginBody(vercel!, { ...base, method: 'password' })).toEqual({ method: { kind: 'password' } });
    expect(editLoginBody(vercel!, { ...base, via: '' })).toEqual({ method: { kind: 'google' } });
    expect(editLoginBody(vercel!, { ...base, domains: 'app.vercel.com, vercel.com' })).toEqual({
      domains: ['app.vercel.com', 'vercel.com'],
    });
    expect(editLoginBody(vercel!, { ...base, domains: 'nope!' })).toBeUndefined();
  });

  it('reads an older entry as a password one, with its web match hosts as login domains', () => {
    const old = login({ match: ['sudo@kirin-box', 'github.com'] });
    expect(signInDraftOf(old, [old])).toEqual({ method: 'password', ssoName: '', via: '', domains: 'github.com' });
    expect(methodWords(old, [old])).toBe('Password');
    expect(domainsWords(old)).toBe('sign-in on github.com');
    expect(
      editLoginBody(old, {
        label: old.label,
        match: 'sudo@kirin-box, github.com',
        username: 'kirinnee',
        ...signInDraftOf(old, [old]),
      }),
    ).toBeUndefined();
  });

  it('says a provider sign-in in words, naming the provider login', () => {
    expect(methodWords(vercel!, entries)).toBe("Sign in with Google via 'Google (kirin@…)'");
    expect(domainsWords(google!)).toBe('sign-in on accounts.google.com');
    expect(domainsWords(login({ match: ['sudo@kirin-box'] }))).toBeUndefined();
  });

  it('starts a dangling via as none', () => {
    expect(signInDraftOf(vercel, [vercel!]).via).toBe('');
  });
});
