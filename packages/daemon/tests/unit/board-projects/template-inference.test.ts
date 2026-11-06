import { describe, it } from 'bun:test';
import should from 'should';
import { inferLaneTemplate } from '../../../src/lib/board-projects/index.ts';

describe('inferLaneTemplate', () => {
  it('should give a repository with v* tags the release-and-verify lanes', () => {
    // Act
    const template = inferLaneTemplate({ hasRepository: true, hasReleaseTags: true });

    // Assert
    should(template).equal('pr-release-verify');
  });

  it('should give a repository without release tags the pull-request lanes', () => {
    // Act
    const template = inferLaneTemplate({ hasRepository: true, hasReleaseTags: false });

    // Assert
    should(template).equal('pr');
  });

  it('should give a folder with no repository the quick lanes, whatever else is said', () => {
    // Act
    const template = inferLaneTemplate({ hasRepository: false, hasReleaseTags: true });

    // Assert
    should(template).equal('quick');
  });
});
