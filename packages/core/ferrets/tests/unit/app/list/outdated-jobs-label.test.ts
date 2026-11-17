import { describe, expect, it } from 'bun:test';
import { outdatedLabel } from '../../../../app/features/restart-outdated/outdated-model.ts';
import { summary } from './support.ts';

/** F4316: a ferret launched before the job keeper section existed is marked outdated, and the mark names it in plain words. */
describe('the outdated mark for the jobs section', () => {
  it('names the section "background jobs"', () => {
    expect(outdatedLabel(summary('a', { name: 'a', outdated: { sections: ['jobs'] } }))).toBe(
      'Outdated — restart to load new instructions (background jobs)',
    );
  });

  it('joins it with another changed section', () => {
    expect(outdatedLabel(summary('a', { name: 'a', outdated: { sections: ['jobs', 'board'] } }))).toBe(
      'Outdated — restart to load new instructions (background jobs and board rules)',
    );
  });
});
