import { describe, it } from 'bun:test';
import should from 'should';
import { isAncestorOf, type SubFerretDirectory } from '../../../../daemon/lib/sub-ferret/index.ts';
import { DIRECTORY } from './support.ts';

describe('isAncestorOf', () => {
  it('should not follow a cycle forever', async () => {
    // Arrange
    const loop: SubFerretDirectory = {
      leadOf: async sessionId => (sessionId === 'a' ? 'b' : 'a'),
      addressOf: async sessionId => sessionId,
    };

    // Act
    const found = await isAncestorOf(loop, 'z', 'a');

    // Assert
    should(found).be.false();
  });

  it('should stop at a chain deeper than it follows', async () => {
    // Arrange
    const deep: SubFerretDirectory = {
      leadOf: async sessionId => `${sessionId}x`,
      addressOf: async sessionId => sessionId,
    };

    // Act
    const found = await isAncestorOf(deep, 'never', 'a');

    // Assert
    should(found).be.false();
  });

  it('should not count a session as its own ancestor', async () => {
    // Act
    const found = await isAncestorOf(DIRECTORY, 'child', 'child');

    // Assert
    should(found).be.false();
  });
});
