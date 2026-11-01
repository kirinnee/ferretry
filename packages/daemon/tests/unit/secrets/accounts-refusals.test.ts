import { describe, it } from 'bun:test';
import {
  type AccountIndexDocument,
  type LoginRecipeProposal,
  type Place,
  PutLoginEntryRequestSchema,
  TotpParametersSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  AccountDirectory,
  LoginDirectory,
  LoginRecipeService,
  SecretStoreError,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex } from '../runtime/mounts/support.ts';
import { CLOCK, CountingSealed, daemonOver, SEED } from './accounts-fixtures.ts';

/**
 * The account store's refusals, limits and owner answers, one per rule: every way a change is refused leaves the store
 * as it was, and every way it is answered says which thing for the person to do.
 */

const site = (...domains: string[]): Place => ({ kind: 'site', domains, match: domains });
const terminal = (tool: string, host: string): Place => ({ kind: 'terminal', tool, host });
const keyOf = (n: number) => `L${n.toString(16).toUpperCase().padStart(24, '0')}`;

function world(options: { readonly seals?: boolean } = {}) {
  const index = new MemoryLoginIndex();
  const sealed = new CountingSealed();
  let key = 0;
  let signIn = 0;
  const ids = {
    newKey: () => keyOf(++key),
    newSignInId: () => `si_${(++signIn).toString(16).padStart(16, '0')}`,
  };
  const daemon = daemonOver(index, sealed, ids);
  const directory =
    options.seals === false
      ? new AccountDirectory(index, sealed, new FakeSecretCipher(), CLOCK, ids)
      : daemon.directory;
  const logins = new LoginDirectory(index, sealed, new FakeSecretCipher(), CLOCK, ids);
  return { index, sealed, vault: daemon.vault, directory, logins };
}

const failure = async (work: Promise<unknown>) =>
  (await work.catch((error: unknown) => error)) as Error & { refusal?: string; failure?: string };

const proposal = (id: string, recipe: string, base?: string): LoginRecipeProposal => ({
  id,
  recipe,
  ...(base === undefined ? {} : { base }),
  why: 'the button moved',
  sessionId: 'session-1',
  proposedAt: '2026-10-31T10:00:00.000Z',
});

describe('a change the store rules refuse', () => {
  it('should refuse a record its schema refuses, writing nothing', async () => {
    const w = world();
    const refused = await failure(w.directory.putAccount('LONG', { label: 'x'.repeat(200) }));
    should(refused.refusal).equal('invalid_change');
    should(w.index.document).be.undefined();
  });

  it('should refuse a recipe that is not one a recipe may be, from a caller that skipped the route', async () => {
    const w = world();
    await w.directory.putAccount('SITE', { label: 'Site' });
    const refused = await failure(w.directory.addSignIn('SITE', { place: site('site.example'), recipe: 'a​b' }));
    should(refused.refusal).equal('invalid_change');
  });

  it('should refuse a seventeenth sign-in of one account as full', async () => {
    const w = world();
    await w.directory.putAccount('MANY', { label: 'Many' });
    for (let n = 0; n < 16; n += 1) await w.directory.addSignIn('MANY', { place: site(`s${String(n)}.example`) });
    const refused = await failure(w.directory.addSignIn('MANY', { place: site('one-more.example') }));
    should(refused).be.instanceOf(SecretStoreError);
    should(refused.failure).equal('full');
  });

  it('should refuse a sign-in past the store limit as full', async () => {
    const w = world();
    const accounts: AccountIndexDocument['accounts'] = {};
    const signIns: AccountIndexDocument['signIns'] = {};
    for (let a = 0; a < 32; a += 1) {
      accounts[`A${String(a)}`] = {
        key: keyOf(1000 + a),
        label: `a${String(a)}`,
        seals: {},
        createdAt: 't',
        updatedAt: 't',
      };
      for (let s = 0; s < 16; s += 1)
        signIns[`si_${(a * 16 + s + 1).toString(16).padStart(16, '0')}`] = {
          account: keyOf(1000 + a),
          place: site(`h${String(s)}.example`),
          createdAt: 't',
          updatedAt: 't',
        };
    }
    w.index.document = { v: 2, accounts, signIns };
    await w.directory.putAccount('ROOM', { label: 'Room' });
    const refused = await failure(w.directory.addSignIn('ROOM', { place: site('room.example') }));
    should(refused.failure).equal('full');
  });

  it('should refuse a merge that would give an account more sign-ins than one may have', async () => {
    const w = world();
    await w.directory.putAccount('KEEP', { label: 'Keep' });
    await w.directory.putAccount('FROM', { label: 'From' });
    for (let n = 0; n < 9; n += 1) {
      await w.directory.addSignIn('KEEP', { place: site(`k${String(n)}.example`) });
      await w.directory.addSignIn('FROM', { place: site(`f${String(n)}.example`) });
    }
    should((await failure(w.directory.merge('KEEP', 'FROM'))).failure).equal('full');
  });

  it('should refuse a merge that would give an account more 2FA keys than one may have', async () => {
    const w = world();
    const factor = (n: number, label: string) => ({
      id: `tf_${n.toString(16).padStart(12, '0')}`,
      kind: 'sms' as const,
      label,
      addedAt: 't',
      addedBy: 'owner' as const,
    });
    w.index.document = {
      v: 2,
      accounts: {
        KEEP: {
          key: keyOf(1),
          label: 'Keep',
          seals: {},
          factors: [1, 2, 3, 4, 5].map(n => factor(n, `keep ${String(n)}`)),
          createdAt: 't',
          updatedAt: 't',
        },
        FROM: {
          key: keyOf(2),
          label: 'From',
          seals: {},
          // One label KEEP already has: that key is not moved (it holds no value).
          factors: [factor(6, 'KEEP 1'), ...[7, 8, 9, 10].map(n => factor(n, `from ${String(n)}`))],
          createdAt: 't',
          updatedAt: 't',
        },
      },
      signIns: {},
    };
    should((await failure(w.directory.merge('KEEP', 'FROM'))).refusal).equal('invalid_change');
  });
});

describe('a merge, the rest of its rules', () => {
  it('should refuse a merge that would leave a sign-in going via its own account', async () => {
    const w = world();
    await w.directory.putAccount('KEEP', { label: 'Keep' });
    await w.directory.putAccount('FROM', { label: 'From' });
    await w.directory.addSignIn('FROM', { place: site('from.example') });
    await w.directory.addSignIn('KEEP', { place: site('keep.example'), method: { kind: 'google', via: 'FROM' } });
    const refused = await failure(w.directory.merge('KEEP', 'FROM'));
    should(refused.refusal).equal('merge_refused');
    should(refused.message).containEql('via itself');
  });

  it('should drop the same seed from FROM, keep keys with no value by label, and carry "keep apart" over', async () => {
    const w = world();
    await w.directory.putAccount('KEEP', { label: 'Keep' });
    await w.directory.putAccount('FROM', { label: 'From' });
    await w.directory.putAccount('OTHER', { label: 'Other' });
    for (const id of ['KEEP', 'FROM'])
      await w.logins.put(id, PutLoginEntryRequestSchema.parse({ totp: { seed: SEED }, totpAcknowledged: true }));
    const from = w.index.accounts.accounts.FROM as NonNullable<AccountIndexDocument['accounts']['FROM']>;
    w.index.document = {
      ...w.index.accounts,
      accounts: {
        ...w.index.accounts.accounts,
        FROM: {
          ...from,
          factors: [
            ...(from.factors ?? []),
            { id: 'tf_0000000000f1', kind: 'sms', label: 'Phone', endsWith: '42', addedAt: 't', addedBy: 'owner' },
          ],
        },
      },
    };
    await w.directory.apart('FROM', 'OTHER');

    const merged = await w.directory.merge('KEEP', 'FROM');

    should(merged.factors.map(key => [key.kind, key.label, key.automatic])).deepEqual([
      ['totp', 'Authenticator app', true],
      ['sms', 'Phone', false],
    ]);
    const keep = w.index.accounts.accounts.KEEP;
    should(keep?.apartFrom).deepEqual([w.index.accounts.accounts.OTHER?.key]);
    should(w.index.accounts.accounts.OTHER?.apartFrom).be.undefined();
  });

  it('should refuse to merge where nothing can compare or move a sealed value', async () => {
    const w = world({ seals: false });
    await w.directory.putAccount('KEEP', { label: 'Keep', password: 'one-UNIQUE-pw-1' });
    await w.directory.putAccount('FROM', { label: 'From', password: 'one-UNIQUE-pw-1' });
    should((await failure(w.directory.merge('KEEP', 'FROM'))).message).containEql('cannot compare');
    await w.directory.putAccount('KEEP', { password: null });
    should((await failure(w.directory.merge('KEEP', 'FROM'))).message).containEql('cannot move');
  });

  it('should drop a deleted account from every "keep apart" list', async () => {
    const w = world();
    await w.directory.putAccount('ONE', { label: 'One' });
    await w.directory.putAccount('TWO', { label: 'Two' });
    await w.directory.putAccount('THREE', { label: 'Three' });
    await w.directory.apart('ONE', 'TWO');
    await w.directory.apart('ONE', 'THREE');
    await w.directory.removeAccount('TWO');
    should(w.index.accounts.accounts.ONE?.apartFrom).deepEqual([w.index.accounts.accounts.THREE?.key]);
    await w.directory.removeAccount('THREE');
    should(w.index.accounts.accounts.ONE).not.have.property('apartFrom');
  });

  it('should refuse to keep an account apart from itself', async () => {
    const w = world();
    await w.directory.putAccount('ONE', { label: 'One' });
    should((await failure(w.directory.apart('ONE', 'ONE'))).refusal).equal('invalid_change');
  });
});

describe('a recipe proposal on one sign-in', () => {
  it('should file, card, approve and decline by sign-in, and refuse one that is gone', async () => {
    const w = world();
    await w.directory.putAccount('SITE', { label: 'Site' });
    const { id } = await w.directory.addSignIn('SITE', { place: site('site.example'), recipe: 'old' });

    should((await w.directory.proposeSignIn(id, proposal('rp_0000000000000001', 'new', 'old'))).applied).be.false();
    await w.directory.proposalCardSignIn(id, 'rp_0000000000000001', 'A1');
    should((await w.directory.list()).signIns[0]?.proposals?.[0]?.agendaItemId).equal('A1');
    const approved = await w.directory.decideSignIn(id, 'rp_0000000000000001', 'approve');
    should(approved.signIn.recipe).equal('new');
    should(approved.signIn.recipeVersion).equal(2);
    should((await failure(w.directory.decideSignIn(id, 'rp_0000000000000001', 'decline'))).refusal).equal(
      'unknown_proposal',
    );
    should(
      (await failure(w.directory.proposeSignIn('si_00000000000000ff', proposal('rp_0000000000000002', 'x')))).refusal,
    ).equal('unknown_sign_in');
  });

  it('should refuse an owner answer by sign-in where the service has no account store', async () => {
    const w = world();
    const recipes = new LoginRecipeService({
      logins: w.logins,
      values: { redact: async text => text },
      agenda: { raise: async () => ({ ok: false, message: 'none' }), close: async () => undefined },
      audit: { record: async () => undefined },
      clock: CLOCK,
    });
    should(
      (await failure(recipes.decideSignIn('si_0000000000000001', 'rp_0000000000000001', 'approve'))).refusal,
    ).equal('unknown_sign_in');
  });
});

describe('an older client over the account store, the rest of its refusals', () => {
  it('should refuse a seed by the older route where the account keeps two', async () => {
    const w = world();
    w.index.document = {
      v: 2,
      accounts: {
        TWO: {
          key: keyOf(1),
          label: 'Two seeds',
          seals: {},
          factors: [1, 2].map(n => ({
            id: `tf_${n.toString(16).padStart(12, '0')}`,
            kind: 'totp' as const,
            label: `Phone ${String(n)}`,
            seal: `${keyOf(1)}_TOTP_0000000${String(n)}`,
            params: TotpParametersSchema.parse({}),
            addedAt: 't',
            addedBy: 'owner' as const,
          })),
          createdAt: 't',
          updatedAt: 't',
        },
      },
      signIns: {},
    };
    const refused = await failure(
      w.logins.put('TWO', PutLoginEntryRequestSchema.parse({ totp: { seed: SEED }, totpAcknowledged: true })),
    );
    should(refused.refusal).equal('account_has_2fa_keys');
  });

  it('should refuse a saved login that would sign in at more places than an account may', async () => {
    const w = world();
    const match = Array.from({ length: 16 }, (_, n) => `sudo@host${String(n)}`);
    const refused = await failure(
      w.logins.put('WIDE', PutLoginEntryRequestSchema.parse({ label: 'Wide', match, domains: ['wide.example'] })),
    );
    should(refused.refusal).equal('invalid_change');
    should(w.index.document).be.undefined();
  });

  it('should refuse a proposal by account for one that signs in nowhere', async () => {
    const w = world();
    await w.logins.put('NOWHERE', PutLoginEntryRequestSchema.parse({ label: 'Nowhere' }));
    should((await failure(w.logins.propose('NOWHERE', proposal('rp_0000000000000003', 'x')))).refusal).equal(
      'no_sign_in',
    );
  });

  it('should keep a terminal-only saved login when an older client resends it as it is', async () => {
    const w = world();
    await w.directory.putAccount('SUDO', { label: 'sudo' });
    const { id } = await w.directory.addSignIn('SUDO', { place: terminal('sudo', 'kirin-box') });
    await w.logins.put('SUDO', PutLoginEntryRequestSchema.parse({ match: ['sudo@kirin-box'] }));
    should((await w.directory.list()).signIns.map(signIn => signIn.id)).deepEqual([id]);
  });
});

describe('the boot step when reading the index fails for another reason', () => {
  it('should raise, not call it damaged: only a store error is one', async () => {
    const sealed = new CountingSealed();
    const broken = new MemoryLoginIndex();
    broken.read = async () => {
      throw new Error('the disk went away');
    };
    const refused = await failure(daemonOver(broken, sealed).directory.prepare());
    should(refused.message).equal('the disk went away');
    should(sealed.writes).equal(0);
  });
});
