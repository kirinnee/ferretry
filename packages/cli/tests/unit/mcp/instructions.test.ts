import { describe, it } from 'bun:test';
import should from 'should';
import { mcpInitializeInstructions } from '../../../src/lib/mcp/instructions';

describe('mcpInitializeInstructions', () => {
  it('should carry only the skill when this ferret is not instructed to learn', () => {
    should(mcpInitializeInstructions('# Set up Ferretry', false, 'Lessons: file one with lesson suggest.')).equal(
      '# Set up Ferretry',
    );
  });

  it('should append the lessons teaching after the skill when passive learning is on', () => {
    should(mcpInitializeInstructions('# Set up Ferretry', true, 'Lessons: file one with lesson suggest.')).equal(
      '# Set up Ferretry\n\nLessons: file one with lesson suggest.',
    );
  });
});
