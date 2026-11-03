import { describe, it } from 'bun:test';
import { AgendaItemSchema } from '@ferretry/protocol';
import should from 'should';
import { type AgendaLedger, type AgendaLedgerRepository, AgendaService } from '../../../src/lib/agenda/index.ts';
import { parseAgendaLedger } from '../../../src/lib/agenda/state-machine.ts';
import { RecipeAgendaAdapter } from '../../../src/lib/secrets/index.ts';

const REF = { signIn: 'si_0000000000000001', id: 'rp_0000000000000001' } as const;

/** A suggested recipe's card on the real agenda (#F640): approved on the card through the recipe route, never an answer. */
describe('a recipe proposal card on the real agenda', () => {
  it('should carry its ref, refuse a generic answer, survive the ledger round-trip, and close', async () => {
    // Arrange
    const ledgers = new Map<string, AgendaLedger>();
    const repository: AgendaLedgerRepository = {
      read: async sessionId => ledgers.get(sessionId) ?? null,
      transact: async (sessionId, apply) => {
        const mutation = apply(ledgers.get(sessionId) ?? null);
        if (mutation.ok && mutation.changed) ledgers.set(sessionId, mutation.ledger);
        return mutation;
      },
    };
    const agenda = new AgendaService(
      repository,
      { now: () => '2026-11-03T12:00:00Z' },
      { has: async sessionId => sessionId === 's1' },
      { raised: async () => undefined },
    );
    const adapter = new RecipeAgendaAdapter(agenda);

    // Act
    const raised = await adapter.raise('s1', {
      sourceRef: REF.id,
      subject: 'Recipe change on github.com',
      context: '+ Wait for the 2FA page\n\nThe ferret says: it asks for a code now',
      howToResolve: 'Approve, edit or decline it on this card.',
      recipeProposal: REF,
    });
    if (!raised.ok) throw new Error(raised.message);
    const id = raised.id as never;
    const answered = await agenda.answer('s1', id, { kind: 'task', done: true } as never, { kind: 'human' });
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(ledgers.get('s1'))), 's1');
    await adapter.close('s1', id, 'Declined.');

    // Assert
    should(answered).match({ ok: false, error: { code: 'use_input_form' } });
    const item = parsed?.entries[0]?.item;
    should(item?.recipeProposal).eql(REF);
    should(item).match({ kind: 'task', raisedBy: 'daemon' });
    should(AgendaItemSchema.safeParse(item).success).be.true();
    should(ledgers.get('s1')?.entries[0]?.lifecycle).not.equal('active');
  });

  it('should only ever ride on a task card', () => {
    const base = {
      id: 'A1',
      source: 'question',
      sourceRef: REF.id,
      subject: 'Recipe change on github.com',
      why: 'Recipe change on github.com',
      howToResolve: 'Approve it.',
      waitingSince: '2026-11-03T12:00:00.000Z',
      raisedBy: 'daemon',
      raisedBySession: null,
      raisedByName: null,
      recipeProposal: REF,
    };
    should(AgendaItemSchema.safeParse({ ...base, kind: 'task' }).success).be.true();
    should(AgendaItemSchema.safeParse({ ...base, kind: 'info' }).success).be.false();
  });
});
