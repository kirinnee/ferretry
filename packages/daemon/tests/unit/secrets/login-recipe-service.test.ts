import { describe, it } from 'bun:test';
import { type PutLoginEntry, PutLoginEntryRequestSchema } from '@ferretry/protocol';
import should from 'should';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import {
  cardContext,
  LoginDirectory,
  LoginRecipeService,
  RecipeAgendaAdapter,
  RecipeValueError,
} from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher, MemoryLoginIndex, MemorySecretDocuments } from '../runtime/mounts/support.ts';

const NOW = '2026-10-31T09:00:00.000Z';
const SECRET = 'hunter2-UNIQUE-pw';
const change = (input: unknown): PutLoginEntry => PutLoginEntryRequestSchema.parse(input);

function world(options: { redactorFails?: boolean } = {}) {
  const directory = new LoginDirectory(new MemoryLoginIndex(), new MemorySecretDocuments(), new FakeSecretCipher(), {
    now: () => NOW,
  });
  const cards: { sessionId: string; sourceRef: string; subject: string; context: string; howToResolve: string }[] = [];
  const closed: { sessionId: string; id: string; note: string }[] = [];
  const audits: AuditEntry[] = [];
  let next = 0;
  const service = new LoginRecipeService({
    logins: directory,
    values: {
      redact: async text => {
        if (options.redactorFails === true) throw new Error('vault locked');
        return text.replaceAll(SECRET, '[redacted:login:X:password]');
      },
    },
    agenda: {
      raise: async (sessionId, card) => {
        cards.push({ sessionId, ...card });
        return { ok: true, id: `A${String(cards.length)}` };
      },
      close: async (sessionId, id, note) => void closed.push({ sessionId, id, note }),
    },
    audit: { record: async entry => void audits.push(entry) },
    clock: { now: () => NOW },
    newId: () => `rp_${(next++).toString(16).padStart(16, '0')}`,
  });
  return { directory, service, cards, closed, audits };
}

describe('a recipe never holds a value', () => {
  it('should refuse a recipe or a reason in which the redactor finds a value', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'] }));
    await should(w.service.assertNoValue(`type ${SECRET} here`)).be.rejectedWith(RecipeValueError);
    await should(w.service.propose('s1', 'VERCEL', `type ${SECRET}`, 'it works')).be.rejectedWith(RecipeValueError);
    await should(w.service.propose('s1', 'VERCEL', 'steps', `the password is ${SECRET}`)).be.rejectedWith(
      RecipeValueError,
    );
    should((await w.directory.list())[0]).not.have.property('proposals');
    should(w.cards).deepEqual([]);
  });

  it('should refuse when the redactor cannot run', async () => {
    const w = world({ redactorFails: true });
    await should(w.service.assertNoValue('harmless steps')).be.rejectedWith(/could not check/u);
  });
});

describe('a ferret proposes', () => {
  it("should file it and raise a card with the diff and the ferret's reason, the card approving nothing", async () => {
    const w = world();
    await w.directory.put(
      'VERCEL',
      change({ label: 'Vercel', match: ['vercel.com'], recipe: 'Open vercel.com\nClick Log in' }),
    );
    const proposed = await w.service.propose(
      's1',
      'VERCEL',
      'Open vercel.com\nContinue with Google',
      'the button moved',
    );
    should(proposed).deepEqual({ id: 'rp_0000000000000000', login: 'VERCEL', state: 'pending', agendaItemId: 'A1' });
    should(w.cards).have.length(1);
    should(w.cards[0]?.subject).equal("Recipe change for 'Vercel'");
    should(w.cards[0]?.context).equal('- Click Log in\n+ Continue with Google\n\nThe ferret says: the button moved');
    should(w.cards[0]?.howToResolve).containEql('fy account recipe approve VERCEL rp_0000000000000000');
    const [entry] = await w.directory.list();
    should(entry?.recipe).equal('Open vercel.com\nClick Log in');
    should(entry?.proposals?.[0]).containDeep({ base: 'Open vercel.com\nClick Log in', agendaItemId: 'A1' });
  });

  it('should apply at once, audited, only for a login the owner allowed it on', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], autoApplyRecipe: true }));
    const proposed = await w.service.propose('s1', 'VERCEL', 'new steps', 'first sign-in');
    should(proposed.state).equal('applied');
    should(w.cards).deepEqual([]);
    should((await w.directory.list())[0]?.recipe).equal('new steps');
    should(w.audits).have.length(1);
    should(w.audits[0]).containDeep({
      event: 'secrets.changed',
      subject: 'VERCEL',
      detail: { action: 'login-recipe-auto' },
    });
  });

  it('should close the card of a proposal pushed out by a fourth', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'] }));
    for (const n of [1, 2, 3, 4]) await w.service.propose('s1', 'VERCEL', `steps ${String(n)}`, 'again');
    should(w.closed).deepEqual([{ sessionId: 's1', id: 'A1', note: 'Replaced by a newer recipe proposal.' }]);
  });
});

describe('the owner decides', () => {
  it('should apply an approval and close its card', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'] }));
    const proposed = await w.service.propose('s1', 'VERCEL', 'new steps', 'why');
    const entry = await w.service.decide('VERCEL', proposed.id, 'approve');
    should(entry.recipe).equal('new steps');
    should(w.closed).deepEqual([{ sessionId: 's1', id: 'A1', note: 'Approved: the recipe was updated.' }]);
  });

  it('should drop a declined one and close its card', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'] }));
    const proposed = await w.service.propose('s1', 'VERCEL', 'new steps', 'why');
    const entry = await w.service.decide('VERCEL', proposed.id, 'decline');
    should(entry).not.have.property('recipe');
    should(w.closed[0]?.note).equal('Declined.');
  });
});

describe('the card context', () => {
  it('should fit a card, saying how many changed lines it left out', () => {
    const next = Array.from({ length: 400 }, (_, n) => `step ${String(n)} ${'x'.repeat(20)}`).join('\n');
    const context = cardContext(undefined, next, 'long');
    should(context.length).be.belowOrEqual(2_048);
    should(context).match(/more changed line\(s\): see the whole diff in Settings/u);
    should(context.endsWith('The ferret says: long')).be.true();
  });
});

describe('a proposal’s card', () => {
  const card = {
    sourceRef: 'rp_0000000000000001',
    subject: 'Recipe change',
    context: '+ x',
    howToResolve: 'Approve it',
  };

  it('should raise a task the daemon owns, and resolve it by its id', async () => {
    const raised: unknown[] = [];
    const resolved: unknown[] = [];
    const adapter = new RecipeAgendaAdapter({
      raise: (async (...parameters: unknown[]) => {
        raised.push(parameters);
        return { ok: true, item: { id: 'A3' } };
      }) as never,
      resolve: (async (...parameters: unknown[]) => {
        resolved.push(parameters);
        return { ok: true };
      }) as never,
    });
    should(await adapter.raise('s1', card)).deepEqual({ ok: true, id: 'A3' });
    should(raised[0]).containDeep([
      's1',
      { kind: 'task', sourceRef: 'rp_0000000000000001' },
      { kind: 'daemon', cause: 'login-recipe' },
    ]);
    await adapter.close('s1', 'A3', 'Declined.');
    await adapter.close('s1', 'not an id', 'Declined.');
    should(resolved).have.length(1);
  });

  it('should say when the agenda kept no card, or refused one', async () => {
    const kept = new RecipeAgendaAdapter({
      raise: (async () => ({ ok: true })) as never,
      resolve: (async () => ({ ok: true })) as never,
    });
    should(await kept.raise('s1', card)).containDeep({ ok: false });
    const refused = new RecipeAgendaAdapter({
      raise: (async () => ({ ok: false, error: { message: 'board full' } })) as never,
      resolve: (async () => ({ ok: true })) as never,
    });
    should(await refused.raise('s1', card)).deepEqual({ ok: false, message: 'board full' });
  });

  it('should file a proposal with no card when the agenda refuses one', async () => {
    const directory = new LoginDirectory(new MemoryLoginIndex(), new MemorySecretDocuments(), new FakeSecretCipher(), {
      now: () => NOW,
    });
    await directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], recipe: 'same' }));
    const service = new LoginRecipeService({
      logins: directory,
      values: { redact: async text => text },
      agenda: { raise: async () => ({ ok: false, message: 'full' }), close: async () => undefined },
      audit: { record: async () => undefined },
      clock: { now: () => NOW },
    });
    const proposed = await service.propose('s1', 'VERCEL', 'same', 'nothing changed');
    should(proposed.state).equal('pending');
    should(proposed).not.have.property('agendaItemId');
    should(proposed.id).match(/^rp_[0-9a-f]{16}$/u);
    should(cardContext('same', 'same', 'why')).equal('No line changes.\n\nThe ferret says: why');
  });
});

describe('a recipe is masked when it is served', () => {
  it('should mask a value kept after the recipe was written, in the recipe and every proposal', async () => {
    const w = world();
    const entry = {
      id: 'VERCEL',
      label: 'Vercel',
      match: [],
      fields: { password: false, totp: false },
      recipe: `PIN ${SECRET}`,
      recipeBy: 'ferret' as const,
      proposals: [
        {
          id: 'rp_0000000000000001',
          recipe: `new ${SECRET}`,
          base: `PIN ${SECRET}`,
          why: `why ${SECRET}`,
          sessionId: 's1',
          proposedAt: NOW,
        },
        { id: 'rp_0000000000000002', recipe: 'plain', why: 'first', sessionId: 's1', proposedAt: NOW },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const [served] = await w.service.scrubbed([entry]);
    should(JSON.stringify(served)).not.containEql(SECRET);
    should(served?.recipeBy).equal('ferret');
    should(served?.proposals?.[1]).not.have.property('base');
    const bare = { ...entry, recipe: undefined, proposals: undefined };
    should(await w.service.scrubbed([bare as never])).deepEqual([bare]);
  });

  it('should drop the texts when nothing can mask them', async () => {
    const w = world({ redactorFails: true });
    const [served] = await w.service.scrubbed([
      {
        id: 'V',
        label: 'V',
        match: [],
        fields: { password: false, totp: false },
        recipe: 'steps',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    should(served).not.have.property('recipe');
  });

  it('should refuse to approve a proposal holding a value kept after it was made', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'] }));
    await w.directory.propose('VERCEL', {
      id: 'rp_00000000000000aa',
      recipe: `type ${SECRET}`,
      why: 'w',
      sessionId: 's1',
      proposedAt: NOW,
    });
    await should(w.service.decide('VERCEL', 'rp_00000000000000aa', 'approve')).be.rejectedWith(RecipeValueError);
    should((await w.service.decide('VERCEL', 'rp_00000000000000aa', 'decline')).recipe).be.undefined();
  });
});

describe('a proposal card and an answer are masked too', () => {
  it('should mask the current recipe on the card and in the approval’s answer', async () => {
    const w = world();
    await w.directory.put('VERCEL', change({ label: 'Vercel', match: ['vercel.com'], recipe: `old ${SECRET}` }));
    const proposed = await w.service.propose('s1', 'VERCEL', 'new steps', 'why');
    should(w.cards[0]?.context).not.containEql(SECRET);
    should(w.cards[0]?.context).containEql('[redacted:login:X:password]');
    const declined = await w.service.decide('VERCEL', proposed.id, 'decline');
    should(JSON.stringify(declined)).not.containEql(SECRET);
  });
});
