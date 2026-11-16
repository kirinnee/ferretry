import { describe, expect, it } from 'bun:test';

import { CHECKING_HOSTED_RELAY, settleHostedRelay } from '../../../app/hosted-relay-state.ts';
import { OnboardingConnectionNote } from '../../../app/onboarding-connection-note.tsx';
import { mount, must } from '../support/dom.ts';

describe('the connection note', () => {
  it('says how other devices reach the daemon and asks nothing', async () => {
    const view = await mount(<OnboardingConnectionNote fallback={CHECKING_HOSTED_RELAY} />);

    // Direct first, the hosted relay as the automatic fallback: stated, not chosen.
    expect(view.container.textContent).toContain('Nothing to choose');
    expect(view.container.textContent).toContain('directly first');
    expect(view.container.textContent).toContain('hosted relay carries the connection');
    // No control a stranger would have to answer, and no self-hosting route.
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
    expect(view.container.querySelector('[data-onboarding-connection]')).toBeNull();
    expect(view.container.textContent).not.toContain('own relay');
    await view.unmount();
  });

  it('says what the hosted relay is doing right now', async () => {
    const advertising = await mount(
      <OnboardingConnectionNote fallback={{ kind: 'available', relayUrl: 'https://relay.example.test' }} />,
    );

    // The address came from the runtime advertisement, not from the bundle.
    expect(advertising.container.textContent).toContain('https://relay.example.test');
    expect(
      must(advertising.container.querySelector('[data-onboarding-fallback]'), 'the note').getAttribute(
        'data-onboarding-fallback',
      ),
    ).toBe('available');
    await advertising.unmount();
  });

  it('says the hosted relay is switched off when the operator switched it off', async () => {
    const off = await mount(<OnboardingConnectionNote fallback={{ kind: 'disabled' }} />);

    // The kill switch is a fact about the service, so it is stated as a
    // constraint on the reader rather than as an error they caused.
    expect(off.container.textContent).toContain('switched off');
    expect(off.container.textContent).toContain('only carrier');
    await off.unmount();
  });

  it('shows ignorance as ignorance, never as available and never as off', async () => {
    const unknown = await mount(
      <OnboardingConnectionNote fallback={{ kind: 'undetermined', reason: 'nothing answered' }} />,
    );

    expect(unknown.container.textContent).toContain('unavailable');
    expect(unknown.container.textContent).toContain('nothing answered');
    expect(unknown.container.textContent).not.toContain('switched off');
    expect(unknown.container.textContent).not.toContain('Available now');
    await unknown.unmount();
  });

  it('c58-07 settles the shell’s answer as it came, and a read that throws as ignorance (never checking, never off)', async () => {
    const answer = { kind: 'available', relayUrl: 'https://relay.example.test' } as const;
    expect(await settleHostedRelay(async () => answer)).toBe(answer);
    expect(await settleHostedRelay(async () => ({ kind: 'disabled' }))).toEqual({ kind: 'disabled' });
    const thrown = await settleHostedRelay(() => {
      throw new Error('not a function');
    });
    const rejected = await settleHostedRelay(async () => Promise.reject(new Error('refused')));
    for (const state of [thrown, rejected]) expect(state.kind).toBe('undetermined');
    expect(CHECKING_HOSTED_RELAY.kind).toBe('checking');
    expect(Object.isFrozen(CHECKING_HOSTED_RELAY)).toBe(true);
  });

  it('folds away what the fallback does not cover and what it would see', async () => {
    const view = await mount(<OnboardingConnectionNote fallback={CHECKING_HOSTED_RELAY} />);

    // §14 carries first pairing and live streams now, so the note may no longer
    // say pairing is always direct. What is left is whether the daemon holds a
    // rendezvous at all, and which panels still dial the daemon's own address.
    const gap = must(view.container.querySelector('[data-onboarding-transport-gap]'), 'the transport gap');
    expect(gap.textContent).toContain('dials a relay of its own');
    expect(gap.textContent).not.toContain('Pairing itself always goes straight to the daemon');
    const asides = [...view.container.querySelectorAll<HTMLDetailsElement>('details')];
    expect(asides).toHaveLength(2);
    for (const aside of asides) expect(aside.open).toBe(false);
    expect(must(asides[1], 'the disclosure').textContent).toContain('fingerprint');
    await view.unmount();
  });
});
