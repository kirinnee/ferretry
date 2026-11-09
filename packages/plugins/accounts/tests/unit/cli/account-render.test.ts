import { describe, it } from 'bun:test';
import should from 'should';
import {
  renderAccountHint,
  renderAccountLine,
  renderAccountList,
  renderDefaults,
  renderFactorLine,
  renderSignInLine,
  renderSignInList,
  renderSignInRecipe,
} from '../../../cli/lib/account-render.ts';
import {
  type AccountHintList,
  type AccountList,
  type AccountSummary,
  LOGIN_HINT_PASSKEYS_OFF,
  type SignInSummary,
  type TwoFactorKeySummary,
} from '../../../contract/routes/index.ts';

const AT = '2026-11-01T12:00:00.000Z';
const SI = (n: number): string => `si_${String(n).repeat(16)}`;
const TF = (n: number): string => `tf_${String(n).repeat(12)}`;

const signIn = (over: Partial<SignInSummary> = {}): SignInSummary => ({
  id: SI(1),
  account: 'GITHUB_WORK',
  place: { kind: 'site', domains: ['github.com'], match: [] },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const account = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  id: 'GITHUB_WORK',
  label: 'work github',
  fields: { password: true },
  factors: [],
  signIns: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const key = (n: number, over: Record<string, unknown>): TwoFactorKeySummary =>
  ({ id: TF(n), label: 'phone', addedAt: AT, addedBy: 'owner', automatic: false, ...over }) as TwoFactorKeySummary;

describe('renderSignInLine', () => {
  it('should say the id, how it signs in and where, for a site and for a terminal', () => {
    should(renderSignInLine(signIn())).equal(`${SI(1)}  Password, site signs in on github.com`);
    should(
      renderSignInLine(signIn({ place: { kind: 'site', domains: ['accounts.google.com'], match: ['vercel.com'] } })),
    ).equal(`${SI(1)}  Password, site signs in on accounts.google.com, for vercel.com`);
    should(renderSignInLine(signIn({ place: { kind: 'site', domains: [], match: ['vercel.com'] } }))).equal(
      `${SI(1)}  Password, site for vercel.com`,
    );
    should(renderSignInLine(signIn({ place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' } }))).equal(
      `${SI(1)}  Password, terminal sudo@kirin-box`,
    );
    should(
      renderSignInLine(signIn({ place: { kind: 'terminal', tool: 'ssh', host: 'laptop', dest: 'build.example.com' } })),
    ).equal(`${SI(1)}  Password, terminal ssh@build.example.com (from laptop)`);
  });

  it('should name the provider account by its label', () => {
    const line = renderSignInLine(
      signIn({
        method: { kind: 'google', via: 'GOOGLE_KIRIN' },
        via: { account: { id: 'GOOGLE_KIRIN', label: 'Google (kirin)' } },
      }),
    );
    should(line).equal(`${SI(1)}  Sign in with Google via 'Google (kirin)', site signs in on github.com`);
  });

  it('should flag a recipe, whose it is, and how many proposals wait', () => {
    should(renderSignInLine(signIn({ recipe: 'Click Sign in.' }))).endWith('  [recipe]');
    should(renderSignInLine(signIn({ recipe: 'Click Sign in.', recipeBy: 'ferret' }))).endWith(
      '  [recipe by a ferret]',
    );
    const proposal = (n: number) => ({
      id: `rp_${String(n).repeat(16)}`,
      recipe: 'Click Log in.',
      why: 'the button says Log in',
      sessionId: 'session-one',
      proposedAt: AT,
    });
    should(renderSignInLine(signIn({ proposals: [proposal(1)] }))).endWith('  [1 proposal waiting]');
    should(renderSignInLine(signIn({ proposals: [proposal(1), proposal(2)] }))).endWith('  [2 proposals waiting]');
    should(renderSignInLine(signIn({ proposals: [] }))).not.containEql('waiting');
  });
});

describe('renderFactorLine', () => {
  it('should say whether the owner types the codes of an authenticator or Ferretry makes them, and whether that worked', () => {
    should(renderFactorLine(key(1, { kind: 'totp' }))).equal(
      `${TF(1)}  phone  (authenticator app: you type its codes)`,
    );
    const params = { algorithm: 'SHA1', digits: 6, period: 30 };
    should(renderFactorLine(key(2, { kind: 'totp', automatic: true, params }))).equal(
      `${TF(2)}  phone  (authenticator app: Ferretry makes the codes (not tried yet))`,
    );
    should(
      renderFactorLine(key(3, { kind: 'totp', automatic: true, params, verified: { worked: true, at: AT } })),
    ).endWith('(authenticator app: Ferretry makes the codes (worked 2026-11-01))');
    should(
      renderFactorLine(key(4, { kind: 'totp', automatic: true, params, verified: { worked: false, at: AT } })),
    ).endWith('(authenticator app: Ferretry makes the codes (did NOT work 2026-11-01))');
  });

  it('should say where an sms or email code goes when the owner said, and not when they did not', () => {
    should(renderFactorLine(key(1, { kind: 'sms', endsWith: '42' }))).endWith(
      '(text message ending ••42: you type the code)',
    );
    should(renderFactorLine(key(1, { kind: 'sms' }))).endWith('(text message: you type the code)');
    should(renderFactorLine(key(1, { kind: 'email', to: 'k***@example.com' }))).endWith(
      '(email to k***@example.com: you type the code)',
    );
    should(renderFactorLine(key(1, { kind: 'email' }))).endWith('(email: you type the code)');
  });

  it('should say which app a push goes to when the owner said, and that a security key is tapped', () => {
    should(renderFactorLine(key(1, { kind: 'push', app: 'duo' }))).endWith('(approve on your phone (duo))');
    should(renderFactorLine(key(1, { kind: 'push' }))).endWith('(approve on your phone)');
    should(renderFactorLine(key(1, { kind: 'security-key' }))).endWith('(security key: you tap it)');
  });
});

describe('renderAccountList', () => {
  it('should say the store is unreadable, with its diagnosis, and that the accounts are not gone', () => {
    const damaged = (diagnosis?: string): AccountList => ({
      v: 1,
      health: 'damaged',
      ...(diagnosis === undefined ? {} : { diagnosis }),
      accounts: [],
      signIns: [],
    });
    const text = renderAccountList(damaged('index is not valid JSON'));
    should(text.split('\n')).eql([
      'This daemon cannot read its secret store, so its accounts cannot be listed.',
      'index is not valid JSON',
      '',
      'They are NOT gone. Do not add or edit any until the store is readable, or you may write over accounts that are still there.',
    ]);
    should(renderAccountList(damaged())).containEql('no diagnosis was given');
  });

  it('should say there are none', () => {
    should(renderAccountList({ v: 1, health: 'ready', accounts: [], signIns: [] })).equal(
      'No accounts on this daemon.',
    );
  });

  it('should list each account with its fields, its 2FA keys and its sign-ins, and say a sign-in the listing lacks', () => {
    const full = account({
      username: 'kirin',
      factors: [key(1, { kind: 'security-key', label: 'yubikey' })],
      signIns: [SI(1), SI(9)],
    });
    const bare = account({ id: 'BARE', label: 'bare', fields: { password: false } });
    const text = renderAccountList({ v: 1, health: 'ready', accounts: [full, bare], signIns: [signIn()] });
    should(text.split('\n')).eql([
      'work github  [GITHUB_WORK]',
      '    username: kirin',
      '    fields: password ✓  2FA codes made here –',
      '    2FA keys:',
      `      ${TF(1)}  yubikey  (security key: you tap it)`,
      '    sign-ins:',
      `      ${SI(1)}  Password, site signs in on github.com`,
      `      ${SI(9)}  (not in this listing)`,
      'bare  [BARE]',
      '    fields: password –  2FA codes made here –',
      '    sign-ins: (none: never offered on any page or terminal)',
    ]);
  });

  it('should tick the 2FA codes made here when an automatic key exists', () => {
    const params = { algorithm: 'SHA1', digits: 6, period: 30 };
    const text = renderAccountList({
      v: 1,
      health: 'ready',
      accounts: [account({ factors: [key(1, { kind: 'totp', automatic: true, params })] })],
      signIns: [],
    });
    should(text).containEql('fields: password ✓  2FA codes made here ✓');
  });
});

describe('renderSignInList', () => {
  it('should say there are no sign-ins, on the daemon or for one account', () => {
    should(renderSignInList(undefined, [])).equal('No sign-ins on this daemon.');
    should(renderSignInList(account(), [])).equal('GITHUB_WORK has no sign-ins yet (add one with `account site add`).');
  });

  it("should put each sign-in's account before its line", () => {
    const other = signIn({ id: SI(2), account: 'GITHUB_HOME' });
    should(renderSignInList(undefined, [signIn(), other]).split('\n')).eql([
      `GITHUB_WORK  ${SI(1)}  Password, site signs in on github.com`,
      `GITHUB_HOME  ${SI(2)}  Password, site signs in on github.com`,
    ]);
  });
});

describe('renderAccountLine', () => {
  it('should say the handle, the label and which fields exist', () => {
    should(renderAccountLine(account())).equal('GITHUB_WORK  work github  (password ✓  2FA codes made here –)');
  });
});

describe('renderAccountHint', () => {
  it('should say no account is saved when the hint is empty', () => {
    const text = renderAccountHint({ v: 1, site: 'github.com', hints: [], passkeys: 'off' });
    should(text).startWith('No account for github.com;').and.endWith(LOGIN_HINT_PASSKEYS_OFF);
  });

  it('should list one line per sign-in, then the passkey rule', () => {
    const hint: AccountHintList = {
      v: 1,
      site: 'github.com',
      passkeys: 'off',
      hints: [
        {
          signIn: SI(1),
          account: { id: 'GITHUB_WORK', label: 'work github' },
          username: 'kirin',
          role: 'site',
          place: { kind: 'site', domains: ['github.com'], match: [] },
          method: { kind: 'password' },
        },
      ],
    };
    const lines = renderAccountHint(hint).split('\n');
    should(lines[0]).equal('Sign-ins for github.com:');
    should(lines[1])
      .startWith("  'work github' (GITHUB_WORK) as kirin")
      .and.containEql(`[${SI(1)}]`);
    should(lines.slice(-2)).eql(['', LOGIN_HINT_PASSKEYS_OFF]);
  });
});

describe('renderDefaults', () => {
  it('should say none are set', () => {
    should(renderDefaults({})).equal('No default accounts are set.');
  });

  it('should say each line with the scope it applies in', () => {
    const text = renderDefaults({
      sites: { 'github.com': 'GITHUB_WORK' },
      projects: { ferretry: { 'vercel.com': 'VERCEL_WORK' } },
      folders: { '~/scratch': { 'sudo@kirin-box': 'SUDO_KIRIN' } },
    });
    should(text.split('\n')).eql([
      'github.com -> GITHUB_WORK  (every session on this machine)',
      'vercel.com -> VERCEL_WORK  (project ferretry)',
      'sudo@kirin-box -> SUDO_KIRIN  (folder ~/scratch)',
    ]);
  });
});

describe('renderSignInRecipe', () => {
  const flag = <T>(value: T) => ({ value, observedAt: AT, count: 3 });

  it('should say there is no recipe, nothing seen and nothing proposed', () => {
    const text = renderSignInRecipe(signIn(), account());
    should(text.split('\n')).eql([
      `work github  [GITHUB_WORK]  ${SI(1)}  on github.com`,
      "auto-apply a ferret's proposal: off",
      '',
      "(no recipe yet: write one with `site recipe set`, or approve a ferret's proposal)",
      '',
      'Seen: nothing yet',
    ]);
  });

  it('should fall back to the account handle when the listing lacks the account', () => {
    should(renderSignInRecipe(signIn(), undefined).split('\n')[0]).equal(
      `GITHUB_WORK  [GITHUB_WORK]  ${SI(1)}  on github.com`,
    );
  });

  it('should show the recipe, what was seen, the auto-apply switch and each proposal as the diff it would make', () => {
    const text = renderSignInRecipe(
      signIn({
        recipe: 'Click Sign in.',
        autoApplyRecipe: true,
        observed: [
          {
            at: 'github.com',
            surface: 'page',
            identity: 'a'.repeat(16),
            since: AT,
            masked: flag(true),
            noEchoAfterSubmit: flag(true),
          },
        ],
        proposals: [
          {
            id: `rp_${'7'.repeat(16)}`,
            base: 'Click Sign in.',
            recipe: 'Click Log in.',
            why: 'the button says Log in',
            sessionId: 'session-one',
            proposedAt: AT,
          },
        ],
      }),
      account(),
    );
    const lines = text.split('\n');
    should(lines).containEql("auto-apply a ferret's proposal: on");
    should(lines).containEql('Click Sign in.');
    should(lines).containEql('Seen:');
    should(lines).containEql('  github.com: password field, no echo (seen 3×, 2026-11-01)');
    should(lines).containEql(`rp_${'7'.repeat(16)}  2026-11-01`);
    should(lines).containEql('The ferret says: the button says Log in');
    should(lines).containEql('- Click Sign in.');
    should(lines).containEql('+ Click Log in.');
  });
});
