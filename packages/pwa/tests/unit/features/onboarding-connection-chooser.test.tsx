import { describe, expect, it } from 'bun:test';

import { OnboardingConnectionChooser } from '../../../src/features/onboarding/onboarding-connection-chooser.tsx';
import { interact, mount, must } from '../../support/dom.ts';

describe('the connection chooser', () => {
  it('leads with the recommended default and makes all three routes real actions', async () => {
    const chosen: string[] = [];
    const view = await mount(<OnboardingConnectionChooser onChoose={connection => chosen.push(connection)} />);
    const choices = [...view.container.querySelectorAll<HTMLButtonElement>('[data-onboarding-connection]')];

    expect(choices.map(choice => choice.dataset.onboardingConnection)).toEqual([
      'default-relay',
      'own-relay',
      'direct',
    ]);
    expect(choices[0]?.textContent).toContain('Recommended');
    expect(view.container.textContent).toContain('Direct is used whenever it is reachable');

    await interact(() => must(choices[1], 'the own relay choice').click());
    expect(chosen).toEqual(['own-relay']);
    await view.unmount();
  });
});
