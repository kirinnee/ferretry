/**
 * The track is a rail now rather than four boxes, and shrinking it must not have
 * cost it any of the three things it was doing: saying where you are, saying
 * where you have been, and taking you back there.
 *
 * The state assertions are deliberately about SHAPE and TEXT rather than tone. A
 * reader who cannot separate the accent from the border still has to be able to
 * tell a finished step from one they have not reached — hence the tick, the
 * dashed marker and the spelled-out status on every item.
 */

import { describe, expect, it } from 'bun:test';

import { OnboardingTrack } from '../../../src/features/onboarding/onboarding-track.tsx';
import type { OnboardingPath } from '../../../src/features/onboarding/onboarding-model.ts';
import { interact, mount, must } from '../../support/dom.ts';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

/** The longest journey there is: a daemon standing up here, installed by hand. */
const DESKTOP: OnboardingPath = { route: 'first-time', target: 'this', doer: 'self', device: 'desktop' };

describe('the step track', () => {
  it('is a real ordered list with one current step', async () => {
    const view = await mount(<OnboardingTrack path={DESKTOP} current="daemon" furthest="daemon" onJump={() => {}} />);
    const list = must(view.container.querySelector('ol'), 'the track');

    expect(list.getAttribute('aria-label')).toBe('Setup steps');
    expect(list.querySelectorAll('li')).toHaveLength(7);
    expect(must(list.querySelector('[aria-current="step"]'), 'the current step').textContent).toContain('Daemon');
    await view.unmount();
  });

  it('spells every state out for a reader who hears the list', async () => {
    const view = await mount(<OnboardingTrack path={DESKTOP} current="daemon" furthest="local" onJump={() => {}} />);
    const text = must(view.container.querySelector('ol'), 'the track').textContent ?? '';

    expect(text).toContain('current step');
    expect(text).toContain('completed, go back to it');
    expect(text).toContain('not reached yet');
    // A finished step swaps its number for a tick: state by shape, not by tone.
    expect(view.container.querySelectorAll('svg.lucide-check')).toHaveLength(4);
    // An unreached one is dashed for the same reason.
    expect(view.container.innerHTML).toContain('border-dashed');
    await view.unmount();
  });

  it('takes the reader back only to a step they have actually been to', async () => {
    const jumped: string[] = [];
    const view = await mount(
      <OnboardingTrack
        path={DESKTOP}
        current="local"
        furthest="local"
        onJump={id => {
          jumped.push(id);
        }}
      />,
    );

    // `done` is ahead of them, so it is not a control at all.
    expect(view.container.querySelectorAll('[data-onboarding-jump]')).toHaveLength(4);
    expect(view.container.querySelector('[data-onboarding-jump="done"]')).toBeNull();

    await click(must(view.container.querySelector('[data-onboarding-jump="install"]'), 'the install step'));
    expect(jumped).toEqual(['install']);
    await view.unmount();
  });
});
