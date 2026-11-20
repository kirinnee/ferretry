/** The fake plugin's pages through `stepHarness`: what a plugin unit does to test its own page without the setup flow. */
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, type Mounted, mount } from '@ferretry/app/testing';
import { stepHarness } from '../../../contract/testing/index.ts';
import { ChoosePage, FinishPage, LookPage, WelcomePage } from '../../fixtures/fake-steps/pages.tsx';

ensureDom();

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

describe('StepHarness with the fake plugin pages', () => {
  it('a page that shows calls ready, once, and nothing else', async () => {
    const harness = stepHarness();
    view = await mount(<WelcomePage step={harness.host} />);
    expect(harness.decision).toBe('shown');
    expect(harness.calls).toEqual([{ kind: 'ready' }]);
  });

  it('the conditional page skips as not-needed when an earlier answer says everything, and draws nothing', async () => {
    const harness = stepHarness({ segment: { mode: 'everything' } });
    view = await mount(<ChoosePage step={harness.host} />);
    expect(harness.decision).toBe('skipped');
    expect(harness.skippedWhy).toBe('not-needed');
    expect(view.container.textContent).toBe('');
  });

  it('the conditional page shows otherwise, and done is recorded when the person answers', async () => {
    const harness = stepHarness({ segment: { mode: 'choose' } });
    view = await mount(<ChoosePage step={harness.host} />);
    expect(harness.decision).toBe('shown');
    await interact(() => view?.container.querySelector('button')?.click());
    expect(harness.count('done')).toBe(1);
  });

  it('a choice on one page is the segment memory the next page reads', async () => {
    const harness = stepHarness();
    view = await mount(<WelcomePage step={harness.host} />);
    await interact(() => view?.container.querySelectorAll('button')[0]?.click());
    expect(harness.segment).toEqual({ mode: 'everything' });
    await view.render(<ChoosePage step={harness.host} />);
    expect(harness.skippedWhy).toBe('not-needed');
  });

  it('a page can advance itself, and a client page answers through done', async () => {
    const harness = stepHarness({ phase: 'client' });
    view = await mount(<LookPage step={harness.host} />);
    expect(harness.host.phase).toBe('client');
    await interact(() => view?.container.querySelector('button')?.click());
    expect(harness.count('done')).toBe(1);
    const welcome = stepHarness();
    await view.render(<WelcomePage step={welcome.host} />);
    await interact(() => view?.container.querySelectorAll('button')[2]?.click());
    expect(welcome.count('next')).toBe(1);
  });

  it('busy and ready are told in order', async () => {
    const harness = stepHarness();
    view = await mount(<FinishPage step={harness.host} />);
    harness.host.busy('Importing…');
    harness.host.busy(null);
    expect(harness.calls.map(call => call.kind)).toEqual(['ready', 'busy', 'busy']);
    expect(harness.decision).toBe('shown');
  });

  it('a page that has said nothing is undecided: the shell keeps its loading cover', () => {
    expect(stepHarness().decision).toBe('undecided');
  });

  it('a page that registers a save is recorded, and runCommit runs what Next would run (rule 8)', async () => {
    const harness = stepHarness();
    const saved: string[] = [];
    expect(harness.hasCommit).toBe(false);
    await harness.runCommit();
    harness.host.commit(async () => void saved.push('saved'));
    expect(harness.calls).toEqual([{ kind: 'commit' }]);
    expect(harness.hasCommit).toBe(true);
    await harness.runCommit();
    expect(saved).toEqual(['saved']);
    harness.host.commit(null);
    expect(harness.hasCommit).toBe(false);
  });
});
