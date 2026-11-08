import { describe, it } from 'bun:test';
import should from 'should';
import { planStartupEffort, startupModelArguments } from '../../../daemon/lib/harness/startup.ts';

describe('startupModelArguments', () => {
  it('puts the resolved model on the argv as --model', () => {
    should(startupModelArguments('claude-opus-5-5')).deepEqual(['--model', 'claude-opus-5-5']);
  });
});

describe('planStartupEffort', () => {
  it('plans nothing when no level was asked for, blank included', () => {
    should(planStartupEffort(undefined)).deepEqual({ kind: 'planned' });
    should(planStartupEffort('   ')).deepEqual({ kind: 'planned' });
  });

  it('carries a level as an effort command typed before turn one, normalised', () => {
    should(planStartupEffort(' High ')).deepEqual({
      kind: 'planned',
      startupRuntime: { action: 'effort', effort: 'high' },
    });
  });

  it('refuses a level that is not a level instead of dropping it', () => {
    should(planStartupEffort('x_high')).deepEqual({
      kind: 'refused',
      cause: 'invalid',
      reason: 'x_high is not a reasoning level',
    });
    should(planStartupEffort('9').kind).equal('refused');
  });
});
