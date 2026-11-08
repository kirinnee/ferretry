import { describe, it } from 'bun:test';
import should from 'should';
import { LocalSkillRefusalError, unavailable } from '../../daemon/lib/installs/ports.ts';

describe('a seam no plugin binds', () => {
  it('refuses with the target-unknown code and says what is not available yet', () => {
    // Act
    let thrown: unknown;
    try {
      unavailable('The runtime store');
    } catch (error) {
      thrown = error;
    }

    // Assert
    should(thrown).be.instanceOf(LocalSkillRefusalError);
    should((thrown as LocalSkillRefusalError).code).equal('local_skill_target_unknown');
    should((thrown as LocalSkillRefusalError).message).equal('The runtime store is not available on this machine yet.');
  });
});
