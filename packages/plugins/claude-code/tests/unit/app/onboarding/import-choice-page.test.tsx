/** The import pre-screen: three cards, a default already chosen and remembered, every pick written to the segment. */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { ImportChoicePage, importModeOf } from '../../../../app/features/onboarding/import-choice-page.tsx';
import { scripted, stepHarness } from '../../../fixtures/onboarding/harness.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

describe('the import pre-screen', () => {
  it('offers three cards, with "Import everything" chosen and already in the segment', async () => {
    const run = stepHarness();
    const view = await mount(<ImportChoicePage client={scripted({})} step={run.step} />);
    mounted.push(view);
    const cards = [...view.container.querySelectorAll('[data-choice]')];
    expect(cards.map(card => card.getAttribute('data-choice'))).toEqual(['everything', 'choose', 'fresh']);
    expect((view.container.querySelector('input[value="everything"]') as HTMLInputElement).checked).toBe(true);
    expect(importModeOf(run.step.segment)).toBe('everything');
    expect(run.events).toEqual(['remember', 'ready']);
  });

  it('is one tab stop (a native radio group), and a pick is written to the segment and counts as the answer', async () => {
    const run = stepHarness();
    const view = await mount(<ImportChoicePage client={scripted({})} step={run.step} />);
    mounted.push(view);
    const radios = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(new Set(radios.map(radio => radio.name)).size).toBe(1);
    await interact(() =>
      must(view.container.querySelector<HTMLInputElement>('input[value="choose"]'), 'choose').click(),
    );
    expect(importModeOf(run.step.segment)).toBe('choose');
    expect(run.events).toEqual(['remember', 'ready', 'remember', 'done']);
  });

  it('keeps an earlier answer when the person comes back', async () => {
    const run = stepHarness({ importMode: 'fresh' });
    const view = await mount(<ImportChoicePage client={scripted({})} step={run.step} />);
    mounted.push(view);
    expect((view.container.querySelector('input[value="fresh"]') as HTMLInputElement).checked).toBe(true);
  });
});

describe('what an import page reads from the segment (reload-resume)', () => {
  it('reads the choice made in this run', async () => {
    const run = stepHarness();
    const view = await mount(<ImportChoicePage client={scripted({})} step={run.step} />);
    mounted.push(view);
    await interact(() => must(view.container.querySelector<HTMLInputElement>('input[value="fresh"]'), 'fresh').click());
    expect(importModeOf(run.step.segment)).toBe('fresh');
  });

  it('after a reload the memory is empty: no choice, so an import page may not skip for one', () => {
    // A reload starts a new run: the shell resumes at the first unanswered step and the segment memory is empty.
    const reloaded = stepHarness();
    expect(importModeOf(reloaded.step.segment)).toBeUndefined();
    // Nothing else is mistaken for a choice.
    expect(importModeOf({ importMode: 'nonsense' })).toBeUndefined();
    expect(importModeOf({ importMode: undefined })).toBeUndefined();
    expect(importModeOf({ importMode: true })).toBeUndefined();
  });

  it('never turns a missing choice into "everything" or "fresh" on its own: only a shown pick is remembered', async () => {
    const reloaded = stepHarness();
    // The page was not shown (the shell skipped an answered step): nothing was remembered.
    expect(reloaded.events).toEqual([]);
    expect(importModeOf(reloaded.step.segment)).toBeUndefined();
  });
});
