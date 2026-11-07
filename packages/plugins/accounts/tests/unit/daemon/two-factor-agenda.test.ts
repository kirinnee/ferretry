import { describe, it } from 'bun:test';
import type { AskDraft, AskId } from '@ferretry/core-asks/contract';
import { askSourceConformance, FakeAsks } from '@ferretry/core-asks/contract/testing';
import should from 'should';
import { SignInApprovalRefSchema } from '../../../contract/index.ts';
import { TwoFactorSeedAgendaAdapter } from './lib.ts';

const STAGE = `st_${'a'.repeat(24)}`;

/** An Asks port that keeps every draft it was handed, so a test reads the card as raised. */
class RecordingAsks extends FakeAsks {
  readonly drafts: AskDraft[] = [];
  override async raise(ask: AskDraft): Promise<AskId> {
    this.drafts.push(ask);
    return await super.raise(ask);
  }
}

/** The confirm-in-app card (docs/secrets.md, "2FA keys"): it saves nothing by itself. */
describe('a staged 2FA seed card on the owner’s asks', () => {
  it('S101 should carry the stage alone, under the sign-in-approval source, and close', async () => {
    // Arrange
    const asks = new RecordingAsks();
    const adapter = new TwoFactorSeedAgendaAdapter(asks);

    // Act
    const id = await adapter.raise('s1', {
      stage: STAGE,
      subject: 'Save automatic codes to your account on github.com?',
      why: 'Asked by `fy` on kirin-box at 14:02 UTC.',
      context: '- Password and code both come from this machine then.',
      expiresAt: '2026-10-31T12:02:00.000Z',
    });
    const again = await adapter.raise('s1', {
      stage: STAGE,
      subject: 'Save automatic codes to your account on github.com?',
      why: 'Asked again.',
      context: '-',
      expiresAt: '2026-10-31T12:02:00.000Z',
    });
    await adapter.close('s1', id, 'Saved');

    // Assert
    const [draft] = asks.drafts;
    should(draft?.source).equal('sign-in-approval');
    // The stage alone (secrev-1329a M2): an account's handle is often its label and username, and any ferret or
    // device reading the asks would read it.
    should(draft?.ref).eql({ kind: 'two-factor-seed', stage: STAGE });
    should(SignInApprovalRefSchema.safeParse(draft?.ref).success).be.true();
    should(JSON.stringify(draft)).not.containEql('GITHUB');
    should(draft).match({ kind: 'permission', raisedBy: { kind: 'daemon' }, ferret: 's1' });
    should(again).equal(id);
    should((await asks.get(id))?.state).equal('closed');
  });

  it('should close nothing for an id that is not an ask', async () => {
    const asks = new RecordingAsks();
    await new TwoFactorSeedAgendaAdapter(asks).close('s1', 'not-an-ask' as AskId, 'Saved');
    should(await asks.open({})).eql([]);
  });
});

askSourceConformance(
  'sign-in-approval',
  { schema: SignInApprovalRefSchema, title: 'Sign-in approval', form: false },
  {
    valid: [
      { kind: 'two-factor-seed', stage: STAGE },
      { kind: 'task-plan', planId: 'a'.repeat(32) },
      { kind: 'phone-approval', id: `pa_${'1'.repeat(24)}` },
    ],
    invalid: [
      { kind: 'two-factor-seed', stage: 'st_x' },
      { kind: 'two-factor-seed', account: 'GITHUB' },
      { kind: 'x' },
    ],
  },
);
