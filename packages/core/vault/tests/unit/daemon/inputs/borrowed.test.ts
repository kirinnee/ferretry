import { describe, it } from 'bun:test';
import should from 'should';
import { site } from './grant-fixtures.ts';
import {
  AccountListSchema,
  automaticKeysInOfferOrder,
  chosenSignIn,
  factorAskWords,
  grantFilledLineFor,
  InputSavedSchema,
  oneLine,
  type SignInCandidate,
  type TwoFactorKeySummary,
} from '../../../../daemon/lib/inputs/borrowed.ts';

/**
 * What the input service borrows from Accounts, said through its own exports: the order a code card offers its keys
 * in, the account a sign-in card offers first, the words of a code card and of a filled line, and the rules the wire
 * schemas keep for what an owner's card may carry.
 */

const KEY = (id: string, over: Record<string, unknown> = {}): TwoFactorKeySummary =>
  ({
    id,
    kind: 'totp',
    label: id,
    addedAt: '2026-10-01T00:00:00.000Z',
    addedBy: 'owner',
    automatic: true,
    params: { algorithm: 'SHA1', digits: 6, period: 30 },
    ...over,
  }) as TwoFactorKeySummary;

describe('the order a code card offers its keys in', () => {
  it('I171 should offer a key that worked first, then one never tried, then one that failed, newest first within each', () => {
    const keys = [
      KEY('tf_0000000000f1', { verified: { worked: false, at: '2026-10-02T00:00:00.000Z' } }),
      KEY('tf_0000000000n1', { addedAt: '2026-10-01T00:00:00.000Z' }),
      KEY('tf_0000000000n2', { addedAt: '2026-10-05T00:00:00.000Z' }),
      KEY('tf_0000000000w1', { verified: { worked: true, at: '2026-10-02T00:00:00.000Z' } }),
      KEY('tf_0000000000s1', { kind: 'sms', automatic: false, params: undefined, endsWith: '42' }),
    ];

    should(automaticKeysInOfferOrder(keys).map(key => key.id)).eql([
      'tf_0000000000w1',
      'tf_0000000000n2',
      'tf_0000000000n1',
      'tf_0000000000f1',
    ]);
  });

  it('should settle keys added at the same moment by their id, so the order never depends on how they were listed', () => {
    const a = KEY('tf_0000000000a1');
    const b = KEY('tf_0000000000b1');

    should(automaticKeysInOfferOrder([b, a]).map(key => key.id)).eql(['tf_0000000000a1', 'tf_0000000000b1']);
    should(automaticKeysInOfferOrder([a, b]).map(key => key.id)).eql(['tf_0000000000a1', 'tf_0000000000b1']);
  });
});

describe('the account a sign-in card offers first', () => {
  const candidate = (id: string, account: string): SignInCandidate => ({
    id: id as never,
    account: account as never,
    place: { kind: 'site', domains: ['github.com'], match: ['github.com'] },
  });
  const two = [candidate('si_00000000000000a1', 'WORK'), candidate('si_00000000000000b1', 'HOME')];

  it('should follow the longest folder line the session’s folder is inside, ~ meaning the home folder', () => {
    const defaults = {
      folders: {
        '/': { 'github.com': 'HOME' },
        '~/work': { 'github.com': 'WORK' },
        '~/work/oss': { 'github.com': 'HOME' },
      },
    };

    const inWork = chosenSignIn('github.com', two, { folder: '/home/kirin/work/api', home: '/home/kirin', defaults });
    const inOss = chosenSignIn('github.com', two, { folder: '/home/kirin/work/oss/x', home: '/home/kirin', defaults });
    const elsewhere = chosenSignIn('github.com', two, { folder: '/srv/app', home: '/home/kirin', defaults });

    should(inWork).eql({ signIn: 'si_00000000000000a1', why: 'folder' });
    should(inOss).eql({ signIn: 'si_00000000000000b1', why: 'folder' });
    should(elsewhere).eql({ signIn: 'si_00000000000000b1', why: 'folder' });
  });

  it('should ignore a folder line it cannot place: no home for ~, a relative path, a . or .. segment', () => {
    const defaults = {
      folders: {
        '~': { 'github.com': 'WORK' },
        '/home/kirin/../root': { 'github.com': 'WORK' },
        'relative/path': { 'github.com': 'WORK' },
      },
    };

    should(chosenSignIn('github.com', two, { folder: '/home/kirin/x', defaults })).be.undefined();
    should(chosenSignIn('github.com', two, { folder: '/home/kirin/x', home: '/home/kirin', defaults })).eql({
      signIn: 'si_00000000000000a1',
      why: 'folder',
    });
    should(chosenSignIn('github.com', two, { folder: '../escape', home: '/home/kirin', defaults })).be.undefined();
    should(chosenSignIn('github.com', two, { folder: '/x', defaults: {} })).be.undefined();
  });

  it('should prefer the session’s board project over its folder, by id and then by a unique name', () => {
    const defaults = {
      projects: { 'p-1': { 'github.com': 'WORK' }, ferretry: { 'github.com': 'HOME' } },
      folders: { '/': { 'github.com': 'HOME' } },
    };

    const byId = chosenSignIn('github.com', two, {
      project: { id: 'p-1', name: 'ferretry', nameIsUnique: true },
      folder: '/x',
      defaults,
    });
    const byName = chosenSignIn('github.com', two, {
      project: { id: 'p-2', name: 'ferretry', nameIsUnique: true },
      defaults,
    });
    const notUnique = chosenSignIn('github.com', two, {
      project: { id: 'p-2', name: 'ferretry', nameIsUnique: false },
      defaults,
    });

    should(byId).eql({ signIn: 'si_00000000000000a1', why: 'project', project: 'ferretry' });
    should(byName).eql({ signIn: 'si_00000000000000b1', why: 'project', project: 'ferretry' });
    should(notUnique).be.undefined();
  });
});

describe('the words a card is given', () => {
  it('I167 should word a code card by the place and the kinds of key alone, never a label, digits or address', () => {
    const sms = KEY('tf_0000000000a2', {
      kind: 'sms',
      automatic: false,
      params: undefined,
      endsWith: '42',
      label: 'Phone',
    });
    const email = KEY('tf_0000000000a3', {
      kind: 'email',
      automatic: false,
      params: undefined,
      to: 'k@x.io',
      label: 'Mail',
    });

    should(factorAskWords([], { place: 'github.com' })).equal('One-time code for github.com');
    should(factorAskWords([KEY('tf_0000000000a1'), sms, email], { place: 'github.com' })).equal(
      'One-time code for github.com, by authenticator app or SMS or email',
    );
    should(factorAskWords([sms, sms], { place: 'github.com' })).equal('One-time code for github.com, by SMS');
    should(factorAskWords([sms], { place: 'github.com' })).not.containEql('42');
  });

  it('should say which plan line filled a card, numbered from 1, and where when it is known', () => {
    should(grantFilledLineFor({ by: 'plan', line: 0 })).equal('Filled under your task plan (line 1).');
    should(grantFilledLineFor({ by: 'plan', line: 2 }, 'github.com')).equal(
      'Filled under your task plan (line 3) on github.com.',
    );
    should(grantFilledLineFor({ by: 'plan', line: 2 }, '')).equal('Filled under your task plan (line 3).');
  });

  it('should keep a single line of plain text from oneLine: no line break, tab or hidden character', () => {
    const line = oneLine(10);

    should(line.safeParse('  kirin  ').data).equal('kirin');
    for (const bad of ['two\nlines', 'a\tb', 'zero​width', '', 'x'.repeat(11)])
      should(line.safeParse(bad).success).be.false();
  });
});

describe('what an owner’s card may carry about saved logins', () => {
  const offer = (over: Record<string, unknown> = {}) => ({
    id: 'GITHUB',
    label: 'GitHub',
    fills: 'password',
    matched: true,
    signIn: 'si_00000000000000a1',
    ...over,
  });
  const parse = (offers: unknown[], extra: Record<string, unknown> = {}) =>
    InputSavedSchema.safeParse({ offers, ...extra });
  const refusedAt = (offers: unknown[]) => parse(offers).error?.issues.map(issue => issue.path.join('.'));

  it('should accept an offer that signs in here and a one-tap choice that says why', () => {
    should(parse([offer({ primary: true, why: 'only' })]).success).be.true();
    should(parse([offer({ matched: false, signIn: undefined, elsewhere: [] })]).success).be.true();
  });

  it('should refuse the keys of a code on an offer that is not matched, has no sign-in, or does not fill a code', () => {
    const codes = [{ factor: 'tf_0000000000a1', label: 'App' }];

    should(refusedAt([offer({ codes })])).eql(['offers.0.codes']);
    should(refusedAt([offer({ codes, fills: 'totp', matched: false })])).containEql('offers.0.codes');
    should(refusedAt([offer({ codes, fills: 'totp', signIn: undefined })])).containEql('offers.0.codes');
    should(parse([offer({ codes, fills: 'totp' })]).success).be.true();
  });

  it('should refuse an offer that both signs in here and comes from somewhere else', () => {
    should(refusedAt([offer({ elsewhere: ['gitlab.com'] })])).containEql('offers.0.elsewhere');
  });

  it('should refuse a one-tap choice that is not matched, names no sign-in, or does not say why (and the reverse)', () => {
    should(refusedAt([offer({ primary: true, matched: false, signIn: undefined, why: 'only' })])).containEql(
      'offers.0.primary',
    );
    should(refusedAt([offer({ primary: true, signIn: undefined, why: 'only' })])).containEql('offers.0.signIn');
    should(refusedAt([offer({ primary: true })])).containEql('offers.0.why');
    should(refusedAt([offer({ why: 'only' })])).containEql('offers.0.why');
  });

  it('should name a project only when a project default chose the offer', () => {
    should(refusedAt([offer({ primary: true, why: 'only', project: 'ferretry' })])).containEql('offers.0.project');
    should(parse([offer({ primary: true, why: 'project', project: 'ferretry' })]).success).be.true();
  });

  it('should name the SSO provider of a sign-in that goes through one, and only then', () => {
    const signIn = (method: Record<string, unknown>) => ({ id: 'GITHUB', label: 'GitHub', method });
    const at = (method: Record<string, unknown>) =>
      parse([], { signIn: signIn(method) }).error?.issues.map(issue => issue.path.join('.'));

    should(at({ kind: 'sso' })).containEql('signIn.method.name');
    should(at({ kind: 'password', name: 'Okta' })).containEql('signIn.method.name');
    should(at({ kind: 'password', via: 'GOOGLE' })).containEql('signIn.method.via');
    should(parse([], { signIn: signIn({ kind: 'sso', name: 'Okta' }) }).success).be.true();
    should(parse([], { signIn: signIn({ kind: 'password' }) }).success).be.true();
  });
});

describe('what the saved-logins listing keeps of a recipe and a ferret’s proposal', () => {
  const listing = (signIn: Record<string, unknown>) => ({
    v: 1,
    health: 'ready',
    accounts: [],
    signIns: [{ ...site(), id: 'si_0123456789abcdef', ...signIn }],
  });
  const proposal = (over: Record<string, unknown> = {}) => ({
    id: 'rp_0123456789abcdef',
    recipe: 'Open github.com → Continue',
    why: 'the button moved',
    sessionId: 'mvv6b4qw-49d0158d',
    proposedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  });

  it('should keep a recipe plain: lines and tabs, no hidden character, and not the fence a hint closes it with', () => {
    should(AccountListSchema.safeParse(listing({ recipe: 'Open github.com\n\t→ Continue' })).success).be.true();
    for (const bad of ['zero\u200bwidth', 'close <<<recipe early', 'or recipe>>> here', ''])
      should(AccountListSchema.safeParse(listing({ recipe: bad })).success).be.false();
  });

  it('should keep the reason of a proposal to one line of plain text', () => {
    should(AccountListSchema.safeParse(listing({ proposals: [proposal()] })).success).be.true();
    for (const bad of ['two\nlines', 'a\ttab', 'zero\u200bwidth'])
      should(AccountListSchema.safeParse(listing({ proposals: [proposal({ why: bad })] })).success).be.false();
  });
});
