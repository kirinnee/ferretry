import { describe, it } from 'bun:test';
import should from 'should';
import { stepUpStages } from '../../../daemon/lib/step-up-stages.ts';

/**
 * WHAT ACCESS ASKS FOR A STAGED ACT'S CHALLENGE (G83, G84): each act's provider reads only its own stage store, with
 * exactly the arguments today's step-up options route passed, so a stage another act owns is never stamped.
 */

function rig() {
  const asked: unknown[][] = [];
  const stages = stepUpStages({
    plans: { boundSubjectOf: stage => (asked.push(['plan', stage]), stage === 'tps_1' ? 'plan-subject' : undefined) },
    pasteRules: {
      boundSubjectOf: (stage, kind, device) => (
        asked.push(['paste', stage, kind, device]), stage === 'prs_1' && device === 'd1' ? `paste-${kind}` : undefined
      ),
    },
    rules: {
      challengeOf: (stage, device) => (
        asked.push(['rule', stage, device]),
        stage === 'srs_1' && device === 'd1' ? new Uint8Array([1, 2, 3]) : undefined
      ),
    },
  });
  return { asked, stages };
}

describe('step-up.stages providers', () => {
  it('G84 should bind an approve-task-plan challenge to the one waiting stage, and nothing else', () => {
    const { asked, stages } = rig();
    should(stages['approve-task-plan'].subjectOf?.('tps_1', 'd1')).equal('plan-subject');
    should(stages['approve-task-plan'].subjectOf?.('tps_2', 'd1')).be.undefined();
    should(asked).eql([
      ['plan', 'tps_1'],
      ['plan', 'tps_2'],
    ]);
  });

  it('G84 should answer an approve-paste-rule stage only to the device it waits on, for its own kind', () => {
    const { asked, stages } = rig();
    should(stages['approve-paste-rule'].subjectOf?.('prs_1', 'd1')).equal('paste-rule');
    should(stages['approve-paste-rule'].subjectOf?.('prs_1', 'd1', 'profile-targets')).equal('paste-profile-targets');
    should(stages['approve-paste-rule'].subjectOf?.('prs_1', 'd2')).be.undefined();
    should(asked[0]).eql(['paste', 'prs_1', 'rule', 'd1']);
  });

  it('G84 S107 should hand an approve-sign-in-rule challenge derived from the stage only to its bound device', () => {
    const { stages } = rig();
    should([...(stages['approve-sign-in-rule'].challengeOf?.('srs_1', 'd1') ?? [])]).eql([1, 2, 3]);
    should(stages['approve-sign-in-rule'].challengeOf?.('srs_1', 'd2')).be.undefined();
    should(stages['approve-sign-in-rule'].subjectOf).be.undefined();
  });

  it('G83 should provide exactly the three acts Accounts stages', () => {
    should(Object.keys(rig().stages).sort()).eql(['approve-paste-rule', 'approve-sign-in-rule', 'approve-task-plan']);
  });
});

describe('G83 S90 Accounts takes and provides every step-up stage Access offers', () => {
  it('G83 should take step-up.stages for all four staged acts, and nothing else of that hook', async () => {
    const { default: manifest } = await import('../../../manifest.ts');
    const keys = manifest.hooks.takes.filter(take => take.hook.name === 'step-up.stages').map(take => take.key);
    should([...keys].sort()).eql(['add-2fa-key', 'approve-paste-rule', 'approve-sign-in-rule', 'approve-task-plan']);
  });

  it('S90 should answer an add-2fa-key subject only for a waiting stage, and nothing without a seed store', async () => {
    const { addTwoFactorKeyStage } = await import('../../../daemon/index.ts');
    const seeds = { boundSubjectOf: (stage: string) => (stage === 'st_waiting' ? 'bound-digest' : undefined) };
    should(addTwoFactorKeyStage(seeds as never).subjectOf?.('st_waiting', 'd1')).equal('bound-digest');
    should(addTwoFactorKeyStage(seeds as never).subjectOf?.('st_other', 'd1')).be.undefined();
    should(addTwoFactorKeyStage(undefined).subjectOf?.('st_waiting', 'd1')).be.undefined();
  });
});
