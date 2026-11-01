import { describe, it } from 'bun:test';
import should from 'should';
import { settleUnrevivedRelaunch } from '../../../../src/lib/session/resume/index.ts';

describe('settling a migration whose relaunch did not come up', () => {
  it('should put the record back when the old harness is still serving', async () => {
    // Arrange
    let rolledBack = 0;

    // Act
    const detail = await settleUnrevivedRelaunch({
      disposition: 'preserved',
      from: 'claude-a',
      rollBack: async () => {
        rolledBack += 1;
      },
    });

    // Assert
    should(rolledBack).equal(1);
    should(detail).equal(
      'the relaunch failed and the previous harness was still at a prompt, so claude-a is still serving ' +
        'this session and its record names claude-a again',
    );
  });

  it('should leave the record for the retry that is already scheduled', async () => {
    // Arrange
    let rolledBack = 0;
    const rollBack = async () => {
      rolledBack += 1;
    };

    // Act
    const retry = await settleUnrevivedRelaunch({ disposition: 'retry-scheduled', from: 'claude-a', rollBack });
    const sent = await settleUnrevivedRelaunch({ disposition: 'sent', from: 'claude-a', rollBack });

    // Assert
    should(rolledBack).equal(0);
    should(retry).equal('the relaunch failed and an automatic retry was scheduled; the session is still on claude-a');
    should(sent).equal(retry);
  });
});
