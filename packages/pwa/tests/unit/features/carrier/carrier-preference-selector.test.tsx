/**
 * The connection preference selector (`docs/relay-protocol.md` §15 "The choice"): one labelled radio
 * group, every option offered, and an option that would carry nothing says why beside itself.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  CARRIER_PREFERENCE_DESCRIPTION,
  CarrierPreferenceSelector,
  TUNNEL_OFF_NOTE,
  TUNNEL_OFFER_QUESTION,
  type TunnelSwitchOffer,
  tunnelSwitchOffer,
  WEBRTC_UNAVAILABLE_NOTE,
} from '../../../../src/features/carrier/carrier-preference-selector.tsx';
import type { CarrierPreference } from '../../../../src/lib/carrier-preference.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const text = (element: ReturnType<typeof render>): string => JSON.stringify(element.toJSON());

describe('the connection preference selector', () => {
  it('should be one labelled radio group with all four choices, the current one checked', () => {
    const card = render(
      <CarrierPreferenceSelector
        legend="studio"
        value="tunnel"
        onChange={() => undefined}
        availability={{ webrtc: true }}
      />,
    );
    should(card.root.findByType('fieldset').props['data-carrier-preference']).equal('tunnel');
    should(card.root.findByType('legend').children.join('')).equal('studio');
    const radios = card.root.findAllByType('input');
    should(radios.map(radio => radio.props.value)).eql(['auto', 'webrtc', 'tunnel', 'relay']);
    should(radios.map(radio => radio.props.checked)).eql([false, false, true, false]);
    should(new Set(radios.map(radio => radio.props.name)).size).equal(1);
    should(radios.every(radio => radio.props.type === 'radio')).be.true();
    const rendered = text(card);
    for (const label of ['Auto', 'WebRTC only', 'Tunnel only', 'Relay only']) should(rendered).containEql(label);
    // §15's own words for WebRTC only: the relay introduces, and carries nothing.
    should(CARRIER_PREFERENCE_DESCRIPTION.webrtc).equal(
      'Peer to peer. The relay is used only to introduce the two ends.',
    );
    should(rendered).containEql(CARRIER_PREFERENCE_DESCRIPTION.webrtc);
    should(card.root.findAllByProps({ 'data-carrier-preference-note': '' })).have.length(0);
  });

  it('should say why an option would carry nothing, and point its radio at that sentence', () => {
    const card = render(
      <CarrierPreferenceSelector
        legend="Connection"
        legendHidden
        value="auto"
        onChange={() => undefined}
        availability={{ webrtc: false, tunnelNote: 'Not set up by the operator.' }}
      />,
    );
    should(card.root.findByType('legend').props.className).equal('sr-only');
    const notes = card.root.findAllByProps({ 'data-carrier-preference-note': '' });
    should(notes.map(note => note.children.join(''))).eql([WEBRTC_UNAVAILABLE_NOTE, 'Not set up by the operator.']);
    const radios = card.root.findAllByType('input');
    const webrtc = radios.find(radio => radio.props.value === 'webrtc');
    const tunnel = radios.find(radio => radio.props.value === 'tunnel');
    should(webrtc?.props['aria-describedby']).equal(notes[0]?.props.id);
    should(tunnel?.props['aria-describedby']).equal(notes[1]?.props.id);
    should(radios.find(radio => radio.props.value === 'relay')?.props['aria-describedby']).be.undefined();
  });

  it('should hand back the chosen preference', () => {
    const chosen: CarrierPreference[] = [];
    const card = render(
      <CarrierPreferenceSelector
        legend="studio"
        value="auto"
        onChange={preference => chosen.push(preference)}
        availability={{ webrtc: true }}
      />,
    );
    for (const radio of card.root.findAllByType('input')) run(() => radio.props.onChange());
    should(chosen).eql(['auto', 'webrtc', 'tunnel', 'relay']);
  });
});

describe('the tunnel offer (tunnels are opt-in, §15)', () => {
  const OFF_SENTENCE = 'Tunnel: off (opt-in) — turn on with fy daemon tunnel on or Settings › Connection';
  const offer = (overrides: Partial<TunnelSwitchOffer> = {}): TunnelSwitchOffer => ({
    sentence: OFF_SENTENCE,
    off: true,
    turnOn: async () => undefined,
    ...overrides,
  });
  const selector = (value: CarrierPreference, tunnel: TunnelSwitchOffer | undefined) =>
    render(
      <CarrierPreferenceSelector
        legend="studio"
        value={value}
        onChange={() => undefined}
        availability={{ webrtc: true, tunnelNote: 'This machine has no tunnel yet.', tunnel }}
      />,
    );
  const offered = (card: ReturnType<typeof render>) => card.root.findAllByProps({ 'data-tunnel-offer': '' });
  const button = (card: ReturnType<typeof render>, label: string) => {
    const found = card.root
      .findAllByType('button')
      .find(candidate => JSON.stringify(candidate.props.children).includes(label));
    if (found === undefined) throw new Error(`no ${label} button`);
    return found;
  };

  it('should ask to turn the tunnel on when Tunnel only or Auto is chosen for a machine whose tunnel is off', () => {
    for (const value of ['tunnel', 'auto'] as const) {
      const card = selector(value, offer());
      should(offered(card)).have.length(1);
      should(text(card)).containEql(TUNNEL_OFFER_QUESTION);
    }
    // The note under Tunnel only says why, in place of the service's sentence.
    const notes = selector('tunnel', offer()).root.findAllByProps({ 'data-carrier-preference-note': '' });
    should(notes.map(note => note.children.join(''))).eql([TUNNEL_OFF_NOTE]);
  });

  it('should not ask for a preference that walks no tunnel, a tunnel that is on, or a machine that has not said', () => {
    should(offered(selector('relay', offer()))).have.length(0);
    should(offered(selector('webrtc', offer()))).have.length(0);
    should(offered(selector('tunnel', offer({ off: false })))).have.length(0);
    should(offered(selector('tunnel', undefined))).have.length(0);
    const notes = selector('tunnel', offer({ off: false })).root.findAllByProps({ 'data-carrier-preference-note': '' });
    should(notes.map(note => note.children.join(''))).eql(['This machine has no tunnel yet.']);
  });

  it('should turn it on when asked, showing the work, and say the daemon’s refusal in its own words', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const card = selector(
      'tunnel',
      offer({
        turnOn: async () => {
          calls += 1;
          if (calls === 1) throw new Error('This device may not change how this machine is reached.');
          await new Promise<void>(resolve => {
            release = resolve;
          });
        },
      }),
    );

    await runAsync(async () => button(card, 'Turn on').props.onClick());
    should(card.root.findByProps({ 'data-tunnel-offer-error': '' }).children.join('')).equal(
      'This device may not change how this machine is reached.',
    );

    await runAsync(async () => {
      button(card, 'Turn on').props.onClick();
      await Promise.resolve();
    });
    should(button(card, 'Turning on').props.disabled).be.true();
    should(card.root.findAllByProps({ 'data-tunnel-offer-error': '' })).have.length(0);
    await runAsync(async () => release());
    should(calls).equal(2);
  });

  it('should go away for now when the person says not now', () => {
    const card = selector('auto', offer());
    run(() => button(card, 'Not now').props.onClick());
    should(offered(card)).have.length(0);
  });

  it('should build an offer only from a machine’s known answer', async () => {
    const turnedOn: boolean[] = [];
    const view = {
      enabled: false,
      explicit: false,
      state: 'off' as const,
      tunnelUrl: null,
      sentence: OFF_SENTENCE,
    };
    const built = tunnelSwitchOffer({ kind: 'known', view }, async () => turnedOn.push(true));
    should(built?.off).be.true();
    should(built?.sentence).equal(OFF_SENTENCE);
    await built?.turnOn();
    should(turnedOn).eql([true]);
    should(
      tunnelSwitchOffer({ kind: 'known', view: { ...view, enabled: true, state: 'up' } }, async () => 0)?.off,
    ).be.false();
    should(tunnelSwitchOffer({ kind: 'unknown' }, async () => 0)).be.undefined();
    should(tunnelSwitchOffer({ kind: 'unsupported' }, async () => 0)).be.undefined();
    should(tunnelSwitchOffer(undefined, async () => 0)).be.undefined();
  });
});
