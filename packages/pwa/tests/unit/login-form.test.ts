import { describe, expect, it } from 'bun:test';
import {
  addTotpBody,
  canAddLogin,
  editLoginBody,
  fieldWords,
  handleFromLabel,
  newLoginBody,
  newLoginProblem,
  parseMatch,
  removeTotpBody,
  replacePasswordBody,
} from '../../src/lib/login-form.ts';
import { login } from '../support/input-fixtures.ts';

const draft = {
  label: 'GitHub (kirinnee)',
  id: 'GITHUB_KIRINNEE',
  match: 'github.com',
  username: 'kirinnee',
  password: 'longenough1',
};

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
    expect(editLoginBody(entry, { label: entry.label, match: 'github.com', username: 'kirinnee' })).toBeUndefined();
    expect(editLoginBody(entry, { label: 'GH', match: 'github.com', username: 'kirinnee' })).toEqual({ label: 'GH' });
  });

  it('removes a username with null', () => {
    expect(editLoginBody(login(), { label: 'GitHub (kirinnee)', match: 'github.com', username: '' })).toEqual({
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
