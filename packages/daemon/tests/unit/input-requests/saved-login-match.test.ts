import { describe, it } from 'bun:test';
import type { AccountSummary, InputSaved, InputTargetFacts, SignInSummary } from '@ferretry/protocol';
import should from 'should';
import {
  codeCardKeys,
  codeTargetProblem,
  remoteHostOf,
  type SavedListing,
  savedFieldFor,
  savedFor,
  savedForFields,
  signInFor,
  shortHost,
  targetMatchKey,
} from '../../../src/lib/input-requests/saved-logins.ts';
const terminal = (comm: string, argv: string): InputTargetFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 1 },
  foreground: { pid: 2, pgid: 2, comm, argv },
  echo: 'off',
  cursorRow: 0,
  promptLine: '',
  promptLineDigest: 'a'.repeat(64),
  program: comm,
  canonical: true,
  recognisedConsumer: true,
});

const browser = (origin: string): InputTargetFacts => ({
  kind: 'browser',
  pageId: 'p',
  origin,
  secure: true,
  navigationId: 'n',
  fields: [
    {
      fieldId: 'value',
      frameOrigin: origin,
      frameId: 'f',
      backendNodeId: 1,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 1, h: 1 },
      visible: true,
    },
  ],
});

describe('which saved login is for a target', () => {
  it('should key a local program by this machine’s short name', () => {
    should(targetMatchKey(terminal('sudo', 'sudo -v'), 'Kirin-Box.local')).equal('sudo@kirin-box');
    should(targetMatchKey(terminal('gpg', 'gpg --sign'), 'laptop')).equal('gpg@laptop');
    should(shortHost('  ')).be.undefined();
    should(targetMatchKey(terminal('sudo', 'sudo'), '')).be.undefined();
  });

  it('should key nothing when the program is unproved, so a shell named sudo never gets the sudo login one-tap', () => {
    const disguised = { ...terminal('sudo', 'sudo -v'), program: undefined } as InputTargetFacts;
    should(targetMatchKey(disguised, 'kirin-box')).be.undefined();
    // The proved program decides, not the name the process gave itself.
    const proved = { ...terminal('bash', 'bash'), program: 'sudo' } as InputTargetFacts;
    should(targetMatchKey(proved, 'kirin-box')).equal('sudo@kirin-box');
  });

  it('should key nothing when a proved program reads key by key: ssh -t would relay the password (L2)', () => {
    for (const canonical of [false, undefined])
      should(
        targetMatchKey({ ...terminal('ssh', 'ssh -t build'), canonical } as InputTargetFacts, 'box'),
      ).be.undefined();
    should(targetMatchKey(terminal('ssh', 'ssh build'), 'box')).equal('ssh@build');
  });

  it('should key ssh, scp and sftp by the destination on the command line', () => {
    should(targetMatchKey(terminal('ssh', 'ssh -p 2222 -i key kirin@Build.Example.com'), 'box')).equal(
      'ssh@build.example.com',
    );
    should(targetMatchKey(terminal('scp', 'scp -P 22 file.txt'), 'box')).equal('scp@file.txt');
    should(remoteHostOf('ssh -o StrictHostKeyChecking=no -- host.example')).equal('host.example');
    should(remoteHostOf('ssh ssh://kirin@host.example:2222')).equal('host.example');
    should(remoteHostOf('ssh -v')).be.undefined();
    should(targetMatchKey(terminal('ssh', 'ssh -v'), 'box')).be.undefined();
  });

  it('should key a page by its origin’s host, and nothing for an origin it cannot read', () => {
    should(targetMatchKey(browser('https://GitHub.com'), 'box')).equal('github.com');
    should(targetMatchKey(browser('https://localhost:8443'), 'box')).equal('localhost:8443');
    should(targetMatchKey(browser('not a url'), 'box')).be.undefined();
  });
});

const AT = 'a';
const account = (id: string, extra: Partial<AccountSummary> = {}): AccountSummary => ({
  id,
  label: id.toLowerCase(),
  fields: { password: true, totp: false },
  factors: [],
  signIns: [],
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});
let next = 0;
const sid = (): string => `si_${(++next).toString(16).padStart(16, '0')}`;
/** A sign-in of `owner` on a site: where it signs in (`domains`) and what it is for (`match`, the same by default). */
const site = (
  owner: string,
  domains: string[],
  extra: Partial<SignInSummary> & { match?: string[] } = {},
): SignInSummary => {
  const { match, ...rest } = extra;
  return {
    id: sid(),
    account: owner,
    place: { kind: 'site', domains, match: match ?? domains },
    method: { kind: 'password' },
    createdAt: AT,
    updatedAt: AT,
    ...rest,
  };
};
const tty = (owner: string, tool: string, host: string, dest?: string): SignInSummary => ({
  id: sid(),
  account: owner,
  place: { kind: 'terminal', tool, host, ...(dest === undefined ? {} : { dest }) },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
});
const listing = (accounts: AccountSummary[], signIns: SignInSummary[]): SavedListing => ({ accounts, signIns });
const EMPTY = listing([], []);
const offersOf = (saved: InputSaved) =>
  saved.offers.map(offer => [offer.id, offer.matched, offer.primary === true ? offer.why : undefined]);

describe('what a card offers', () => {
  it('should offer only accounts holding the field: the primary, then matched by label, then by hand', () => {
    const match = tty('MATCH', 'sudo', 'box');
    const saved = savedFor(
      'secret',
      'sudo@box',
      listing(
        [
          account('ZED'),
          account('ALPHA'),
          account('HINTED'),
          account('MATCH'),
          account('NO_PASSWORD', { fields: { password: false, totp: false } }),
        ],
        [tty('ZED', 'sudo', 'other'), tty('ALPHA', 'sudo', 'other'), match, tty('NO_PASSWORD', 'sudo', 'box')],
      ),
      { hint: 'HINTED' },
    );
    should(saved.offers.map(offer => [offer.id, offer.matched, offer.hinted === true, offer.signIn])).deepEqual([
      ['MATCH', true, false, match.id],
      ['HINTED', false, true, undefined],
      ['ALPHA', false, false, undefined],
      ['ZED', false, false, undefined],
    ]);
    should(saved.offers[0]).containDeep({ primary: true, why: 'only' });
    // NO_PASSWORD cannot fill it, so MATCH is the only one offered; both sign in here, so "Save as" guesses neither.
    should(saved).not.have.property('suggest');
    should(savedFor('secret', 'sudo@box', listing([account('MATCH')], [match])).suggest).deepEqual({
      id: 'MATCH',
      label: 'match',
    });
  });

  it('should suggest a new account from the key when none signs in here, and nothing to save for a code', () => {
    should(savedFor('secret', 'sudo@box', EMPTY)).deepEqual({
      match: 'sudo@box',
      suggest: { id: 'SUDO_BOX', label: 'sudo on box' },
      newAccount: { id: 'SUDO_BOX', label: 'sudo on box' },
      saves: 'password',
      offers: [],
    });
    should(savedFor('private', 'sudo@box', EMPTY)).deepEqual({ match: 'sudo@box', offers: [] });
    should(savedFor('plain', undefined, listing([account('U', { username: 'kirin' })], []))).deepEqual({
      saves: 'username',
      offers: [{ id: 'U', label: 'u', username: 'kirin', fills: 'username', matched: false }],
    });
  });

  it('should save a secret as the password, plain as the username and never a code', () => {
    should(savedFieldFor('secret')).equal('password');
    should(savedFieldFor('plain')).equal('username');
    should(savedFieldFor('private')).be.undefined();
  });
});

describe('the one-tap primary: chosen ONLY among the sign-ins the daemon matched (invariants 10, 11)', () => {
  const two = () => {
    const a = site('GITHUB_A', ['github.com']);
    const b = site('GITHUB_B', ['github.com']);
    const other = site('GITLAB', ['gitlab.com']);
    return {
      a,
      b,
      other,
      list: listing([account('GITHUB_A'), account('GITHUB_B'), account('GITLAB')], [a, b, other]),
    };
  };

  it('should make NO account the primary when two or more sign in here and nothing chose one', () => {
    const { a, b, list } = two();
    const saved = savedFor('secret', 'github.com', list);
    should(saved.offers.filter(offer => offer.primary === true)).deepEqual([]);
    should(saved.offers.filter(offer => offer.why !== undefined)).deepEqual([]);
    should(saved.offers.map(offer => [offer.id, offer.matched, offer.signIn])).deepEqual([
      ['GITHUB_A', true, a.id],
      ['GITHUB_B', true, b.id],
      ['GITLAB', false, undefined],
    ]);
    // "Save as" would not guess between them either.
    should(saved).not.have.property('suggest');
  });

  it('should make the matched account the ferret named the primary, by handle or by sign-in id', () => {
    const { b, list } = two();
    for (const hint of ['GITHUB_B', b.id]) {
      const saved = savedFor('secret', 'github.com', list, { hint });
      should(offersOf(saved)).deepEqual([
        ['GITHUB_B', true, 'ferret'],
        ['GITHUB_A', true, undefined],
        ['GITLAB', false, undefined],
      ]);
    }
  });

  it('should never promote what a hint or a default names but the daemon did not match here', () => {
    const { other, list } = two();
    const defaults = {
      sites: { 'github.com': 'GITLAB' },
      projects: { ferretry: { 'github.com': 'GITLAB' } },
    };
    for (const context of [
      { hint: 'GITLAB' },
      { hint: other.id },
      { defaults },
      { defaults, project: { id: 'p1', name: 'ferretry', nameIsUnique: true } },
      { hint: 'GITLAB', defaults },
    ]) {
      const saved = savedFor('secret', 'github.com', list, context);
      should(saved.offers.filter(offer => offer.primary === true || offer.why !== undefined)).deepEqual([]);
      should(saved.offers.find(offer => offer.id === 'GITLAB')).containDeep({ matched: false });
    }
    // A hinted account that does not sign in here is still tagged, never promoted.
    should(
      savedFor('secret', 'github.com', list, { hint: 'GITLAB' }).offers.find(o => o.id === 'GITLAB')?.hinted,
    ).be.true();
  });

  it('should take a site or project default only when it names a matched sign-in', () => {
    const { list } = two();
    const bySite = savedFor('secret', 'github.com', list, { defaults: { sites: { 'github.com': 'GITHUB_B' } } });
    should(offersOf(bySite)[0]).deepEqual(['GITHUB_B', true, 'site']);
    const byProject = savedFor('secret', 'github.com', list, {
      defaults: { projects: { ferretry: { 'github.com': 'GITHUB_A' } }, sites: { 'github.com': 'GITHUB_B' } },
      project: { id: 'p1', name: 'ferretry', nameIsUnique: true },
    });
    should(byProject.offers[0]).containDeep({ id: 'GITHUB_A', primary: true, why: 'project', project: 'ferretry' });
  });

  it('should choose among the accounts that can fill the card: one that cannot is not matched', () => {
    const { list } = two();
    const narrowed = listing(
      list.accounts.map(each =>
        each.id === 'GITHUB_B' ? { ...each, fields: { password: false, totp: false } } : each,
      ),
      [...list.signIns],
    );
    should(offersOf(savedFor('secret', 'github.com', narrowed))[0]).deepEqual(['GITHUB_A', true, 'only']);
  });
});

describe('matching stays exact over sign-ins (invariant 9)', () => {
  const google = site('GOOGLE_KIRIN', ['accounts.google.com']);
  const app = site('APP', ['login.example.com'], { match: ['app.example.com'] });
  const list = listing([account('GOOGLE_KIRIN', { label: 'Google (kirin@)' }), account('APP')], [google, app]);

  it("should match the provider's sign-in on the provider's page", () => {
    should(savedFor('secret', 'accounts.google.com', list).offers[0]).containDeep({
      id: 'GOOGLE_KIRIN',
      matched: true,
      signIn: google.id,
    });
  });

  it('should match a page by the login domain, never by what the site is for', () => {
    should(savedFor('secret', 'login.example.com', list).offers.find(o => o.id === 'APP')?.matched).be.true();
    should(savedFor('secret', 'app.example.com', list).offers.find(o => o.id === 'APP')?.matched).be.false();
  });

  it('should match a login domain exactly: a parent, a child or a look-alike is not it', () => {
    for (const key of [
      'google.com',
      'evil.accounts.google.com',
      'accounts.google.com.evil.test',
      'accounts-google.com',
      'accounts.google.com:8443',
    ])
      should(savedFor('secret', key, list).offers.some(offer => offer.matched)).be.false();
  });

  it('should match a terminal by its program and host, and ssh by its destination, exactly', () => {
    const sudo = tty('SUDO', 'sudo', 'kirin-box');
    const ssh = tty('BUILD', 'ssh', 'kirin-box', 'build.example.com');
    const boxes = listing([account('SUDO'), account('BUILD')], [sudo, ssh]);
    should(savedFor('secret', 'sudo@kirin-box', boxes).offers[0]).containDeep({ id: 'SUDO', signIn: sudo.id });
    should(savedFor('secret', 'ssh@build.example.com', boxes).offers[0]).containDeep({ id: 'BUILD', signIn: ssh.id });
    for (const key of [
      'su@kirin-box',
      'sudo@other-box',
      'ssh@kirin-box',
      'ssh@build.example.com.evil',
      'scp@build.example.com',
    ])
      should(savedFor('secret', key, boxes).offers.some(offer => offer.matched)).be.false();
  });
});

describe('a site that signs in through a provider (secrev-1201 L5)', () => {
  const google = site('GOOGLE_KIRIN', ['accounts.google.com']);
  const vercel = site('VERCEL', ['vercel.com'], {
    method: { kind: 'google', via: 'GOOGLE_KIRIN' },
    via: { account: { id: 'GOOGLE_KIRIN', label: 'Google (kirin@)' }, signIn: google.id },
  });
  const accounts = [
    account('GOOGLE_KIRIN', { label: 'Google (kirin@)', username: 'kirin@x.test' }),
    account('VERCEL', { label: 'Vercel', fields: { password: false, totp: false } }),
    account('UNRELATED', { label: 'Unrelated' }),
  ];

  it('should say on the card how it signs in, and offer no saved password by hand on its page', () => {
    const saved = savedFor('secret', 'vercel.com', listing(accounts, [google, vercel]));
    should(saved.signIn).deepEqual({
      id: 'VERCEL',
      label: 'Vercel',
      method: { kind: 'google', via: 'GOOGLE_KIRIN' },
      via: { id: 'GOOGLE_KIRIN', label: 'Google (kirin@)' },
    });
    should(saved.offers).deepEqual([]);
    should(signInFor('sudo@kirin-box', listing(accounts, [google, vercel]))).be.undefined();
  });

  it('should never put the provider one tap away there, even when the migration dropped the via link', () => {
    // v1 VERCEL went via GOOGLE_KIRIN, which signed in nowhere: the link was dropped, the method kept.
    const dropped = site('VERCEL', ['vercel.com'], { method: { kind: 'google' } });
    const saved = savedFor('secret', 'vercel.com', listing(accounts, [dropped]));
    should(saved.signIn?.method.kind).equal('google');
    should(saved.offers.map(offer => offer.id)).not.containEql('GOOGLE_KIRIN');
    should(saved.offers).deepEqual([]);
  });

  it('should say it on a card of several fields too', () => {
    const fields = [
      { id: 'email', sensitivity: 'plain' as const },
      { id: 'password', sensitivity: 'secret' as const },
    ];
    const saved = savedForFields(fields, 'vercel.com', listing(accounts, [google, vercel]));
    should(saved.signIn?.via?.id).equal('GOOGLE_KIRIN');
    should(saved.offers.map(offer => offer.id)).not.containEql('GOOGLE_KIRIN');
  });

  it('should never offer a provider by hand anywhere it is not matched', () => {
    const saved = savedFor('secret', 'example.org', listing(accounts, [google, vercel]));
    should(saved.offers.map(offer => offer.id)).deepEqual(['UNRELATED']);
  });

  it('should still offer the provider where its own login domains make it matched', () => {
    const both = site('GOOGLE_KIRIN', ['accounts.google.com', 'vercel.com']);
    const saved = savedFor('secret', 'vercel.com', listing(accounts, [both, vercel]));
    should(saved.offers.find(offer => offer.id === 'GOOGLE_KIRIN')).containDeep({ matched: true, signIn: both.id });
  });
});

describe('a one-time code is never offered by hand', () => {
  it('should offer a code only from an account that signs in here', () => {
    const here = site('GITHUB', ['github.com']);
    const elsewhere = site('GITLAB', ['gitlab.com']);
    const seeded = { fields: { password: true, totp: true } };
    const saved = savedFor(
      'code',
      'github.com',
      listing([account('GITHUB', seeded), account('GITLAB', seeded)], [here, elsewhere]),
      { codesHere: true },
    );
    should(saved.offers.map(offer => [offer.id, offer.fills])).deepEqual([['GITHUB', 'totp']]);
  });

  it('should offer no code at all unless the caller says the target may take one it makes', () => {
    const here = site('GITHUB', ['github.com']);
    const seeded = listing([account('GITHUB', { fields: { password: true, totp: true } })], [here]);
    should(savedFor('code', 'github.com', seeded).offers).deepEqual([]);
    should(savedFor('code', 'github.com', seeded, { codesHere: false }).offers).deepEqual([]);
    should(savedFor('secret', 'github.com', seeded).offers.map(offer => offer.fills)).deepEqual(['password']);
  });
});

describe('where the daemon may type a code it made', () => {
  const field = (over: Record<string, unknown> = {}) => ({
    fieldId: 'code',
    frameOrigin: 'https://github.com',
    frameId: 'main',
    backendNodeId: 1,
    field: { tag: 'input', type: 'text' },
    box: { x: 0, y: 0, w: 1, h: 1 },
    visible: true,
    ...over,
  });
  const onPage = (over: Record<string, unknown> = {}, secure = true) =>
    ({
      kind: 'browser',
      pageId: 'p',
      origin: 'https://github.com',
      secure,
      navigationId: 'n',
      fields: [field(over)],
    }) as InputTargetFacts;

  it('should allow the page’s own visible field on https, and a terminal’s one prompt', () => {
    should(codeTargetProblem(onPage(), ['code'])).be.undefined();
    should(codeTargetProblem(terminal('ssh', 'ssh bastion'), ['value'])).be.undefined();
  });

  it('should refuse http, an unseen, covered or missing field, another site’s frame, the store and no look', () => {
    for (const facts of [
      onPage({}, false),
      onPage({ visible: false }),
      onPage({ covered: true }),
      onPage({ frameOrigin: 'https://evil.example' }),
    ])
      should(codeTargetProblem(facts, ['code'])).be.a.String();
    should(codeTargetProblem(onPage(), ['other'])).be.a.String();
    should(codeTargetProblem(undefined, ['code'])).be.a.String();
    should(
      codeTargetProblem({ kind: 'secret', name: 'X', exists: false } as InputTargetFacts, ['value']),
    ).be.a.String();
  });
});

describe('the account a code card is titled from', () => {
  const sms = {
    id: 'tf_00000000000a',
    kind: 'sms',
    label: 'Phone',
    endsWith: '42',
    addedAt: AT,
    addedBy: 'owner',
    automatic: false,
  } as const;
  const app = {
    id: 'tf_00000000000b',
    kind: 'totp',
    label: 'App',
    addedAt: AT,
    addedBy: 'owner',
    automatic: false,
  } as const;
  const theirs = { ...sms, id: 'tf_00000000000c', label: 'Theirs' } as const;

  it('should take the matched account’s keys, or the one key the ferret names among them', () => {
    const world = listing(
      [account('GITHUB', { factors: [sms, app] }), account('GITLAB', { factors: [theirs] })],
      [site('GITHUB', ['github.com']), site('GITLAB', ['gitlab.com'])],
    );
    should(codeCardKeys('github.com', world, {})?.keys.map(key => key.id)).deepEqual([sms.id, app.id]);
    should(codeCardKeys('github.com', world, { factor: app.id })?.keys.map(key => key.id)).deepEqual([app.id]);
    should(codeCardKeys('github.com', world, { factor: theirs.id })?.keys.map(key => key.id)).deepEqual([
      sms.id,
      app.id,
    ]);
    should(codeCardKeys('example.org', world, { factor: sms.id })).be.undefined();
  });

  it('should choose no account between two that match with nothing to choose by', () => {
    const world = listing(
      [account('A', { factors: [sms] }), account('B', { factors: [app] })],
      [site('A', ['github.com']), site('B', ['github.com'])],
    );
    should(codeCardKeys('github.com', world, {})).be.undefined();
    should(codeCardKeys('github.com', world, { hint: 'B' })?.account.id).equal('B');
  });
});

/**
 * &B137: TWO PEOPLE ON ONE SITE. The owner signed a work Google account in while a personal one was saved for the same
 * page: the card one-tapped the personal password onto the work sign-in. The username the ferret typed on the page is
 * the daemon's record of the ferret's word: it can only TAKE a one-tap away and name a new account, never pick one.
 */
describe('who the page is signing in', () => {
  const GOOGLE = 'accounts.google.com';
  const kirin = () =>
    account('ACCOUNTS_GOOGLE_COM', { label: 'accounts.google.com', username: 'kirinnee97@gmail.com' });

  it('should offer no one-tap of kirinnee97 to a page signing in ernest@atomi, and say so (the owner scenario)', () => {
    const saved = savedFor('secret', GOOGLE, listing([kirin()], [site('ACCOUNTS_GOOGLE_COM', [GOOGLE])]), {
      typedUsername: 'ernest@atomi.tech',
    });

    should(saved.offers.some(offer => offer.primary === true)).be.false();
    should(offersOf(saved)).deepEqual([['ACCOUNTS_GOOGLE_COM', true, undefined]]);
    should(saved.differentFrom).deepEqual({
      id: 'ACCOUNTS_GOOGLE_COM',
      label: 'accounts.google.com',
      username: 'kirinnee97@gmail.com',
    });
    should(saved.typedUsername).equal('ernest@atomi.tech');
    // Save as suggests a NEW account named for who is signing in, never the saved one.
    should(saved.newAccount).deepEqual({ id: 'GOOGLE_ERNEST', label: 'Google · ernest@atomi.tech' });
    should(saved.suggest).deepEqual(saved.newAccount);
  });

  it('should keep the one-tap when the page signs in the saved account’s own username, whatever its case', () => {
    const saved = savedFor('secret', GOOGLE, listing([kirin()], [site('ACCOUNTS_GOOGLE_COM', [GOOGLE])]), {
      typedUsername: '  KirinNee97@gmail.com ',
    });

    should(offersOf(saved)).deepEqual([['ACCOUNTS_GOOGLE_COM', true, 'only']]);
    should(saved.differentFrom).be.undefined();
    should(saved.suggest).deepEqual({ id: 'ACCOUNTS_GOOGLE_COM', label: 'accounts.google.com' });
  });

  it('should take the one-tap away from an account with no username saved: nothing says it is the same person', () => {
    const saved = savedFor('secret', GOOGLE, listing([account('G', { label: 'google' })], [site('G', [GOOGLE])]), {
      typedUsername: 'b@gmail.com',
    });

    should(offersOf(saved)).deepEqual([['G', true, undefined]]);
    should(saved.differentFrom).deepEqual({ id: 'G', label: 'google' });
    // Nor is it offered for Update: only the owner adding the username in Settings first makes it that person.
    should(saved.update).be.undefined();
    should(saved.newAccount).deepEqual({ id: 'GOOGLE_B', label: 'Google · b@gmail.com' });
  });

  it('should never PROMOTE an account by its username: two sign in here, the typed one matches one, still no one-tap', () => {
    const saved = savedFor(
      'secret',
      GOOGLE,
      listing(
        [
          account('A', { username: 'a@x.com' }),
          account('B', { username: 'b@x.com' }),
          account('HAND', { username: 'h@x.com' }),
        ],
        [site('A', [GOOGLE]), site('B', [GOOGLE])],
      ),
      { typedUsername: 'b@x.com' },
    );

    should(saved.offers.some(offer => offer.primary === true)).be.false();
    should(saved.differentFrom).be.undefined();
    // Typing a hand-pickable account's username never matches it here either.
    should(saved.offers.find(offer => offer.id === 'HAND')).match({ matched: false });
    should(saved.offers.find(offer => offer.id === 'HAND')?.primary).be.undefined();
    // Nor does it choose which one Save as may update: nothing chose one, so none is offered (secrev-1331 L3).
    should(saved.update).be.undefined();
  });

  it('should demote a ferret’s hint or a default exactly as the only one, and never move it to another account', () => {
    const a = site('A', [GOOGLE]);
    const saved = savedFor(
      'secret',
      GOOGLE,
      listing([account('A', { username: 'a@x.com' }), account('B', { username: 'b@x.com' })], [a, site('B', [GOOGLE])]),
      { hint: 'A', typedUsername: 'c@x.com' },
    );

    should(saved.offers.some(offer => offer.primary === true)).be.false();
    should(saved.differentFrom).match({ id: 'A' });
    should(saved.update).be.undefined();
  });

  it('should give a new account a CLI name no account has', () => {
    const saved = savedFor('secret', GOOGLE, listing([account('GOOGLE_B')], []), { typedUsername: 'b@y.com' });

    should(saved.newAccount).deepEqual({ id: 'GOOGLE_B_2', label: 'Google · b@y.com' });
  });
});
