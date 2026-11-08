import { describe, it } from 'bun:test';
import should from 'should';
import { LoginFileSchema } from '../../../contract/index.ts';

describe('a login file budget', () => {
  it('should be accepted on a sign-in login as well as an environment one', () => {
    should(
      LoginFileSchema.safeParse({ harness: 'claude-code', store: 'ferretry', budget: { daily: { trigger: 40 } } })
        .success,
    ).be.true();
    should(
      LoginFileSchema.safeParse({ harness: 'claude-code', store: 'ferretry', budget: { daily: {} } }).success,
    ).be.false();
  });
});
