import { describe, it } from 'bun:test';
import should from 'should';
import { UNNAMED_SELF_CHECK_STAGES } from '../../../../../daemon/lib/session/health/types.ts';

describe('UNNAMED_SELF_CHECK_STAGES', () => {
  it('should run the work of a stage and hand back what it resolved', async () => {
    // Arrange
    const ran: string[] = [];

    // Act
    const result = await UNNAMED_SELF_CHECK_STAGES.run('survey', async () => {
      ran.push('survey');
      return 42;
    });

    // Assert
    should(result).equal(42);
    should(ran).eql(['survey']);
  });

  it('should let a failing stage reject as it is', async () => {
    // Arrange
    const failure = new Error('the survey failed');

    // Act
    const outcome = UNNAMED_SELF_CHECK_STAGES.run('survey', async () => {
      throw failure;
    });

    // Assert
    await should(outcome).be.rejectedWith(failure);
  });

  it('should be frozen, so no caller can swap how stages run', () => {
    // Act / Assert
    should(Object.isFrozen(UNNAMED_SELF_CHECK_STAGES)).be.true();
  });
});
