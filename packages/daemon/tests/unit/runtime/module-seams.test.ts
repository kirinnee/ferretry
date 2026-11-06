import { describe, expect, it } from 'bun:test';
import { seamsOf } from '../../../bin/modules/seams.ts';

describe('seamsOf', () => {
  it('should hold only readers of the effective world, one per module', () => {
    // Arrange / Act
    const entries = Object.entries<unknown>(seamsOf);

    // Assert: empty until the first extraction adds its entry; every entry after that must be a function of the world.
    for (const [id, read] of entries) {
      expect(typeof read).toBe('function');
      expect(id).not.toBe('');
    }
  });
});
