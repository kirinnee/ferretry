import { describe, it } from 'bun:test';
import { AgendaItemSchema } from '@ferretry/protocol';
import should from 'should';
import { type AgendaLedger, type AgendaLedgerRepository, AgendaService } from '../../../src/lib/agenda/index.ts';
import { parseAgendaLedger } from '../../../src/lib/agenda/state-machine.ts';
import { TwoFactorSeedAgendaAdapter } from '../../../src/lib/secrets/index.ts';

const STAGE = `st_${'a'.repeat(24)}`;

/** The confirm-in-app card on the real agenda (docs/secrets.md, "2FA keys"): it saves nothing by itself. */
describe('a staged 2FA seed card on the real agenda', () => {
  it('should carry the stage, refuse a generic answer, survive the ledger round-trip, and close', async () => {
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
      { now: () => '2026-10-31T12:00:00Z' },
      { has: async sessionId => sessionId === 's1' },
      { raised: async () => undefined },
    );
    const adapter = new TwoFactorSeedAgendaAdapter(agenda);

    // Act
    const id = await adapter.raise('s1', {
      stage: STAGE,
      account: 'GITHUB',
      subject: 'Save automatic codes to your account on github.com?',
      why: 'Asked by `fy` on kirin-box at 14:02 UTC.',
      context: '- Password and code both come from this machine then.',
      expiresAt: '2026-10-31T12:02:00.000Z',
    });
    const answered = await agenda.answer('s1', id, { kind: 'permission', decision: 'approved' } as never, {
      kind: 'human',
    });
    const parsed = parseAgendaLedger(JSON.parse(JSON.stringify(ledgers.get('s1'))), 's1');
    await adapter.close('s1', id, 'Saved');

    // Assert
    should(answered).match({ ok: false, error: { code: 'use_input_form' } });
    const item = parsed?.entries[0]?.item;
    should(item?.twoFactorSeed).eql({ stage: STAGE, account: 'GITHUB' });
    should(item).match({ kind: 'permission', raisedBy: 'daemon', title: 'Save automatic codes?' });
    should(AgendaItemSchema.safeParse(item).success).be.true();
    should(ledgers.get('s1')?.entries[0]?.lifecycle).not.equal('active');
  });
});
