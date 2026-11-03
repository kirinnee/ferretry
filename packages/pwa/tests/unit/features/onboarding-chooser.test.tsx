/**
 * The first screen asks one thing: what does the reader have? Two cards answer it,
 * and the rarer third answer is a small link rather than a third equal card.
 */

import { describe, expect, it } from 'bun:test';

import { OnboardingChooser } from '../../../src/features/onboarding/onboarding-chooser.tsx';
import type { OnboardingRouteId } from '../../../src/features/onboarding/onboarding-model.ts';
import { interact, mount, must } from '../../support/dom.ts';

const click = async (target: Element): Promise<void> => {
  await interact(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('the onboarding chooser', () => {
  it('shows two cards and a small add-daemon link, all routable', async () => {
    const view = await mount(<OnboardingChooser onChoose={() => {}} />);

    expect(view.container.querySelector('h2')?.textContent).toBe('Welcome');
    expect(view.container.textContent).toContain('Ferretry runs your agents on a computer. This browser watches them.');

    const cards = [...view.container.querySelectorAll('li button[data-onboarding-route]')];
    expect(cards.map(card => card.getAttribute('data-onboarding-route'))).toEqual(['first-time', 'add-client']);
    expect(cards[0]?.textContent).toContain('Set up a computer');
    expect(cards[1]?.textContent).toContain('I have a QR or link');

    const all = [...view.container.querySelectorAll('[data-onboarding-route]')];
    expect(all.map(node => node.getAttribute('data-onboarding-route'))).toEqual([
      'first-time',
      'add-client',
      'add-daemon',
    ]);
    const link = must(view.container.querySelector('[data-onboarding-route="add-daemon"]'), 'the add-daemon link');
    expect(link.closest('li')).toBeNull();
    expect(link.textContent).toBe('Add another computer');
    await view.unmount();
  });

  it('reports the route the reader picked, for every entry', async () => {
    const chosen: OnboardingRouteId[] = [];
    const view = await mount(<OnboardingChooser onChoose={route => chosen.push(route)} />);

    for (const id of ['first-time', 'add-client', 'add-daemon'] as const) {
      await click(must(view.container.querySelector(`[data-onboarding-route="${id}"]`), id));
    }
    expect(chosen).toEqual(['first-time', 'add-client', 'add-daemon']);
    await view.unmount();
  });

  it('has no Back: there is nothing behind the first screen', async () => {
    const view = await mount(<OnboardingChooser onChoose={() => {}} />);
    expect(view.container.querySelector('[data-onboarding-back]')).toBeNull();
    await view.unmount();
  });
});
