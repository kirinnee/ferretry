import { describe, it } from 'bun:test';
import should from 'should';
import { renderEnhancement } from '../../../src/lib/stt/render';
import { enhancement } from './fixtures';

describe('enhancement rendering', () => {
  it('should report the enhancement provider alongside the cleaned text', () => {
    // Act
    const lines = renderEnhancement(enhancement()).split('\n');

    // Assert
    should(lines[0]).equal('Never install at the repository root.');
    should(lines[1]).equal('— groq/llama-3.3-70b in 320ms');
  });
});
