import { describe, it } from 'bun:test';
import should from 'should';
import { packageRole } from '../../src/lib/index.ts';

describe('pwa package entry', () => {
  it('should expose its workspace role', () => {
    // Act
    const actual = packageRole;

    // Assert
    should(actual).equal('pwa');
  });
});
