/**
 * Paste rules waiting for their bound passkey (owner decision !A244): a stage allows nothing, lives one challenge's
 * life, is bound to its own bytes, and is answered only by a paired device or the machine that made it.
 */
import { describe, it } from 'bun:test';
import {
  canonicalPasteRule,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASTE_RULE_STAGES_MAX,
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleStageId,
  pasteRuleApprovalSubject,
} from '@ferretry/protocol';
import should from 'should';
import {
  type PasteRuleCaller,
  PasteRuleProofMissing,
  PasteRuleStageGone,
  PasteRuleStages,
} from '../../../src/lib/index.ts';

const HOST: PasteRuleCaller = { kind: 'owner', actor: { kind: 'host' } };
const PHONE: PasteRuleCaller = { kind: 'owner', actor: { kind: 'device', deviceId: 'd1' } };
const LAPTOP: PasteRuleCaller = { kind: 'owner', actor: { kind: 'device', deviceId: 'd2' } };
const RULE: PasteRuleCreate = { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' } };

function world() {
  const clock = { at: Date.parse('2026-11-02T09:00:00.000Z'), now: () => clock.at };
  const made: PasteRuleCreate[] = [];
  let count = 0;
  const stages = new PasteRuleStages({
    rules: {
      create: async (_caller, request) => {
        made.push(request);
        return { id: 'a'.repeat(32), ...request, used: 0, createdAt: '', createdBy: { kind: 'host' } } as PasteRule;
      },
    },
    clock,
    stageId: () => `prs_${(++count).toString(16).padStart(24, '0')}` as PasteRuleStageId,
  });
  return { clock, made, stages };
}

describe('PasteRuleStages', () => {
  it('should bind a stage to its own bytes, and make the rule only with that claim', async () => {
    const { stages, made } = world();
    const staged = stages.stage(PHONE, RULE);
    const subject = pasteRuleApprovalSubject(staged.stage, canonicalPasteRule(RULE));
    const asked: string[] = [];

    await should(
      stages.commit(PHONE, staged.stage, claimed => {
        asked.push(claimed);
        return false;
      }),
    ).be.rejectedWith(PasteRuleProofMissing);
    should(made).eql([]);
    should(stages.boundSubjectOf(staged.stage)).equal(subject);

    await stages.commit(PHONE, staged.stage, claimed => claimed === subject);

    should(asked).eql([subject]);
    should(made).eql([RULE]);
    should(stages.boundSubjectOf(staged.stage)).be.undefined();
    should(stages.view(PHONE, staged.stage)).match({ state: 'approved', rule: 'a'.repeat(32) });
  });

  it('should time a stage out after one passkey challenge, and then commit nothing', async () => {
    const { stages, clock, made } = world();
    const staged = stages.stage(HOST, RULE);

    clock.at += PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;

    should(stages.boundSubjectOf(staged.stage)).be.undefined();
    should(stages.view(HOST, staged.stage).state).equal('expired');
    await should(stages.commit(PHONE, staged.stage, () => true)).be.rejectedWith(PasteRuleStageGone);
    should(made).eql([]);
  });

  it('should let any paired device answer a stage, and the machine only its own', () => {
    const { stages } = world();
    const atMachine = stages.stage(HOST, RULE);
    const fromPhone = stages.stage(PHONE, { ...RULE, count: 1 });

    should(stages.waiting(LAPTOP).map(staged => staged.stage)).eql([atMachine.stage, fromPhone.stage]);
    should(stages.waiting(HOST).map(staged => staged.stage)).eql([atMachine.stage]);
    should(() => stages.drop(HOST, fromPhone.stage)).throw(PasteRuleStageGone);
    stages.drop(LAPTOP, atMachine.stage);
    should(stages.view(HOST, atMachine.stage).state).equal('denied');
  });

  it('should refuse an agent, and keep at most the cap waiting by dropping the oldest', () => {
    const { stages } = world();
    should(() => stages.stage({ kind: 'agent' }, RULE)).throw(PasteRuleStageGone);

    const all = Array.from({ length: PASTE_RULE_STAGES_MAX + 2 }, () => stages.stage(PHONE, RULE).stage);

    should(stages.waiting(PHONE).map(staged => staged.stage)).eql(all.slice(2));
    should(stages.boundSubjectOf(all[0] as PasteRuleStageId)).be.undefined();
  });
});
