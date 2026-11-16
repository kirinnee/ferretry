import { describe, expect, it } from 'bun:test';
import { testSteps } from '../../../app/lib/test-steps.ts';

describe('testSteps', () => {
  it('is null when the text is not a list at all', () => {
    expect(testSteps('Just try it out and see.')).toBeNull();
    expect(testSteps('')).toBeNull();
  });

  it('cuts a numbered list into steps, keeping the number it starts at', () => {
    expect(testSteps('4. Open it\n5. Click it')).toEqual({
      lead: null,
      blocks: [
        {
          kind: 'steps',
          steps: [
            { n: 4, text: 'Open it' },
            { n: 5, text: 'Click it' },
          ],
        },
      ],
    });
  });

  it('counts bullets on from the step before and takes the text before the list as its lead', () => {
    expect(testSteps('On the Mac, v4.157:\n- first\n- second\n1) third')).toEqual({
      lead: 'On the Mac, v4.157:',
      blocks: [
        {
          kind: 'steps',
          steps: [
            { n: 1, text: 'first' },
            { n: 2, text: 'second' },
            { n: 3, text: 'third' },
          ],
        },
      ],
    });
  });

  it('keeps a step’s continuation lines, dedented, and a fenced block whole', () => {
    const got = testSteps('1. Run:\n   ```sh\n   fy up\n\n   - not a step\n   ```\n2. Done');
    expect(got?.blocks).toEqual([
      {
        kind: 'steps',
        steps: [
          { n: 1, text: 'Run:\n```sh\nfy up\n\n- not a step\n```' },
          { n: 2, text: 'Done' },
        ],
      },
    ]);
  });

  it('keeps a lead’s own fence open until it closes', () => {
    const got = testSteps('```\n1. inside the fence\n```\n1. real step');
    expect(got?.lead).toBe('```\n1. inside the fence\n```');
    expect(got?.blocks).toEqual([{ kind: 'steps', steps: [{ n: 1, text: 'real step' }] }]);
  });

  it('turns a heading or a paragraph set apart by a blank line into a section label between runs', () => {
    const got = testSteps('1. one\n2. two\n\nThen on the phone:\n1. three\n\n## Cleanup\n- four\nmore four');
    expect(got?.blocks).toEqual([
      {
        kind: 'steps',
        steps: [
          { n: 1, text: 'one' },
          { n: 2, text: 'two' },
        ],
      },
      { kind: 'section', text: 'Then on the phone:' },
      { kind: 'steps', steps: [{ n: 1, text: 'three' }] },
      { kind: 'section', text: '## Cleanup' },
      { kind: 'steps', steps: [{ n: 2, text: 'four\nmore four' }] },
    ]);
  });

  it('adds a further line under a section label to the label, and a heading right after a step starts a section', () => {
    const got = testSteps('1. one\n# Heading\nunder it\n2. two');
    expect(got?.blocks).toEqual([
      { kind: 'steps', steps: [{ n: 1, text: 'one' }] },
      { kind: 'section', text: '# Heading\nunder it' },
      { kind: 'steps', steps: [{ n: 2, text: 'two' }] },
    ]);
  });
});
