import { describe, expect, it } from 'bun:test';
import {
  factorAskWords,
  factorMismatch,
  factorMismatchWords,
  parseTotpInput,
  type Place,
  TOTP_INPUT_MAX_BYTES,
  TOTP_INPUT_PROBLEMS,
  type TwoFactorKeySummary,
  TwoFactorKeySummarySchema,
} from '../../src/lib/index.ts';

/** RFC 6238's test secret ("12345678901234567890"), base32. */
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const DEFAULTS = { algorithm: 'SHA1', digits: 6, period: 30 };
const AT = '2026-10-31T09:00:00.000Z';

const parsed = (text: string) => {
  const result = parseTotpInput(text);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const problem = (text: string): string => {
  const result = parseTotpInput(text);
  if (result.ok) throw new Error('parsed');
  return result.error;
};

describe('reading a pasted 2FA key', () => {
  it.each([
    ['a bare key', SEED, { seed: SEED, params: DEFAULTS }],
    [
      'a bare key in groups of four, lower case',
      'gezd gnbv gy3t qojq gezd gnbv gy3t qojq',
      { seed: SEED, params: DEFAULTS },
    ],
    [
      'a bare key with padding and dashes, around spaces',
      `  ${SEED.slice(0, 16)}-${SEED.slice(16)}==\n`,
      { seed: SEED, params: DEFAULTS },
    ],
    [
      'a link with every setting',
      `otpauth://totp/GitHub:kirinnee?secret=${SEED}&issuer=GitHub&algorithm=SHA256&digits=8&period=60`,
      { seed: SEED, params: { algorithm: 'SHA256', digits: 8, period: 60 }, issuer: 'GitHub', accountName: 'kirinnee' },
    ],
    [
      'a link whose label is %-escaped, with a space after the colon',
      `otpauth://totp/ACME%20Co:%20john.doe%40email.com?secret=${SEED}&issuer=ACME%20Co`,
      { seed: SEED, params: DEFAULTS, issuer: 'ACME Co', accountName: 'john.doe@email.com' },
    ],
    [
      'a link with the issuer only in its label',
      `otpauth://totp/Okta:bob@x.com?secret=${SEED}`,
      { seed: SEED, params: DEFAULTS, issuer: 'Okta', accountName: 'bob@x.com' },
    ],
    [
      'a link with the issuer only in its settings, in upper case, and a lower-case secret',
      `OTPAUTH://TOTP/kirin?SECRET=${SEED.toLowerCase()}&Issuer=Vercel&algorithm=sha512`,
      { seed: SEED, params: { ...DEFAULTS, algorithm: 'SHA512' }, issuer: 'Vercel', accountName: 'kirin' },
    ],
    [
      'a link with an image and a setting it does not know, and a `+` for a space',
      `otpauth://totp/Big+Co:me?secret=${SEED}&image=https%3A%2F%2Fexample.com%2Fx.png&color=red&issuer=Big+Co`,
      { seed: SEED, params: DEFAULTS, issuer: 'Big Co', accountName: 'me' },
    ],
    [
      'a link whose label issuer differs from its settings only in case',
      `otpauth://totp/github:kirinnee?secret=${SEED}&issuer=GitHub`,
      { seed: SEED, params: DEFAULTS, issuer: 'GitHub', accountName: 'kirinnee' },
    ],
    ['a link with an empty label', `otpauth://totp/?secret=${SEED}`, { seed: SEED, params: DEFAULTS }],
  ])('should read %s', (_name, text, expected) => {
    expect(parsed(text)).toEqual(expected as never);
  });

  it.each([
    ['nothing', '   ', TOTP_INPUT_PROBLEMS.empty],
    ['a key too short', 'GEZDGNBVGY3TQOJ', TOTP_INPUT_PROBLEMS.notAKey],
    ['a key with letters base32 has not', `${SEED.slice(0, 20)}0189`, TOTP_INPUT_PROBLEMS.notAKey],
    ['a web address', `https://example.com/?secret=${SEED}`, TOTP_INPUT_PROBLEMS.notAKey],
    ['a javascript: link', `javascript:alert('${SEED}')`, TOTP_INPUT_PROBLEMS.notAKey],
    ['a counter-based link', `otpauth://hotp/GitHub:kirin?secret=${SEED}&counter=1`, TOTP_INPUT_PROBLEMS.hotp],
    ['a link of a type it does not know', `otpauth://steam/x?secret=${SEED}`, TOTP_INPUT_PROBLEMS.notTotp],
    ['an authenticator export', `otpauth-migration://offline?data=${SEED}`, TOTP_INPUT_PROBLEMS.migration],
    ['a link with no label part', `otpauth://totp?secret=${SEED}`, TOTP_INPUT_PROBLEMS.shape],
    ['a link with no secret', 'otpauth://totp/GitHub:kirin?issuer=GitHub', TOTP_INPUT_PROBLEMS.noSecret],
    ['a link with an empty secret', 'otpauth://totp/GitHub:kirin?secret=', TOTP_INPUT_PROBLEMS.noSecret],
    [
      'a link with a secret that is not base32',
      'otpauth://totp/x?secret=hunter1hunter1hunter1',
      TOTP_INPUT_PROBLEMS.badSecret,
    ],
    [
      'a link naming its secret twice',
      `otpauth://totp/x?secret=${SEED}&secret=JBSWY3DPEHPK3PXPJBSWY3DP`,
      TOTP_INPUT_PROBLEMS.repeated,
    ],
    [
      'a link naming its issuer twice',
      `otpauth://totp/x?secret=${SEED}&issuer=A&ISSUER=B`,
      TOTP_INPUT_PROBLEMS.repeated,
    ],
    ['MD5', `otpauth://totp/x?secret=${SEED}&algorithm=MD5`, TOTP_INPUT_PROBLEMS.algorithm],
    ['an empty algorithm', `otpauth://totp/x?secret=${SEED}&algorithm=`, TOTP_INPUT_PROBLEMS.algorithm],
    ['SHA-1 spelt with a dash', `otpauth://totp/x?secret=${SEED}&algorithm=SHA-1`, TOTP_INPUT_PROBLEMS.algorithm],
    ['four digits', `otpauth://totp/x?secret=${SEED}&digits=4`, TOTP_INPUT_PROBLEMS.digits],
    ['ten digits', `otpauth://totp/x?secret=${SEED}&digits=10`, TOTP_INPUT_PROBLEMS.digits],
    ['six and a half digits', `otpauth://totp/x?secret=${SEED}&digits=6.5`, TOTP_INPUT_PROBLEMS.digits],
    ['a period of zero', `otpauth://totp/x?secret=${SEED}&period=0`, TOTP_INPUT_PROBLEMS.period],
    ['a period of a day', `otpauth://totp/x?secret=${SEED}&period=86400`, TOTP_INPUT_PROBLEMS.period],
    ['a negative period', `otpauth://totp/x?secret=${SEED}&period=-30`, TOTP_INPUT_PROBLEMS.period],
    ['a period in hex', `otpauth://totp/x?secret=${SEED}&period=0x1e`, TOTP_INPUT_PROBLEMS.period],
    ['two issuers', `otpauth://totp/GitHub:kirin?secret=${SEED}&issuer=Okta`, TOTP_INPUT_PROBLEMS.contradicts],
    [
      'two issuers with no Latin letters',
      `otpauth://totp/株式会社:kirin?secret=${SEED}&issuer=有限会社`,
      TOTP_INPUT_PROBLEMS.contradicts,
    ],
    ['a broken %-escape in the label', `otpauth://totp/Git%ZZHub:kirin?secret=${SEED}`, TOTP_INPUT_PROBLEMS.encoding],
    ['a broken %-escape in a setting', `otpauth://totp/x?secret=${SEED}&issuer=%E0%A4%A`, TOTP_INPUT_PROBLEMS.encoding],
    ['a line break inside', `otpauth://totp/x?secret=${SEED}\n&issuer=GitHub`, TOTP_INPUT_PROBLEMS.hidden],
    ['a %-escaped line break in the label', `otpauth://totp/GitHub%0Akirin?secret=${SEED}`, TOTP_INPUT_PROBLEMS.hidden],
    [
      'a bidi override in the issuer',
      `otpauth://totp/x?secret=${SEED}&issuer=Git%E2%80%AEHub`,
      TOTP_INPUT_PROBLEMS.hidden,
    ],
    ['a zero-width space in the label', `otpauth://totp/Git​Hub:kirin?secret=${SEED}`, TOTP_INPUT_PROBLEMS.hidden],
    [
      'an issuer past its length',
      `otpauth://totp/x?secret=${SEED}&issuer=${'a'.repeat(81)}`,
      TOTP_INPUT_PROBLEMS.longName,
    ],
    [
      'anything too long',
      `otpauth://totp/x?secret=${SEED}&pad=${'a'.repeat(TOTP_INPUT_MAX_BYTES)}`,
      TOTP_INPUT_PROBLEMS.tooLong,
    ],
    ['a bare key padded past the limit', `${SEED}${' '.repeat(TOTP_INPUT_MAX_BYTES)}`, TOTP_INPUT_PROBLEMS.tooLong],
  ])('should refuse %s, saying why', (_name, text, expected) => {
    expect(problem(text)).toBe(expected);
  });

  it('should never repeat any part of what was pasted in a refusal', () => {
    // Arrange — hostile inputs that each carry the secret, refused for every reason there is
    const inputs = [
      `otpauth://hotp/x?secret=${SEED}`,
      `otpauth://totp/x?secret=${SEED}&algorithm=MD5`,
      `otpauth://totp/x?secret=${SEED}&secret=${SEED}`,
      `otpauth://totp/GitHub:x?secret=${SEED}&issuer=Okta`,
      `otpauth://totp/%ZZ?secret=${SEED}`,
      `otpauth://totp/x?secret=${SEED}‮`,
      `https://${SEED}.example`,
      `${SEED}!`,
      `otpauth-migration://offline?data=${SEED}`,
    ];

    // Act
    const refusals = inputs.map(problem);

    // Assert
    for (const refusal of refusals) {
      expect(Object.values(TOTP_INPUT_PROBLEMS)).toContain(refusal as never);
      for (const piece of [SEED, SEED.toLowerCase(), SEED.slice(0, 8), 'GitHub', 'Okta', 'MD5'])
        expect(refusal).not.toContain(piece);
    }
  });
});

const GITHUB = { label: 'GitHub (kirinnee)', username: 'kirinnee' };
const github: Place = { kind: 'site', domains: ['github.com'], match: [] };
const okta: Place = { kind: 'site', domains: ['company.okta.com'], match: ['clickup.com'] };

describe('whether a pasted key is for the account it is being saved to', () => {
  it.each([
    ['the issuer is the site', GITHUB, [github], { issuer: 'GitHub', accountName: 'kirinnee' }],
    [
      'the issuer, punctuated, is part of the label',
      { label: 'Git-Hub work', username: 'kirinnee' },
      [],
      { issuer: 'git hub' },
    ],
    ['the issuer is a host label of a sign-in', { label: 'ClickUp' }, [okta], { issuer: 'Okta' }],
    [
      'the account name is the username in another case',
      GITHUB,
      [github],
      { issuer: 'GitHub', accountName: ' KirinNee ' },
    ],
    [
      'the account name is an email whose local part is the username',
      GITHUB,
      [github],
      { accountName: 'kirinnee@example.com' },
    ],
    [
      'the account has no username to compare',
      { label: 'GitHub' },
      [github],
      { issuer: 'GitHub', accountName: 'anyone' },
    ],
    ['the key is bare', GITHUB, [github], {}],
    ['a non-Latin issuer is the label exactly', { label: '株式会社' }, [], { issuer: '株式会社' }],
    [
      'the issuer is the registrable label of an ssh destination',
      { label: 'Build box' },
      [{ kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'build.example.com' }],
      { issuer: 'Example' },
    ],
  ])('should find nothing amiss when %s', (_name, account, places, key) => {
    expect(factorMismatch(account, places as Place[], key)).toBeUndefined();
  });

  it.each([
    ['the issuer is another site', GITHUB, [github], { issuer: 'Okta', accountName: 'kirinnee' }, { issuer: 'Okta' }],
    [
      'the account name is someone else',
      GITHUB,
      [github],
      { issuer: 'GitHub', accountName: 'bob@x.com' },
      { accountName: 'bob@x.com' },
    ],
    [
      'both differ',
      GITHUB,
      [github],
      { issuer: 'Okta', accountName: 'bob@x.com' },
      { issuer: 'Okta', accountName: 'bob@x.com' },
    ],
    ['the issuer is too short to be part of a name', GITHUB, [github], { issuer: 'Gi' }, { issuer: 'Gi' }],
    [
      'the issuer has no letters or digits to compare',
      GITHUB,
      [github],
      { issuer: '株式会社' },
      { issuer: '株式会社' },
    ],
    ['the issuer is only the top-level domain', GITHUB, [github], { issuer: 'com' }, { issuer: 'com' }],
    [
      'a Cyrillic look-alike of the provider (L3)',
      { label: 'ClickUp' },
      [okta],
      { issuer: 'Оkta' },
      { issuer: 'Оkta' },
    ],
    ['a fragment of the provider', { label: 'ClickUp' }, [okta], { issuer: 'kta' }, { issuer: 'kta' }],
    ['the top-level domain of the provider', { label: 'ClickUp' }, [okta], { issuer: 'com' }, { issuer: 'com' }],
    [
      'a fragment of a host label that is not the registrable one',
      { label: 'ClickUp' },
      [okta],
      { issuer: 'pan' },
      { issuer: 'pan' },
    ],
    [
      'a host label that is not the registrable one',
      { label: 'ClickUp' },
      [okta],
      { issuer: 'Company' },
      { issuer: 'Company' },
    ],
    ['part of a word of the label', { label: 'GitHub work' }, [], { issuer: 'Hub' }, { issuer: 'Hub' }],
    [
      'a non-Latin issuer that is only part of the label',
      { label: '株式会社 GitHub' },
      [],
      { issuer: '株式会社' },
      { issuer: '株式会社' },
    ],
    [
      'the account name is a username plus more',
      GITHUB,
      [github],
      { accountName: 'kirinnee2' },
      { accountName: 'kirinnee2' },
    ],
    [
      'the username is an email and the name is its local part',
      { label: 'GitHub', username: 'kirin@x.com' },
      [github],
      { accountName: 'kirin' },
      { accountName: 'kirin' },
    ],
  ])('should name what differs when %s', (_name, account, places, key, expected) => {
    expect(factorMismatch(account, places as Place[], key)).toEqual(expected);
  });

  it('should word the amber box from what the key says and where it is going', () => {
    expect(
      factorMismatchWords({ issuer: 'Okta', accountName: 'bob@x.com' }, { label: 'GitHub', username: 'kirinnee' }),
    ).toBe("This key says it is for Okta · bob@x.com, but you're saving it to GitHub · kirinnee.");
    expect(factorMismatchWords({ issuer: 'Okta' }, { label: 'GitHub' })).toBe(
      "This key says it is for Okta, but you're saving it to GitHub.",
    );
  });
});

const key = (extra: object): TwoFactorKeySummary =>
  TwoFactorKeySummarySchema.parse({ id: 'tf_000000000001', addedAt: AT, addedBy: 'owner', automatic: false, ...extra });

describe('a code card’s title', () => {
  const sms = key({ kind: 'sms', label: 'Phone', endsWith: '42' });
  const email = key({ kind: 'email', label: 'Work inbox', to: 'kirin@…' });
  const totp = key({ kind: 'totp', label: 'Authenticator app' });
  const push = key({ kind: 'push', label: 'Okta Verify' });

  it.each([
    ['an SMS key', [sms], 'Code sent to ••42 (SMS)'],
    ['an SMS key with no digits', [key({ kind: 'sms', label: 'Phone' })], 'Code sent by SMS (Phone)'],
    ['an email key', [email], 'Code sent to kirin@… (email)'],
    ['an email key with no address', [key({ kind: 'email', label: 'Work inbox' })], 'Code sent by email (Work inbox)'],
    ['an authenticator', [totp], 'Code from Authenticator app'],
    ['one code key among others', [push, totp], 'Code from Authenticator app'],
    ['several code keys', [sms, totp, email], 'One-time code: SMS ••42 or Authenticator app or email to kirin@…'],
    ['no code key', [push], 'One-time code for GitHub · kirinnee'],
    ['no key at all', [], 'One-time code for GitHub · kirinnee'],
  ])('should name %s', (_name, keys, expected) => {
    expect(factorAskWords(keys, { label: 'GitHub', username: 'kirinnee' })).toBe(expected);
  });
});
