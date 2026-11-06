import { describe, it } from 'bun:test';
import type { LoginObservation, LoginRecipeProposal, SignInId } from '@ferretry/protocol';
import should from 'should';
import { LoginDirectory, LoginEntryError } from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';
import { putSavedLogin } from './saved-login-fixture.ts';

let now = '2026-10-31T09:00:00.000Z';
const CLOCK = { now: () => now };

function world() {
  const index = new MemoryLoginIndex();
  let key = 0;
  const newKey = () => `L${(key++).toString(16).toUpperCase().padStart(24, '0')}`;
  return {
    index,
    directory: new LoginDirectory(index, new MemorySecretDocuments(), new FakeSecretCipher(), CLOCK, { newKey }),
  };
}

type World = ReturnType<typeof world>;

/** The account's only sign-in as the store lists it (each login here signs in at one place). */
const signInOf = async (w: World, id: string) =>
  (await w.directory.accounts.list()).signIns.find(signIn => signIn.account === id);
const signInIdOf = async (w: World, id: string): Promise<SignInId> =>
  (await signInOf(w, id))?.id ?? 'si_00000000000000ff';
/** Facts and proposals are filed by SIGN-IN: the observer's and the recipe service's one path. */
const observe = async (w: World, id: string, seen: LoginObservation) =>
  await w.directory.accounts.observeSignIn(await signInIdOf(w, id), seen);
const propose = async (w: World, id: string, filed: LoginRecipeProposal) =>
  await w.directory.accounts.proposeSignIn(await signInIdOf(w, id), filed);
const proposalCard = async (w: World, id: string, proposalId: string, card: string) =>
  await w.directory.accounts.proposalCardSignIn(await signInIdOf(w, id), proposalId, card);
const decide = async (w: World, id: string, proposalId: string, decision: 'approve' | 'decline') =>
  await w.directory.accounts.decideSignIn(await signInIdOf(w, id), proposalId, decision);
const edit = async (w: World, id: string, change: Parameters<World['directory']['accounts']['putSignIn']>[1]) =>
  await w.directory.accounts.putSignIn(await signInIdOf(w, id), change);

const proposal = (id: string, recipe: string, base?: string): LoginRecipeProposal => ({
  id,
  recipe,
  ...(base === undefined ? {} : { base }),
  why: 'the button moved',
  sessionId: 'session-1',
  proposedAt: '2026-10-31T10:00:00.000Z',
});

describe('a sign-in keeps its recipe', () => {
  it('should store the recipe and remove it with null, keeping the rest', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'VERCEL', { label: 'Vercel', match: ['vercel.com'], username: 'kirin' });
    const with_ = await edit(w, 'VERCEL', { recipe: 'Open app.vercel.com\n→ Continue with Google' });
    should(with_.recipe).equal('Open app.vercel.com\n→ Continue with Google');
    await w.directory.accounts.putAccount('VERCEL', { label: 'Vercel (team)' });
    const relabelled = await signInOf(w, 'VERCEL');
    should(relabelled?.recipe).equal('Open app.vercel.com\n→ Continue with Google');
    should((await w.directory.accounts.list()).accounts[0]).containDeep({ label: 'Vercel (team)', username: 'kirin' });
    const cleared = await edit(w, 'VERCEL', { recipe: null });
    should(cleared.recipe).be.undefined();
  });

  it('should list auto-apply only once the owner turned it on', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'VERCEL', { label: 'Vercel', match: ['vercel.com'] });
    should(await signInOf(w, 'VERCEL')).not.have.property('autoApplyRecipe');
    const on = await edit(w, 'VERCEL', { autoApplyRecipe: true });
    should(on.autoApplyRecipe).be.true();
    const back = await edit(w, 'VERCEL', { autoApplyRecipe: false });
    should(back).not.have.property('autoApplyRecipe');
  });

  it('should rewrite [[OLD]] in other recipes when an account is renamed, and leave it after a delete', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'GOOGLE', { label: 'Google', match: ['google.com'] });
    await putSavedLogin(w.directory, 'VERCEL', {
      label: 'Vercel',
      match: ['vercel.com'],
      recipe: 'Continue with Google → [[GOOGLE]] → done',
    });
    await w.directory.accounts.renameAccount('GOOGLE', 'GOOGLE_KIRIN');
    should((await signInOf(w, 'VERCEL'))?.recipe).equal('Continue with Google → [[GOOGLE_KIRIN]] → done');
    await w.directory.accounts.removeAccount('GOOGLE_KIRIN');
    should((await signInOf(w, 'VERCEL'))?.recipe).equal('Continue with Google → [[GOOGLE_KIRIN]] → done');
  });
});

describe('a sign-in keeps what the daemon saw', () => {
  it('should count the same fact at the same field, without touching updatedAt', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'GOOGLE', { label: 'Google', domains: ['accounts.google.com'], match: [] });
    const seen = { at: 'accounts.google.com', surface: 'page', identity: '0123456789abcdef', masked: true } as const;
    now = '2026-10-31T11:00:00.000Z';
    await observe(w, 'GOOGLE', seen);
    await observe(w, 'GOOGLE', { ...seen, masked: undefined, noEchoAfterSubmit: true });
    await observe(w, 'GOOGLE', seen);
    const entry = await signInOf(w, 'GOOGLE');
    should(entry?.updatedAt).equal('2026-10-31T09:00:00.000Z');
    should(entry?.observed).deepEqual([
      {
        at: 'accounts.google.com',
        surface: 'page',
        identity: '0123456789abcdef',
        since: '2026-10-31T11:00:00.000Z',
        masked: { value: true, observedAt: '2026-10-31T11:00:00.000Z', count: 2 },
        noEchoAfterSubmit: { value: true, observedAt: '2026-10-31T11:00:00.000Z', count: 1 },
      },
    ]);
    now = '2026-10-31T09:00:00.000Z';
  });

  it('should start again when the field is another one, and when a fact is seen the other way', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'GOOGLE', {
      label: 'Google',
      match: ['google.com'],
      domains: ['accounts.google.com'],
    });
    const seen = { at: 'accounts.google.com', surface: 'page', identity: '0123456789abcdef', masked: true } as const;
    await observe(w, 'GOOGLE', seen);
    await observe(w, 'GOOGLE', seen);
    await observe(w, 'GOOGLE', { ...seen, masked: false });
    should((await signInOf(w, 'GOOGLE'))?.observed?.[0]?.masked).containDeep({ value: false, count: 1 });
    await observe(w, 'GOOGLE', { ...seen, noEchoAfterSubmit: true, masked: undefined });
    await observe(w, 'GOOGLE', { ...seen, identity: 'fedcba9876543210', masked: undefined });
    const [replaced] = (await signInOf(w, 'GOOGLE'))?.observed ?? [];
    should(replaced?.identity).equal('fedcba9876543210');
    should(replaced).not.have.property('masked');
    should(replaced).not.have.property('noEchoAfterSubmit');
  });

  it('should ignore a fact about a sign-in that is gone', async () => {
    const w = world();
    await observe(w, 'NOPE', { at: 'x.com', surface: 'page', identity: '0123456789abcdef', masked: true });
    should((await w.directory.accounts.list()).signIns).deepEqual([]);
  });
});

describe('a ferret proposes a recipe', () => {
  it('should wait on the owner, and keep only the three newest', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'VERCEL', { label: 'Vercel', match: ['vercel.com'] });
    for (const n of [1, 2, 3]) {
      const filed = await propose(w, 'VERCEL', proposal(`rp_000000000000000${String(n)}`, `step ${String(n)}`));
      should(filed).deepEqual({ applied: false, dropped: [] });
    }
    const fourth = await propose(w, 'VERCEL', proposal('rp_0000000000000004', 'step 4'));
    should(fourth.dropped.map(dropped => dropped.id)).deepEqual(['rp_0000000000000001']);
    const entry = await signInOf(w, 'VERCEL');
    should(entry?.recipe).be.undefined();
    should(entry?.proposals?.map(waiting => waiting.id)).deepEqual([
      'rp_0000000000000002',
      'rp_0000000000000003',
      'rp_0000000000000004',
    ]);
  });

  it('should apply at once when the owner allows it for this sign-in', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'VERCEL', { label: 'Vercel', match: ['vercel.com'], autoApplyRecipe: true });
    should(await propose(w, 'VERCEL', proposal('rp_0000000000000001', 'new steps'))).deepEqual({
      applied: true,
      dropped: [],
    });
    const entry = await signInOf(w, 'VERCEL');
    should(entry?.recipe).equal('new steps');
    should(entry).not.have.property('proposals');
  });

  it('should refuse a proposal for a sign-in that does not exist', async () => {
    const error = await propose(world(), 'NOPE', proposal('rp_0000000000000001', 'x')).catch(
      (caught: unknown) => caught,
    );
    should(error).be.instanceOf(LoginEntryError);
    should((error as LoginEntryError).refusal).equal('unknown_sign_in');
  });

  it('should approve one proposed against the recipe as it is, and remove it', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'VERCEL', { label: 'Vercel', match: ['vercel.com'], recipe: 'old' });
    await propose(w, 'VERCEL', proposal('rp_0000000000000001', 'new', 'old'));
    await proposalCard(w, 'VERCEL', 'rp_0000000000000001', 'A7');
    const { signIn, proposal: answered } = await decide(w, 'VERCEL', 'rp_0000000000000001', 'approve');
    should(signIn.recipe).equal('new');
    should(signIn).not.have.property('proposals');
    should(answered.agendaItemId).equal('A7');
  });

  it('should refuse to approve a proposal made against an older recipe, and still decline it', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'VERCEL', { label: 'Vercel', match: ['vercel.com'], recipe: 'old' });
    await propose(w, 'VERCEL', proposal('rp_0000000000000001', 'new', 'old'));
    await edit(w, 'VERCEL', { recipe: 'edited by the owner' });
    const stale = await decide(w, 'VERCEL', 'rp_0000000000000001', 'approve').catch((caught: unknown) => caught);
    should((stale as LoginEntryError).refusal).equal('stale_proposal');
    const { signIn } = await decide(w, 'VERCEL', 'rp_0000000000000001', 'decline');
    should(signIn.recipe).equal('edited by the owner');
    should(signIn).not.have.property('proposals');
    const gone = await decide(w, 'VERCEL', 'rp_0000000000000001', 'decline').catch((caught: unknown) => caught);
    should((gone as LoginEntryError).refusal).equal('unknown_proposal');
  });
});

describe('who wrote the recipe', () => {
  it('should mark an auto-applied recipe as a ferret’s, until the owner edits or approves', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'VERCEL', { label: 'Vercel', match: ['vercel.com'], autoApplyRecipe: true });
    await propose(w, 'VERCEL', proposal('rp_0000000000000001', 'ferret steps'));
    should((await signInOf(w, 'VERCEL'))?.recipeBy).equal('ferret');
    await w.directory.accounts.putAccount('VERCEL', { label: 'Vercel (team)' });
    should((await signInOf(w, 'VERCEL'))?.recipeBy).equal('ferret');
    const owned = await edit(w, 'VERCEL', { recipe: 'owner steps' });
    should(owned).not.have.property('recipeBy');
  });

  it('should make an approved recipe the owner’s, and keep the mark on a decline', async () => {
    const w = world();
    await putSavedLogin(w.directory, 'VERCEL', { label: 'Vercel', match: ['vercel.com'], autoApplyRecipe: true });
    await propose(w, 'VERCEL', proposal('rp_0000000000000001', 'ferret steps'));
    await edit(w, 'VERCEL', { autoApplyRecipe: false });
    await propose(w, 'VERCEL', proposal('rp_0000000000000002', 'more', 'ferret steps'));
    await propose(w, 'VERCEL', proposal('rp_0000000000000003', 'other', 'ferret steps'));
    const declined = await decide(w, 'VERCEL', 'rp_0000000000000002', 'decline');
    should(declined.signIn.recipeBy).equal('ferret');
    const approved = await decide(w, 'VERCEL', 'rp_0000000000000003', 'approve');
    should(approved.signIn).not.have.property('recipeBy');
    should(approved.signIn.recipe).equal('other');
  });
});
