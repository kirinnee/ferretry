/**
 * The connection preference selector (`docs/relay-protocol.md` §15 "The choice"): one labelled radio
 * group, every option offered, and an option that would carry nothing says why beside itself.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  CARRIER_PREFERENCE_DESCRIPTION,
  CarrierPreferenceSelector,
  WEBRTC_UNAVAILABLE_NOTE,
} from '../../../../src/features/carrier/carrier-preference-selector.tsx';
import type { CarrierPreference } from '../../../../src/lib/carrier-preference.ts';
import { render, run } from '../../../support/react.ts';

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
