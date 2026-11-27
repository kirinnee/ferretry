import { describe, it } from 'bun:test';
import should from 'should';
import { type AccountList, AccountListSchema, type IdentityLink, type Place } from '../../../contract/routes/index.ts';
import { recoveryPlan, resolveIdentity } from '../../../daemon/lib/identity-graph.ts';
import { daemonOver } from './support.ts';
import { CountingSealed, MemoryLoginIndex } from './support.ts';

/**
 * THE IDENTITY GRAPH (W-124 U5), on the pure functions only: which browser identity holds the sign-in a host needs, and
 * the steps back in after a page showed its login. The accounts and sites are synthetic (`*.example`), the identities
 * are plain keys; nothing is read from a store, a clock or a browser.
 */

const AT = '2026-11-27T09:00:00.000Z';
const SI = (n: number): string => `si_${n.toString(16).padStart(16, '0')}`;
const site = (...domains: string[]): Place => ({ kind: 'site', domains, match: domains });

const account = (id: string, signIns: string[]) => ({
  id,
  label: id,
  fields: { password: true },
  factors: [],
  signIns,
  createdAt: AT,
  updatedAt: AT,
});
const signIn = (n: number, accountId: string, place: Place, via?: string) => ({
  id: SI(n),
  account: accountId,
  place,
  method: via === undefined ? { kind: 'password' } : { kind: 'google', via },
  createdAt: AT,
  updatedAt: AT,
});
/** The listing as the daemon builds it: a sign-in that goes via an account names that account's first site sign-in. */
const list = (accounts: ReturnType<typeof account>[], signIns: ReturnType<typeof signIn>[]): AccountList =>
  AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts,
    signIns: signIns.map(each => {
      const via = each.method.via;
      if (via === undefined) return each;
      const provider = signIns.find(other => other.account === via && other.place.kind === 'site');
      return {
        ...each,
        via: { account: { id: via, label: via }, ...(provider === undefined ? {} : { signIn: provider.id }) },
      };
    }),
  });
const link = (n: number, identity: string, how: IdentityLink['how'] = 'filled'): IdentityLink => ({
  signIn: SI(n),
  identity,
  seenAt: AT,
  how,
});

/** "Code Host" signs in with the IdP's account G (`idp.example`); `Plain` has a password of its own. */
const WORLD = list(
  [account('IDP_G', [SI(1)]), account('CODEHOST', [SI(2)]), account('PLAIN', [SI(3)])],
  [
    signIn(1, 'IDP_G', site('idp.example')),
    signIn(2, 'CODEHOST', site('code.example'), 'IDP_G'),
    signIn(3, 'PLAIN', site('plain.example')),
  ],
);

describe('which identity holds a sign-in (resolveIdentity)', () => {
  it('should send code.example to the identity its provider account G is live in, naming G on the way', () => {
    should(resolveIdentity([link(1, 'work')], WORLD, 'code.example')).eql({ identity: 'work', via: ['IDP_G'] });
  });

  it('should prefer an edge on the site sign-in itself, with nothing to go through', () => {
    should(resolveIdentity([link(3, 'home')], WORLD, 'plain.example')).eql({ identity: 'home', via: [] });
    should(resolveIdentity([link(2, 'direct'), link(1, 'work')], WORLD, 'code.example')).eql({
      identity: 'direct',
      via: [],
    });
  });

  it('should say ambiguous with BOTH identities when two hold G, never pick one', () => {
    should(resolveIdentity([link(1, 'work'), link(1, 'home')], WORLD, 'code.example')).eql({
      ambiguous: ['home', 'work'],
    });
  });

  it('should say none when no edge reaches the host, or the edge is for another sign-in', () => {
    should(resolveIdentity([], WORLD, 'code.example')).eql({ none: true });
    should(resolveIdentity([link(3, 'home')], WORLD, 'code.example')).eql({ none: true });
    should(resolveIdentity([link(1, 'work')], WORLD, 'unknown.example')).eql({ none: true });
  });

  it('should not take a sign-in of the provider account at ANOTHER site as the provider session', () => {
    // Google's account G signs in at its own page (si 1) and at other.example (si 4); only other.example is linked.
    const world = list(
      [account('IDP_G', [SI(1), SI(4)]), account('CODEHOST', [SI(2)])],
      [
        signIn(1, 'IDP_G', site('idp.example')),
        signIn(2, 'CODEHOST', site('code.example'), 'IDP_G'),
        signIn(4, 'IDP_G', site('other.example')),
      ],
    );
    should(resolveIdentity([link(4, 'personal')], world, 'code.example')).eql({ none: true });
    should(
      recoveryPlan([link(4, 'personal')], world, 'code.example', { providerSignedIn: true, standingRule: true }),
    ).eql([]);
    should(resolveIdentity([link(1, 'work')], world, 'code.example')).eql({ identity: 'work', via: ['IDP_G'] });
  });

  it('should keep the provider on the path when the site sign-in itself has a provider-round-trip edge', () => {
    const own = [link(2, 'work', 'provider-round-trip')];
    should(resolveIdentity(own, WORLD, 'code.example')).eql({ identity: 'work', via: ['IDP_G'] });
    should(recoveryPlan(own, WORLD, 'code.example', { providerSignedIn: true, standingRule: false })).eql([
      { do: 'click-provider', provider: 'IDP_G' },
      { do: 'choose-account', account: 'IDP_G' },
    ]);
  });

  it('should say which accounts when one identity holds the host under two, and plan no recovery', () => {
    const world = list(
      [account('IDP_G', [SI(1)]), account('CODEHOST', [SI(2)]), account('CODEHOST_TWO', [SI(5)])],
      [
        signIn(1, 'IDP_G', site('idp.example')),
        signIn(2, 'CODEHOST', site('code.example'), 'IDP_G'),
        signIn(5, 'CODEHOST_TWO', site('code.example')),
      ],
    );
    const both = [link(1, 'work'), link(5, 'work')];
    should(resolveIdentity(both, world, 'code.example')).eql({
      identity: 'work',
      ambiguousAccounts: ['CODEHOST', 'CODEHOST_TWO'],
    });
    should(recoveryPlan(both, world, 'code.example', { providerSignedIn: true, standingRule: true })).eql([]);
  });

  it('should follow a chain of providers and keep every account it passed', () => {
    const chain = list(
      [account('ROOT', [SI(1)]), account('MIDDLE', [SI(2)]), account('LEAF', [SI(3)])],
      [
        signIn(1, 'ROOT', site('root.example')),
        signIn(2, 'MIDDLE', site('middle.example'), 'ROOT'),
        signIn(3, 'LEAF', site('leaf.example'), 'MIDDLE'),
      ],
    );
    should(resolveIdentity([link(1, 'work')], chain, 'leaf.example')).eql({
      identity: 'work',
      via: ['MIDDLE', 'ROOT'],
    });
  });

  it('should refuse a circle of via links when it is saved, and end the walk if one is ever read', async () => {
    // The existing via check refuses the closing link, so a circle never reaches the store…
    const index = new MemoryLoginIndex();
    let key = 0;
    let id = 0;
    const daemon = daemonOver(index, new CountingSealed(), {
      newKey: () => `L${(++key).toString(16).toUpperCase().padStart(24, '0')}`,
      newSignInId: () => SI(100 + ++id),
    });
    await daemon.directory.putAccount('A', { label: 'A' });
    await daemon.directory.putAccount('B', { label: 'B' });
    const first = await daemon.directory.addSignIn('A', { place: site('a.example') });
    await daemon.directory.addSignIn('B', { place: site('b.example'), method: { kind: 'google', via: 'A' } });
    const refusal = (
      (await daemon.directory
        .putSignIn(first.id, { method: { kind: 'sso', name: 'B SSO', via: 'B' } })
        .catch((error: unknown) => error)) as { refusal?: string }
    ).refusal;
    should(refusal).equal('bad_via');

    // …and the pure walk still ends on a circle it was handed.
    const circle = list(
      [account('A', [SI(1)]), account('B', [SI(2)])],
      [signIn(1, 'A', site('a.example'), 'B'), signIn(2, 'B', site('b.example'), 'A')],
    );
    should(resolveIdentity([], circle, 'a.example')).eql({ none: true });
    should(recoveryPlan([], circle, 'a.example', { providerSignedIn: true, standingRule: true })).eql([]);
  });
});

describe('the steps back in after a login page (recoveryPlan)', () => {
  const LINKS = [link(1, 'work')];

  it('should click the provider button and choose G when the site shows login but G is still signed in', () => {
    should(recoveryPlan(LINKS, WORLD, 'code.example', { providerSignedIn: true, standingRule: true })).eql([
      { do: 'click-provider', provider: 'IDP_G' },
      { do: 'choose-account', account: 'IDP_G' },
    ]);
  });

  it('should fill G by the existing standing-rule path when G is signed out too', () => {
    should(recoveryPlan(LINKS, WORLD, 'code.example', { providerSignedIn: false, standingRule: true })).eql([
      { do: 'click-provider', provider: 'IDP_G' },
      { do: 'fill', signIn: SI(1), by: 'standing-rule' },
    ]);
  });

  it('should end on the owner card when G is signed out and no standing rule covers it', () => {
    should(recoveryPlan(LINKS, WORLD, 'code.example', { providerSignedIn: false, standingRule: false })).eql([
      { do: 'click-provider', provider: 'IDP_G' },
      { do: 'ask-owner', signIn: SI(1) },
    ]);
  });

  it('should fill (or ask for) a password sign-in held directly, with no provider step', () => {
    const own = [link(3, 'home')];
    should(recoveryPlan(own, WORLD, 'plain.example', { providerSignedIn: true, standingRule: true })).eql([
      { do: 'fill', signIn: SI(3), by: 'standing-rule' },
    ]);
    should(recoveryPlan(own, WORLD, 'plain.example', { providerSignedIn: true, standingRule: false })).eql([
      { do: 'ask-owner', signIn: SI(3) },
    ]);
  });

  it('should plan nothing when no identity holds the host, or two do: the owner chooses, never us', () => {
    const facts = { providerSignedIn: true, standingRule: true };
    should(recoveryPlan([], WORLD, 'code.example', facts)).eql([]);
    should(recoveryPlan([link(1, 'work'), link(1, 'home')], WORLD, 'code.example', facts)).eql([]);
  });
});

/**
 * THROUGH THE REAL IN-MEMORY ACCOUNTS DIRECTORY (R1): the listing's `via.signIn` is built by the directory, not by a
 * helper, so the proof that only the provider's OWN sign-in counts has to hold for whichever sign-in was saved first.
 */
describe('which sign-in the directory names as the provider (real directory, both save orders)', () => {
  const OWN = 'accounts.google.com';
  const OTHER = 'other.example';

  async function saved(order: readonly string[]) {
    const index = new MemoryLoginIndex();
    const sealed = new CountingSealed();
    let signInNo = 0;
    let keyNo = 0;
    const { directory } = daemonOver(index, sealed, {
      newKey: () => `L${(++keyNo).toString(16).toUpperCase().padStart(24, '0')}`,
      newSignInId: () => `si_${(++signInNo).toString(16).padStart(16, '0')}`,
    });
    await directory.putAccount('GOOGLE', { label: 'Google' });
    await directory.putAccount('PERSONAL', { label: 'Personal' });
    const ids = new Map<string, string>();
    for (const host of order) ids.set(host, (await directory.addSignIn('GOOGLE', { place: site(host) })).id);
    const backed = await directory.addSignIn('PERSONAL', {
      place: site('backed.example'),
      method: { kind: 'google', via: 'GOOGLE' },
    });
    const listing = await directory.list();
    return { listing, ids, backed };
  }

  for (const order of [
    [OTHER, OWN],
    [OWN, OTHER],
  ]) {
    it(`should name Google's own sign-in as the provider when saved in the order ${order.join(' then ')}`, async () => {
      const { listing, ids, backed } = await saved(order);
      should(listing.signIns.find(each => each.id === backed.id)?.via?.signIn).equal(ids.get(OWN));
    });

    it(`should not put a Google-backed site in the identity that holds only another site (${order.join(' then ')})`, async () => {
      const { listing, ids } = await saved(order);
      const onlyOther: IdentityLink = {
        signIn: ids.get(OTHER) as string,
        identity: 'personal',
        seenAt: AT,
        how: 'filled',
      };
      should(resolveIdentity([onlyOther], listing, 'backed.example')).eql({ none: true });
      should(recoveryPlan([onlyOther], listing, 'backed.example', { providerSignedIn: true, standingRule: true })).eql(
        [],
      );
    });

    it(`should still follow a link on Google's own sign-in (${order.join(' then ')})`, async () => {
      const { listing, ids } = await saved(order);
      const own: IdentityLink = { signIn: ids.get(OWN) as string, identity: 'personal', seenAt: AT, how: 'filled' };
      should(resolveIdentity([own], listing, 'backed.example')).eql({ identity: 'personal', via: ['GOOGLE'] });
    });
  }

  it('should name no provider sign-in when the provider account has none at its own host', async () => {
    const { listing, backed } = await saved([OTHER]);
    should(listing.signIns.find(each => each.id === backed.id)?.via?.signIn).be.undefined();
  });
});
