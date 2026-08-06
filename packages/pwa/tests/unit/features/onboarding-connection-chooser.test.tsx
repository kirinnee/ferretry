import { describe, expect, it } from 'bun:test';

import { CHECKING_HOSTED_RELAY } from '../../../src/features/onboarding/hosted-relay.ts';
import { OnboardingConnectionChooser } from '../../../src/features/onboarding/onboarding-connection-chooser.tsx';
import { interact, mount, must } from '../../support/dom.ts';

describe('the connection chooser', () => {
  it('leads with the recommended default and makes all three routes real actions', async () => {
    const chosen: string[] = [];
    const view = await mount(
      <OnboardingConnectionChooser onChoose={connection => chosen.push(connection)} fallback={CHECKING_HOSTED_RELAY} />,
    );
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

  it('says on the recommended row what the relay is doing right now', async () => {
    const advertising = await mount(
      <OnboardingConnectionChooser
        onChoose={() => {}}
        fallback={{ kind: 'available', relayUrl: 'https://relay.example.test' }}
      />,
    );

    // The address came from the runtime advertisement, not from the bundle.
    expect(advertising.container.textContent).toContain('https://relay.example.test');
    expect(
      must(advertising.container.querySelector('[data-onboarding-fallback]'), 'the chooser').getAttribute(
        'data-onboarding-fallback',
      ),
    ).toBe('available');
    await advertising.unmount();
  });

  it('says the recommended row is switched off when the operator switched it off', async () => {
    const off = await mount(<OnboardingConnectionChooser onChoose={() => {}} fallback={{ kind: 'disabled' }} />);

    // The kill switch is a fact about the service, so it is stated as a
    // constraint on the reader rather than as an error they caused.
    expect(off.container.textContent).toContain('switched off');
    expect(off.container.textContent).toContain('only carrier');
    // And still choosable: the daemon may well be reachable directly anyway.
    expect(off.container.querySelector('[data-onboarding-connection="default-relay"]')).not.toBeNull();
    await off.unmount();
  });

  it('shows ignorance as ignorance, never as available and never as off', async () => {
    const unknown = await mount(
      <OnboardingConnectionChooser
        onChoose={() => {}}
        fallback={{ kind: 'undetermined', reason: 'nothing answered' }}
      />,
    );

    expect(unknown.container.textContent).toContain('Unavailable');
    expect(unknown.container.textContent).toContain('nothing answered');
    expect(unknown.container.textContent).not.toContain('switched off');
    expect(unknown.container.textContent).not.toContain('Advertising itself now');
    await unknown.unmount();
  });

  it('says out loud what the fallback does not cover', async () => {
    const view = await mount(<OnboardingConnectionChooser onChoose={() => {}} fallback={CHECKING_HOSTED_RELAY} />);

    // The reader this matters most to is the one whose daemon is behind NAT, who
    // would otherwise pick the recommended row and connect to nothing. What that
    // reader needs told has CHANGED: `docs/relay-protocol.md` §14 carries first
    // pairing and live streams now, so the warning may no longer say pairing is
    // always direct. The condition that is left is whether the daemon holds a
    // rendezvous at all.
    const gap = must(view.container.querySelector('[data-onboarding-transport-gap]'), 'the transport gap');
    expect(gap.textContent).toContain('dials a relay of its own');
    expect(gap.textContent).not.toContain('Pairing itself always goes straight to the daemon');
    expect(gap.className).toContain('text-warn');
    // And the disclosure of what the relay would see, folded away.
    const aside = must(view.container.querySelector<HTMLDetailsElement>('details'), 'the disclosure');
    expect(aside.open).toBe(false);
    expect(aside.textContent).toContain('fingerprint');
    await view.unmount();
  });
});
