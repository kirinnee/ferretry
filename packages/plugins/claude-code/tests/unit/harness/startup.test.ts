import { describe, it } from 'bun:test';
import should from 'should';
import { claudeFastSupport, fastStartRefusal, withoutSelector } from '../../../daemon/lib/harness/fast-mode.ts';
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

describe('fast mode', () => {
  it('is offered on opus-4-8 and opus-5 ids, in any case, selector or not', () => {
    should(
      ['claude-opus-5-5', 'claude-opus-5', 'CLAUDE-OPUS-5-5[1m]', 'claude-opus-4-8'].map(claudeFastSupport),
    ).deepEqual([true, true, true, true]);
  });

  it('is not offered on other models', () => {
    should(['claude-opus-4-6', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(claudeFastSupport)).deepEqual([
      false,
      false,
      false,
    ]);
  });

  it('refuses a start that asks for fast mode on a model without it', () => {
    should(fastStartRefusal('claude-sonnet-5-5')).equal('claude-sonnet-5-5 has no fast mode');
    should(fastStartRefusal('claude-opus-5-5')).equal(undefined);
  });

  it('strips the context-window selector a harness drops', () => {
    should(withoutSelector('claude-opus-5-5[1m]')).equal('claude-opus-5-5');
    should(withoutSelector('claude-opus-5-5')).equal('claude-opus-5-5');
  });
});
