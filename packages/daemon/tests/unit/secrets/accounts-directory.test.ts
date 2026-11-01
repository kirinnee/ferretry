import { describe, it } from 'bun:test';
import { type Place, PutLoginEntryRequestSchema, TotpParametersSchema } from '@ferretry/protocol';
import should from 'should';
import { AccountVault, LoginDirectory, narrowAccountVault, totpCode } from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex } from '../runtime/mounts/support.ts';
import { CLOCK, CountingSealed, daemonOver, SEED } from './accounts-fixtures.ts';

/**
 * The account store's own rules (r1-plan §1.3, §2.5; invariants 16, 17 and the compat writes of §1.5): one account
 * signs in at a place once, a via link never dangles or loops, a merge moves sealed values only inside the vault, and
 * an older client's write that cannot say which sign-in it means is refused, never guessed.
 */

const site = (...domains: string[]): Place => ({ kind: 'site', domains, match: domains });
const terminal = (tool: string, host: string): Place => ({ kind: 'terminal', tool, host });

function world() {
  const index = new MemoryLoginIndex();
  const sealed = new CountingSealed();
  let key = 0;
  let signIn = 0;
  const daemon = daemonOver(index, sealed, {
    newKey: () => `L${(++key).toString(16).toUpperCase().padStart(24, '0')}`,
    newSignInId: () => `si_${(++signIn).toString(16).padStart(16, '0')}`,
  });
  return { index, sealed, ...daemon };
}

const refusal = async (work: Promise<unknown>): Promise<string | undefined> =>
  ((await work.catch((error: unknown) => error)) as { refusal?: string }).refusal;

describe('one account signs in at a place once', () => {
  it('should refuse a second sign-in of one account on a key it already signs in at, and allow another account', async () => {
    const w = world();
    await w.directory.putAccount('GITHUB', { label: 'GitHub' });
    await w.directory.putAccount('GITHUB_WORK', { label: 'GitHub (work)' });
    const first = await w.directory.addSignIn('GITHUB', { place: site('github.com') });

    should(await refusal(w.directory.addSignIn('GITHUB', { place: site('gist.github.com', 'github.com') }))).equal(
      'place_taken',
    );
    should((await w.directory.addSignIn('GITHUB_WORK', { place: site('github.com') })).account).equal('GITHUB_WORK');
    const other = await w.directory.addSignIn('GITHUB', { place: terminal('sudo', 'kirin-box') });
    should(await refusal(w.directory.putSignIn(other.id, { place: site('github.com') }))).equal('place_taken');
    should(await refusal(w.directory.addSignIn('GITHUB', { place: terminal('sudo', 'kirin-box') }))).equal(
      'place_taken',
    );
    // Changing a sign-in onto its own place is not a clash.
    should((await w.directory.putSignIn(first.id, { place: site('github.com') })).id).equal(first.id);
  });

  it('should drop the facts a sign-in kept at a key its new place does not have', async () => {
    const w = world();
    await w.directory.putAccount('GITHUB', { label: 'GitHub' });
    const { id } = await w.directory.addSignIn('GITHUB', { place: site('github.com') });
    await w.directory.observeSignIn(id, { at: 'github.com', surface: 'page', identity: '0123456789abcdef' });
    await w.directory.observeSignIn(id, { at: 'gitlab.com', surface: 'page', identity: '0123456789abcdef' });
    should((await w.directory.list()).signIns[0]?.observed?.map(fact => fact.at)).deepEqual(['github.com']);
    const moved = await w.directory.putSignIn(id, { place: site('gitlab.com') });
    should(moved.observed).be.undefined();
  });
});

describe('a via link never dangles or loops', () => {
  async function providers() {
    const w = world();
    await w.directory.putAccount('GOOGLE', { label: 'Google' });
    await w.directory.putAccount('SITE', { label: 'Site' });
    await w.directory.putAccount('NOSITE', { label: 'Terminal only' });
    const google = await w.directory.addSignIn('GOOGLE', { place: site('accounts.google.com') });
    await w.directory.addSignIn('NOSITE', { place: terminal('sudo', 'kirin-box') });
    return { ...w, google };
  }

  it('should refuse a provider that is gone, the account itself, or one that signs in on no site', async () => {
    const w = await providers();
    const via = (to: string) => ({ place: site('site.example'), method: { kind: 'google' as const, via: to } });
    should(await refusal(w.directory.addSignIn('SITE', via('NOPE')))).equal('bad_via');
    should(await refusal(w.directory.addSignIn('SITE', via('SITE')))).equal('bad_via');
    should(await refusal(w.directory.addSignIn('SITE', via('NOSITE')))).equal('bad_via');
    should((await w.directory.addSignIn('SITE', via('GOOGLE'))).via?.account.id).equal('GOOGLE');
  });

  it('should refuse a circle of via links', async () => {
    const w = await providers();
    await w.directory.addSignIn('SITE', { place: site('site.example'), method: { kind: 'google', via: 'GOOGLE' } });
    should(
      await refusal(w.directory.putSignIn(w.google.id, { method: { kind: 'sso', name: 'Site SSO', via: 'SITE' } })),
    ).equal('bad_via');
  });

  it("should refuse to remove a provider's last site while a sign-in goes via it, and unlink it when it is deleted", async () => {
    const w = await providers();
    const before = JSON.stringify(w.index.document);
    const linked = await w.directory.addSignIn('SITE', {
      place: site('site.example'),
      method: { kind: 'google', via: 'GOOGLE' },
    });
    const committed = JSON.stringify(w.index.document);
    should(committed).not.equal(before);
    should(await refusal(w.directory.removeSignIn(w.google.id))).equal('bad_via');
    should(JSON.stringify(w.index.document)).equal(committed);

    await w.directory.renameAccount('GOOGLE', 'GOOGLE_KIRIN');
    should((await w.directory.list()).signIns.find(each => each.id === linked.id)?.method).deepEqual({
      kind: 'google',
      via: 'GOOGLE_KIRIN',
    });
    should(await w.directory.removeAccount('GOOGLE_KIRIN')).be.true();
    should((await w.directory.list()).signIns.find(each => each.id === linked.id)?.method).deepEqual({
      kind: 'google',
    });
  });
});

describe('these look like one account', () => {
  async function lookAlikes() {
    const w = world();
    await w.directory.putAccount('GITHUB', { label: 'GitHub', username: 'kirin', password: 'same-UNIQUE-pw-1' });
    await w.directory.putAccount('GH_BOX', {
      label: 'gh on kirin-box',
      username: ' Kirin ',
      password: 'same-UNIQUE-pw-1',
    });
    await w.directory.putAccount('OTHER', { label: 'Other', username: 'kirin', password: 'other-UNIQUE-pw-2' });
    await w.directory.putAccount('NOBODY', { label: 'Nobody', password: 'same-UNIQUE-pw-1' });
    return w;
  }

  it('should group same username AND same password only, by handle, without writing anything', async () => {
    const w = await lookAlikes();
    const index = JSON.stringify(w.index.document);
    const writes = w.sealed.writes;

    should(await w.vault.lookAlike()).deepEqual([['GH_BOX', 'GITHUB']]);
    should(JSON.stringify(w.index.document)).equal(index);
    should(w.sealed.writes).equal(writes);
  });

  it('should never answer a group holding a kept-apart pair, even through a third account (secrev-r1-2 L4)', async () => {
    const w = await lookAlikes();
    await w.directory.putAccount('THIRD', { label: 'Third', username: 'KIRIN', password: 'same-UNIQUE-pw-1' });
    should(await w.vault.lookAlike()).deepEqual([['GH_BOX', 'GITHUB', 'THIRD']]);

    await w.directory.apart('GITHUB', 'THIRD');

    const groups = await w.vault.lookAlike();
    should(groups).deepEqual([
      ['GH_BOX', 'GITHUB'],
      ['GH_BOX', 'THIRD'],
    ]);
    for (const group of groups) should(group.includes('GITHUB') && group.includes('THIRD')).be.false();
  });

  it('should leave out a pair the owner kept apart', async () => {
    const w = await lookAlikes();
    await w.directory.apart('GITHUB', 'GH_BOX');
    should(await w.vault.lookAlike()).deepEqual([]);
    should(JSON.stringify(w.index.document)).not.containEql('same-UNIQUE');
  });
});

describe('merging two accounts', () => {
  async function pair(fromPassword = 'same-UNIQUE-pw-1') {
    const w = world();
    await w.directory.putAccount('KEEP', { label: 'GitHub', username: 'kirin', password: 'same-UNIQUE-pw-1' });
    await w.directory.putAccount('FROM', { label: 'gh', username: 'kirin', password: fromPassword });
    const logins = new LoginDirectory(w.index, w.sealed, new FakeSecretCipher(), CLOCK);
    // FROM's seed, through the older route (the only way to save one before 2FA keys have routes of their own).
    await logins.put('FROM', PutLoginEntryRequestSchema.parse({ totp: { seed: SEED }, totpAcknowledged: true }));
    await w.directory.addSignIn('KEEP', { place: site('github.com') });
    const moved = await w.directory.addSignIn('FROM', {
      place: terminal('gh', 'kirin-box'),
      recipe: 'Run gh auth login as [[FROM]]',
    });
    await w.directory.putAccount('SITE', { label: 'Site' });
    await w.directory.addSignIn('FROM', { place: site('gh-sso.example') });
    const linked = await w.directory.addSignIn('SITE', {
      place: site('site.example'),
      method: { kind: 'github', via: 'FROM' },
    });
    return { ...w, moved, linked };
  }

  it("should move FROM's sign-ins, take its seed (resealed under KEEP), follow its links and sweep it", async () => {
    const w = await pair();
    const merged = await w.directory.merge('KEEP', 'FROM');

    should(merged.signIns).have.length(3);
    should(merged.fields).deepEqual({ password: true, totp: true });
    const listing = await w.directory.list();
    should(listing.accounts.map(account => account.id)).deepEqual(['KEEP', 'SITE']);
    should(listing.signIns.find(each => each.id === w.moved.id)?.recipe).equal('Run gh auth login as [[KEEP]]');
    should(listing.signIns.find(each => each.id === w.linked.id)?.method).deepEqual({ kind: 'github', via: 'KEEP' });
    // One password (they were the same), the seed is KEEP's now, and FROM's ciphertext is gone.
    should(await w.vault.fill('KEEP', 'password', 0)).equal('same-UNIQUE-pw-1');
    should(await w.vault.fill('KEEP', 'totp', 0)).equal(totpCode(SEED, TotpParametersSchema.parse({}), 0) as string);
    const keepKey = w.index.accounts.accounts.KEEP?.key as string;
    should(Object.keys((await w.sealed.read())?.entries ?? {}).every(name => name.startsWith(keepKey))).be.true();
  });

  it('should refuse, losing nothing, when the two accounts keep different passwords (secrev-r1-2 M1)', async () => {
    const w = await pair('other-UNIQUE-pw-2');
    const index = JSON.stringify(w.index.document);
    const sealed = JSON.stringify(await w.sealed.read());

    const refused = (await w.directory.merge('KEEP', 'FROM').catch((error: unknown) => error)) as Error & {
      refusal?: string;
    };

    should(refused.refusal).equal('merge_refused');
    should(refused.message).containEql('different passwords');
    should(JSON.stringify(w.index.document)).equal(index);
    should(JSON.stringify(await w.sealed.read())).equal(sealed);
    should(await w.vault.fill('FROM', 'password', 0)).equal('other-UNIQUE-pw-2');
    should(await w.vault.fill('KEEP', 'password', 0)).equal('same-UNIQUE-pw-1');
  });

  it("should take FROM's password when KEEP has none", async () => {
    const w = await pair();
    await w.directory.putAccount('KEEP', { password: null });
    await w.directory.merge('KEEP', 'FROM');
    should(await w.vault.fill('KEEP', 'password', 0)).equal('same-UNIQUE-pw-1');
  });

  it("should never drop FROM's seed when KEEP has a key of the same label that holds no seed", async () => {
    const w = await pair();
    const keep = w.index.accounts.accounts.KEEP;
    // KEEP has an authenticator only the owner holds, labelled like FROM's seeded one.
    w.index.document = {
      ...w.index.accounts,
      accounts: {
        ...w.index.accounts.accounts,
        KEEP: {
          ...(keep as NonNullable<typeof keep>),
          factors: [
            { id: 'tf_00000000000a', kind: 'totp', label: 'Authenticator app', addedAt: 'a', addedBy: 'owner' },
          ],
        },
      },
    };

    const merged = await w.directory.merge('KEEP', 'FROM');

    should(merged.factors.map(key => [key.label, key.automatic])).deepEqual([
      ['Authenticator app', false],
      ['Authenticator app 2', true],
    ]);
    should(await w.vault.fill('KEEP', 'totp', 0)).equal(totpCode(SEED, TotpParametersSchema.parse({}), 0) as string);
  });

  it('should refuse, changing nothing, when both sign in at one place or keep different seeds', async () => {
    const w = await pair();
    await w.directory.addSignIn('FROM', { place: site('github.com') });
    const before = JSON.stringify(w.index.document);
    should(await refusal(w.directory.merge('KEEP', 'FROM'))).equal('merge_refused');
    should(JSON.stringify(w.index.document)).equal(before);

    const seeds = await pair();
    const logins = new LoginDirectory(seeds.index, seeds.sealed, new FakeSecretCipher(), CLOCK);
    await logins.put(
      'KEEP',
      PutLoginEntryRequestSchema.parse({ totp: { seed: 'GEZDGNBVGY3TQOJQ' }, totpAcknowledged: true }),
    );
    should(await refusal(seeds.directory.merge('KEEP', 'FROM'))).equal('merge_refused');
    should(await refusal(seeds.directory.merge('KEEP', 'KEEP'))).equal('merge_refused');
  });
});

describe('an older client writes a saved login', () => {
  async function twoPlaces() {
    const w = world();
    const logins = new LoginDirectory(w.index, w.sealed, new FakeSecretCipher(), CLOCK, {
      hostName: 'kirin-box',
      newSignInId: (() => {
        let n = 100;
        return () => `si_${(++n).toString(16).padStart(16, '0')}`;
      })(),
    });
    // What `fy secret entry add` sent: one body with a website and an ssh host. It becomes two sign-ins.
    await logins.put(
      'GITHUB',
      PutLoginEntryRequestSchema.parse({ label: 'GitHub', match: ['github.com', 'ssh@build.example.com'] }),
    );
    return { ...w, logins };
  }

  it('should refuse a change to where or how it signs in once it signs in at several places', async () => {
    const w = await twoPlaces();
    should((await w.directory.list()).signIns).have.length(2);
    const before = JSON.stringify(w.index.document);
    for (const body of [
      { match: ['github.com'] },
      { domains: ['github.com'] },
      { method: { kind: 'github' } },
      { recipe: 'Open github.com' },
      { autoApplyRecipe: true },
    ])
      should(await refusal(w.logins.put('GITHUB', PutLoginEntryRequestSchema.parse(body)))).equal(
        'account_has_sign_ins',
      );
    should(JSON.stringify(w.index.document)).equal(before);
    // The account's own fields are not a sign-in's: they still change.
    should((await w.logins.put('GITHUB', PutLoginEntryRequestSchema.parse({ username: 'kirin' }))).username).equal(
      'kirin',
    );
    should(await refusal(w.logins.propose('GITHUB', proposal()))).equal('account_has_sign_ins');
  });

  it('should refuse a method or recipe for an account that signs in nowhere, never answering it saved (secrev-r1-2 L5)', async () => {
    const w = world();
    const logins = new LoginDirectory(w.index, w.sealed, new FakeSecretCipher(), CLOCK);
    await logins.put('GOOGLE', PutLoginEntryRequestSchema.parse({ label: 'Google' }));
    const before = JSON.stringify(w.index.document);
    for (const body of [
      { match: [], method: { kind: 'sso', name: 'Okta' } },
      { match: [], recipe: 'Open accounts.google.com' },
      { match: [], autoApplyRecipe: true },
      { label: 'New', match: [], recipe: 'Open it' },
    ])
      should(
        await refusal(logins.put(body.label === undefined ? 'GOOGLE' : 'NEW', PutLoginEntryRequestSchema.parse(body))),
      ).equal('no_sign_in');
    should(JSON.stringify(w.index.document)).equal(before);
    // Back to a password, with nowhere to sign in, loses nothing: it is not refused.
    should(
      (await logins.put('GOOGLE', PutLoginEntryRequestSchema.parse({ match: [], method: { kind: 'password' } }))).id,
    ).equal('GOOGLE');
  });

  it('should map a change 1:1 onto the one sign-in, keeping its id', async () => {
    const w = world();
    const logins = new LoginDirectory(w.index, w.sealed, new FakeSecretCipher(), CLOCK);
    await logins.put('VERCEL', PutLoginEntryRequestSchema.parse({ label: 'Vercel', match: ['vercel.com'] }));
    const [first] = (await w.directory.list()).signIns;
    const changed = await logins.put('VERCEL', PutLoginEntryRequestSchema.parse({ recipe: 'Open vercel.com' }));
    should(changed.recipe).equal('Open vercel.com');
    const [after] = (await w.directory.list()).signIns;
    should(after?.id).equal(first?.id as string);
    should(after?.recipeVersion).equal(1);
    await logins.put('VERCEL', PutLoginEntryRequestSchema.parse({ recipe: 'Open vercel.com/login' }));
    should((await w.directory.list()).signIns[0]?.recipeVersion).equal(2);
  });

  it('should keep a fact only on the sign-in at the place it was seen, never misfiled', async () => {
    const w = await twoPlaces();
    await w.logins.observe('GITHUB', { at: 'gitlab.com', surface: 'page', identity: '0123456789abcdef' });
    should((await w.directory.list()).signIns.every(signIn => signIn.observed === undefined)).be.true();
    await w.logins.observe('GITHUB', {
      at: 'ssh@build.example.com',
      surface: 'terminal',
      identity: '0123456789abcdef',
    });
    const terminalSignIn = (await w.directory.list()).signIns.find(signIn => signIn.place.kind === 'terminal');
    should(terminalSignIn?.observed?.map(fact => fact.at)).deepEqual(['ssh@build.example.com']);
  });
});

function proposal() {
  return {
    id: 'rp_0000000000000009',
    recipe: 'Open github.com',
    why: 'it moved',
    sessionId: 'session-1',
    proposedAt: '2026-10-31T09:00:00.000Z',
  };
}

describe('what of the vault is handed out (secrev-r1-2 L2)', () => {
  it('should hand the directory and the route table closures that cannot reach values() or fill()', async () => {
    const w = world();
    const vault = new AccountVault(w.index, w.sealed, new FakeSecretCipher());
    const narrow = narrowAccountVault(vault);
    for (const part of [narrow.seals, narrow.lookAlike]) {
      should(part).not.be.instanceOf(AccountVault);
      should(Object.isFrozen(part)).be.true();
      should(part as unknown as Record<string, unknown>).not.have.properties(['values', 'fill', 'documents']);
    }
    should(Object.keys(narrow.seals).sort()).deepEqual(['reseal', 'sameValue']);
    should(Object.keys(narrow.lookAlike)).deepEqual(['lookAlike']);
    should(await narrow.lookAlike.lookAlike()).deepEqual([]);
  });
});
