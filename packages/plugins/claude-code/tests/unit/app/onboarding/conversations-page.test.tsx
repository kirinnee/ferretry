/** The conversations page: no choice. One sentence, a generic demo, nothing asked and nothing written. */
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { ConversationsPage, ONE_WAY } from '../../../../app/features/onboarding/import/conversations-page.tsx';
import { type Call, scripted, stepHarness } from '../../../fixtures/onboarding/harness.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});
const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const open = async (calls: Call[] = []) => {
  const run = stepHarness();
  const view = await mount(<ConversationsPage client={scripted({}, calls)} step={run.step} />);
  mounted.push(view);
  await settle();
  return { view, run, calls };
};

describe('the conversations page', () => {
  it('says it in one sentence and offers no choice, no button and no radio', async () => {
    const { view } = await open();
    expect(view.container.querySelector('[data-conversations-one-way]')?.textContent).toBe(ONE_WAY);
    expect(ONE_WAY.match(/[.!?]/gu)?.length).toBe(1);
    expect(view.container.querySelector('input[type="radio"]')).toBeNull();
    expect(view.container.querySelector('button')).toBeNull();
    expect(view.container.textContent).not.toContain('Show them here');
    expect(view.container.textContent).not.toContain('Don’t show them');
  });

  it('is ready at once and asks and writes nothing', async () => {
    const { run, calls } = await open();
    expect(run.events).toEqual(['ready']);
    expect(run.hasCommit).toBe(false);
    expect(calls).toEqual([]);
  });

  it('its demo is generic words, never a made-up conversation that reads as found', async () => {
    const { view } = await open();
    const demo = must(view.container.querySelector('[data-demo="conversations"]'), 'demo');
    expect(demo.textContent).toContain('An example, not your conversations');
    for (const invented of ['Fix the login bug', 'Plan the release', '3 conversations']) {
      expect(view.container.textContent).not.toContain(invented);
    }
  });
});
