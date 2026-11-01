import { describe, it } from 'bun:test';
import { type LoginRecipeProposal, type PutLoginEntry, PutLoginEntryRequestSchema } from '@ferretry/protocol';
import should from 'should';
import { LoginDirectory, LoginEntryError } from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';

let now = '2026-10-31T09:00:00.000Z';
const CLOCK = { now: () => now };
const change = (input: unknown): PutLoginEntry => PutLoginEntryRequestSchema.parse(input);

function world() {
  const index = new MemoryLoginIndex();
  let key = 0;
  const newKey = () => `L${(key++).toString(16).toUpperCase().padStart(24, '0')}`;
  return {
    index,
    directory: new LoginDirectory(index, new MemorySecretDocuments(), new FakeSecretCipher(), CLOCK, { newKey }),
  };
}

const proposal = (id: string, recipe: string, base?: string): LoginRecipeProposal => ({
  id,
  recipe,
  ...(base === undefined ? {} : { base }),
  why: 'the button moved',
  sessionId: 'session-1',
  proposedAt: '2026-10-31T10:00:00.000Z',
});

describe('a saved login keeps its recipe', () => {
  it('should store the recipe and remove it with null, keeping the rest', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], username: 'kirin' }));
    const with_ = await w.directory.put('VERCEL', change({ recipe: 'Open app.vercel.com\r\n→ Continue with Google' }));
    should(with_.recipe).equal('Open app.vercel.com\n→ Continue with Google');
    should(with_.username).equal('kirin');
    const relabelled = await w.directory.put('VERCEL', change({ label: 'Vercel (team)' }));
    should(relabelled.recipe).equal('Open app.vercel.com\n→ Continue with Google');
    const cleared = await w.directory.put('VERCEL', change({ recipe: null }));
    should(cleared.recipe).be.undefined();
  });

  it('should list auto-apply only once the owner turned it on', async () => {
    const w = world();
    const off = await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'] }));
    should(off).not.have.property('autoApplyRecipe');
    const on = await w.directory.put('VERCEL', change({ autoApplyRecipe: true }));
    should(on.autoApplyRecipe).be.true();
    const back = await w.directory.put('VERCEL', change({ autoApplyRecipe: false }));
    should(back).not.have.property('autoApplyRecipe');
  });

  it('should rewrite [[OLD]] in other recipes when a login is renamed, and leave it after a delete', async () => {
    const w = world();
    await w.directory.put('GOOGLE', change({ label: 'Google', match: ['google.com'] }));
    await w.directory.put(
      'VERCEL',
      change({ label: 'Vercel', match: ['vercel.com'], recipe: 'Continue with Google → [[GOOGLE]] → done' }),
    );
    await w.directory.rename('GOOGLE', 'GOOGLE_KIRIN');
    const renamed = (await w.directory.list()).find(entry => entry.id === 'VERCEL');
    should(renamed?.recipe).equal('Continue with Google → [[GOOGLE_KIRIN]] → done');
    await w.directory.remove('GOOGLE_KIRIN');
    const after = (await w.directory.list()).find(entry => entry.id === 'VERCEL');
    should(after?.recipe).equal('Continue with Google → [[GOOGLE_KIRIN]] → done');
  });
});

describe('a saved login keeps what the daemon saw', () => {
  it('should count the same fact at the same field, without touching updatedAt', async () => {
    const w = world();
    await w.directory.put('GOOGLE', change({ label: 'Google', domains: ['accounts.google.com'] }));
    const seen = { at: 'accounts.google.com', surface: 'page', identity: '0123456789abcdef', masked: true } as const;
    now = '2026-10-31T11:00:00.000Z';
    await w.directory.observe('GOOGLE', seen);
    await w.directory.observe('GOOGLE', { ...seen, masked: undefined, noEchoAfterSubmit: true });
    await w.directory.observe('GOOGLE', seen);
    const [entry] = await w.directory.list();
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
    await w.directory.put(
      'GOOGLE',
      change({ label: 'Google', match: ['google.com'], domains: ['accounts.google.com'] }),
    );
    const seen = { at: 'accounts.google.com', surface: 'page', identity: '0123456789abcdef', masked: true } as const;
    await w.directory.observe('GOOGLE', seen);
    await w.directory.observe('GOOGLE', seen);
    await w.directory.observe('GOOGLE', { ...seen, masked: false });
    should((await w.directory.list())[0]?.observed?.[0]?.masked).containDeep({ value: false, count: 1 });
    await w.directory.observe('GOOGLE', { ...seen, noEchoAfterSubmit: true, masked: undefined });
    await w.directory.observe('GOOGLE', { ...seen, identity: 'fedcba9876543210', masked: undefined });
    const [replaced] = (await w.directory.list())[0]?.observed ?? [];
    should(replaced?.identity).equal('fedcba9876543210');
    should(replaced).not.have.property('masked');
    should(replaced).not.have.property('noEchoAfterSubmit');
  });

  it('should ignore a fact about a login that is gone', async () => {
    const w = world();
    await w.directory.observe('NOPE', { at: 'x.com', surface: 'page', identity: '0123456789abcdef', masked: true });
    should(await w.directory.list()).deepEqual([]);
  });
});

describe('a ferret proposes a recipe', () => {
  it('should wait on the owner, and keep only the three newest', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'] }));
    for (const n of [1, 2, 3]) {
      const filed = await w.directory.propose(
        'VERCEL',
        proposal(`rp_000000000000000${String(n)}`, `step ${String(n)}`),
      );
      should(filed).deepEqual({ applied: false, dropped: [] });
    }
    const fourth = await w.directory.propose('VERCEL', proposal('rp_0000000000000004', 'step 4'));
    should(fourth.dropped.map(dropped => dropped.id)).deepEqual(['rp_0000000000000001']);
    const [entry] = await w.directory.list();
    should(entry?.recipe).be.undefined();
    should(entry?.proposals?.map(waiting => waiting.id)).deepEqual([
      'rp_0000000000000002',
      'rp_0000000000000003',
      'rp_0000000000000004',
    ]);
  });

  it('should apply at once when the owner allows it for this login', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], autoApplyRecipe: true }));
    should(await w.directory.propose('VERCEL', proposal('rp_0000000000000001', 'new steps'))).deepEqual({
      applied: true,
      dropped: [],
    });
    const [entry] = await w.directory.list();
    should(entry?.recipe).equal('new steps');
    should(entry).not.have.property('proposals');
  });

  it('should refuse a proposal for a login that does not exist', async () => {
    const error = await world()
      .directory.propose('NOPE', proposal('rp_0000000000000001', 'x'))
      .catch((caught: unknown) => caught);
    should(error).be.instanceOf(LoginEntryError);
    should((error as LoginEntryError).refusal).equal('unknown_login');
  });

  it('should approve one proposed against the recipe as it is, and remove it', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], recipe: 'old' }));
    await w.directory.propose('VERCEL', proposal('rp_0000000000000001', 'new', 'old'));
    await w.directory.proposalCard('VERCEL', 'rp_0000000000000001', 'A7');
    const { entry, proposal: answered } = await w.directory.decide('VERCEL', 'rp_0000000000000001', 'approve');
    should(entry.recipe).equal('new');
    should(entry).not.have.property('proposals');
    should(answered.agendaItemId).equal('A7');
  });

  it('should refuse to approve a proposal made against an older recipe, and still decline it', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], recipe: 'old' }));
    await w.directory.propose('VERCEL', proposal('rp_0000000000000001', 'new', 'old'));
    await w.directory.put('VERCEL', change({ recipe: 'edited by the owner' }));
    const stale = await w.directory
      .decide('VERCEL', 'rp_0000000000000001', 'approve')
      .catch((caught: unknown) => caught);
    should((stale as LoginEntryError).refusal).equal('stale_proposal');
    const { entry } = await w.directory.decide('VERCEL', 'rp_0000000000000001', 'decline');
    should(entry.recipe).equal('edited by the owner');
    should(entry).not.have.property('proposals');
    const gone = await w.directory
      .decide('VERCEL', 'rp_0000000000000001', 'decline')
      .catch((caught: unknown) => caught);
    should((gone as LoginEntryError).refusal).equal('unknown_proposal');
  });
});

describe('who wrote the recipe', () => {
  it('should mark an auto-applied recipe as a ferret’s, until the owner edits or approves', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], autoApplyRecipe: true }));
    await w.directory.propose('VERCEL', proposal('rp_0000000000000001', 'ferret steps'));
    should((await w.directory.list())[0]?.recipeBy).equal('ferret');
    const relabelled = await w.directory.put('VERCEL', change({ label: 'Vercel (team)' }));
    should(relabelled.recipeBy).equal('ferret');
    const owned = await w.directory.put('VERCEL', change({ recipe: 'owner steps' }));
    should(owned).not.have.property('recipeBy');
  });

  it('should make an approved recipe the owner’s, and keep the mark on a decline', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], autoApplyRecipe: true }));
    await w.directory.propose('VERCEL', proposal('rp_0000000000000001', 'ferret steps'));
    await w.directory.put('VERCEL', change({ autoApplyRecipe: false }));
    await w.directory.propose('VERCEL', proposal('rp_0000000000000002', 'more', 'ferret steps'));
    await w.directory.propose('VERCEL', proposal('rp_0000000000000003', 'other', 'ferret steps'));
    const declined = await w.directory.decide('VERCEL', 'rp_0000000000000002', 'decline');
    should(declined.entry.recipeBy).equal('ferret');
    const approved = await w.directory.decide('VERCEL', 'rp_0000000000000003', 'approve');
    should(approved.entry).not.have.property('recipeBy');
    should(approved.entry.recipe).equal('other');
  });
});
