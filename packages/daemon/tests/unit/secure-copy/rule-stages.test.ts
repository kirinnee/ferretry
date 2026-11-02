/**
 * Changes waiting for their bound passkey (owner decision !A244, secrev-1334): a stage allows nothing, lives one
 * challenge's life, is bound to its own bytes and kind, and is answered only by the device that staged it or the one
 * that took a machine stage. Each stager's cap drops only its own oldest.
 */
import { describe, it } from 'bun:test';
import {
  canonicalPasteRule,
  canonicalProfileTargets,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASTE_RULE_STAGES_MAX,
  type PasteRule,
  type PasteRuleCreate,
  type PasteRuleSettings,
  type PasteRuleStageId,
  pasteRuleApprovalSubject,
  profileTargetsApprovalSubject,
} from '@ferretry/protocol';
import should from 'should';
import {
  type PasteRuleCaller,
  PasteRuleProofMissing,
  PasteRuleStageGone,
  PasteRuleStages,
  ProfileTargetsChanged,
} from '../../../src/lib/index.ts';

const HOST: PasteRuleCaller = { kind: 'owner', actor: { kind: 'host' } };
const PHONE: PasteRuleCaller = { kind: 'owner', actor: { kind: 'device', deviceId: 'd1' } };
const LAPTOP: PasteRuleCaller = { kind: 'owner', actor: { kind: 'device', deviceId: 'd2' } };
const RULE: PasteRuleCreate = { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' } };
const EXISTING: PasteRule = {
  id: 'a'.repeat(32),
  ...RULE,
  used: 0,
  createdAt: '2026-11-02T08:00:00.000Z',
  createdBy: { kind: 'host' },
};

function world() {
  const clock = { at: Date.parse('2026-11-02T09:00:00.000Z'), now: () => clock.at };
  const made: PasteRuleCreate[] = [];
  const settings: PasteRuleSettings[] = [];
  let count = 0;
  const stages = new PasteRuleStages({
    rules: {
      create: async (_caller, request) => {
        made.push(request);
        return { ...EXISTING, ...request };
      },
      changeSettings: async (_caller, next) => {
        settings.push(next);
        return next;
      },
    },
    clock,
    deviceName: async deviceId => (deviceId === 'd1' ? 'Kirin’s phone' : undefined),
    stageId: () => `prs_${(++count).toString(16).padStart(24, '0')}` as PasteRuleStageId,
  });
  return { clock, made, settings, stages };
}

describe('PasteRuleStages', () => {
  it('should bind a stage to its own bytes and device, and make the rule only with that claim', async () => {
    const { stages, made } = world();
    const staged = await stages.stage(PHONE, RULE);
    const subject = pasteRuleApprovalSubject(staged.stage, canonicalPasteRule(RULE));
    const asked: string[] = [];

    await should(
      stages.commit(PHONE, staged.stage, claimed => {
        asked.push(claimed);
        return false;
      }),
    ).be.rejectedWith(PasteRuleProofMissing);
    should(made).eql([]);
    should(stages.boundSubjectOf(staged.stage, 'rule', 'd1')).equal(subject);
    // Another device, and the other kind's act, get nothing for it.
    should(stages.boundSubjectOf(staged.stage, 'rule', 'd2')).be.undefined();
    should(stages.boundSubjectOf(staged.stage, 'profile-targets', 'd1')).be.undefined();
    await should(stages.commit(LAPTOP, staged.stage, () => true)).be.rejectedWith(PasteRuleStageGone);

    await stages.commit(PHONE, staged.stage, claimed => claimed === subject);

    should(asked).eql([subject]);
    should(made).eql([RULE]);
    should(stages.boundSubjectOf(staged.stage, 'rule', 'd1')).be.undefined();
    should(stages.view(PHONE, staged.stage)).match({ state: 'approved', rule: EXISTING.id });
  });

  it('should say who staged it and when, in the daemon rows', async () => {
    const { stages } = world();

    const fromPhone = await stages.stage(PHONE, RULE);
    const atMachine = await stages.stage(HOST, RULE);
    const unnamed = await stages.stage(LAPTOP, RULE);

    should(fromPhone.rows.at(-1)).eql({ label: 'Staged', value: 'On Kirin’s phone, 2026-11-02 09:00 UTC' });
    should(atMachine.rows.at(-1)).eql({ label: 'Staged', value: 'At this machine, 2026-11-02 09:00 UTC' });
    should(unnamed.rows.at(-1)?.value).equal('On a paired device (…d2), 2026-11-02 09:00 UTC');
    should(fromPhone).match({ kind: 'rule', runsAnything: false });
  });

  it('should time a stage out after one passkey challenge, and then commit nothing', async () => {
    const { stages, clock, made } = world();
    const staged = await stages.stage(PHONE, RULE);

    clock.at += PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;

    should(stages.boundSubjectOf(staged.stage, 'rule', 'd1')).be.undefined();
    should(stages.view(PHONE, staged.stage).state).equal('expired');
    await should(stages.commit(PHONE, staged.stage, () => true)).be.rejectedWith(PasteRuleStageGone);
    should(made).eql([]);

    // Its state is still answered a while, so a waiting command reads "Timed out"; then it is forgotten.
    clock.at += PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;
    should(() => stages.view(PHONE, staged.stage)).throw(PasteRuleStageGone);
  });

  it("should keep a device's stage its own, and let one device take a machine stage before it can commit it", async () => {
    const { stages } = world();
    const atMachine = await stages.stage(HOST, RULE);
    const fromPhone = await stages.stage(PHONE, { ...RULE, count: 1 });

    should(stages.waiting(LAPTOP).map(staged => staged.stage)).eql([atMachine.stage]);
    should(stages.waiting(PHONE).map(staged => staged.stage)).eql([atMachine.stage, fromPhone.stage]);
    should(stages.waiting(HOST).map(staged => staged.stage)).eql([atMachine.stage]);
    should(() => stages.drop(LAPTOP, fromPhone.stage)).throw(PasteRuleStageGone);
    should(() => stages.drop(HOST, fromPhone.stage)).throw(PasteRuleStageGone);
    // Not taken yet: nobody has its challenge, and the machine never can.
    should(stages.boundSubjectOf(atMachine.stage, 'rule', 'd2')).be.undefined();
    should(() => stages.bind(HOST, atMachine.stage)).throw(PasteRuleStageGone);

    stages.bind(LAPTOP, atMachine.stage);

    should(stages.boundSubjectOf(atMachine.stage, 'rule', 'd2')).be.a.String();
    should(stages.waiting(PHONE).map(staged => staged.stage)).eql([fromPhone.stage]);
    should(() => stages.bind(PHONE, atMachine.stage)).throw(PasteRuleStageGone);
    // The machine still reads and drops its own.
    should(stages.view(HOST, atMachine.stage).state).equal('waiting');
    stages.drop(HOST, atMachine.stage);
    should(stages.view(HOST, atMachine.stage).state).equal('denied');
  });

  it("should refuse an agent, and keep each stager's cap by dropping only its own oldest", async () => {
    const { stages } = world();
    await should(stages.stage({ kind: 'agent' }, RULE)).be.rejectedWith(PasteRuleStageGone);
    const owners = await stages.stage(HOST, RULE);

    const flood: string[] = [];
    for (let index = 0; index < PASTE_RULE_STAGES_MAX + 2; index += 1)
      flood.push((await stages.stage(PHONE, RULE)).stage);

    should(stages.waiting(PHONE).map(staged => staged.stage)).eql([owners.stage, ...flood.slice(2)]);
    should(stages.view(HOST, owners.stage).state).equal('waiting');
    should(stages.view(PHONE, flood[0] as PasteRuleStageId).state).equal('denied');
  });

  it('should turn profile targets on only with a proof bound to the rules it widens, and not once they changed', async () => {
    const { stages, settings } = world();
    const staged = await stages.stageProfileTargets(PHONE, [EXISTING]);
    const subject = profileTargetsApprovalSubject(staged.stage, canonicalProfileTargets([EXISTING.id]));

    should(staged).match({
      kind: 'profile-targets',
      rows: [{ label: 'Widens', value: 'what gh prints → vercel in a terminal' }],
    });
    should(staged.does).containEql('widens one paste rule');
    should(stages.boundSubjectOf(staged.stage, 'profile-targets', 'd1')).equal(subject);
    // A rule's commit never takes it, and a paste rule's proof domain never stands for it.
    await should(stages.commit(PHONE, staged.stage, () => true)).be.rejectedWith(PasteRuleStageGone);
    await should(
      stages.commitProfileTargets(PHONE, staged.stage, [EXISTING.id, 'b'.repeat(32)], () => true),
    ).be.rejectedWith(ProfileTargetsChanged);
    await should(stages.commitProfileTargets(PHONE, staged.stage, [EXISTING.id], () => false)).be.rejectedWith(
      PasteRuleProofMissing,
    );
    should(settings).eql([]);

    await stages.commitProfileTargets(PHONE, staged.stage, [EXISTING.id], claimed => claimed === subject);

    should(settings).eql([{ allowProfileTargets: true }]);
    should(stages.view(PHONE, staged.stage).state).equal('approved');
    should(() => stages.requestOf(PHONE, staged.stage)).throw(PasteRuleStageGone);
  });
});
