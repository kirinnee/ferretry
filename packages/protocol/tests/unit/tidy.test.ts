import { describe, it } from 'bun:test';
import should from 'should';
import { TIDY_PLAN_PATH, TidyPlanSchema } from '../../src/lib/tidy.ts';

const PLAN = {
  v: 1,
  sessionId: 'me',
  subFerret: false,
  drop: [{ id: 'F1', title: 'Track it', why: 'nobody asked' }],
  close: [{ id: 'A1', subject: 'Please test', code: 'status-only', why: 'status' }],
  keep: [
    { kind: 'task', id: 'F2', title: 'Owner asked', code: 'owner-asked', why: 'owner' },
    { kind: 'agenda', id: 'A2', title: 'A question', code: 'needs-owner', why: 'asks' },
  ],
};

describe('the tidy plan contract', () => {
  it('should name the plan route', () => {
    should(TIDY_PLAN_PATH).equal('/v1/tidy/plan');
  });

  it('should read a plan with cards, items and kept work', () => {
    should(TidyPlanSchema.parse(PLAN)).deepEqual(PLAN);
  });

  it('should refuse a plan that carries a field it does not know, or a kept item with the wrong code', () => {
    should(TidyPlanSchema.safeParse({ ...PLAN, extra: 1 }).success).be.false();
    should(
      TidyPlanSchema.safeParse({ ...PLAN, keep: [{ kind: 'task', id: 'F2', title: 't', code: 'gate', why: 'w' }] })
        .success,
    ).be.false();
  });
});
