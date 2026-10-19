import { describe, it } from 'bun:test';
import should from 'should';
import { mcpInitializeInstructions } from '../../../src/lib/mcp/instructions';

describe('mcpInitializeInstructions', () => {
  it('should carry only the skill when this ferret is neither learning nor using hypermedia', () => {
    should(mcpInitializeInstructions({ skill: '# Set up Ferretry' })).equal('# Set up Ferretry');
  });

  it('should append the lessons teaching after the skill when passive learning is on', () => {
    should(
      mcpInitializeInstructions({ skill: '# Set up Ferretry', lessons: 'Lessons: file one with lesson suggest.' }),
    ).equal('# Set up Ferretry\n\nLessons: file one with lesson suggest.');
  });

  it('should put the hypermedia teaching before the skill so a long skill cannot push it out', () => {
    should(
      mcpInitializeInstructions({
        skill: '# Set up Ferretry',
        lessons: 'Lessons: file one.',
        hypermedia: 'Hypermedia: show it.',
      }),
    ).equal('Hypermedia: show it.\n\n# Set up Ferretry\n\nLessons: file one.');
  });
});
