// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { describe, it } from 'bun:test';
import should from 'should';
import { boundedRun } from '../../../src/adapters/update/install-facts';

describe('boundedRun', () => {
  it('kills a command that outlives its bound', async () => {
    // Arrange
    const started = Date.now();

    // Act
    const outcome = await boundedRun(['sleep', '5'], 100);

    // Assert
    should(outcome.code).not.equal(0);
    should(Date.now() - started).be.below(4_000);
  });
});
