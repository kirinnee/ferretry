/**
 * Settings › This device › Connection: one connection preference per paired machine, kept on this
 * device (`docs/relay-protocol.md` §15 "The choice").
 */

import { describe, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import should from 'should';
import { CARRIER_PREFERENCE_DESCRIPTION } from '../../../../src/features/carrier/carrier-preference-selector.tsx';
import {
  ConnectionPreferenceSettings,
  NO_MACHINES_TO_CONNECT,
} from '../../../../src/features/settings/connection-preference-settings.tsx';
import type { CarrierPreference } from '../../../../src/lib/carrier-preference.ts';
import type { DaemonId } from '../../../../src/lib/daemon-connection.ts';
import { render, run } from '../../../support/react.ts';

const STUDIO = 'fy_daemon_studio' as DaemonId;
const LAPTOP = 'fy_daemon_laptop' as DaemonId;

describe('the connection preferences for every machine', () => {
  it('should say there is nothing to choose before anything is paired', () => {
    const view = render(<ConnectionPreferenceSettings machines={[]} onChange={() => undefined} />);
    should(JSON.stringify(view.toJSON())).containEql(NO_MACHINES_TO_CONNECT);
    should(view.root.findAllByProps({ role: 'radiogroup' })).have.length(0);
  });

  it('should give each machine its own named row, and say which machine a change is for', () => {
    const changes: [DaemonId, CarrierPreference][] = [];
    const view = render(
      <ConnectionPreferenceSettings
        machines={[
          { daemonId: STUDIO, label: 'studio', preference: 'relay', availability: { webrtc: false } },
          {
            daemonId: LAPTOP,
            label: 'laptop',
            preference: 'auto',
            availability: { webrtc: false, tunnelNote: 'This machine has no tunnel yet.' },
          },
        ]}
        onChange={(daemonId, preference) => changes.push([daemonId, preference])}
      />,
    );
    const rows = view.root.findAll(node => node.type === 'li' && node.props['data-setting-row'] !== undefined);
    should(rows.map(row => row.props['data-setting-row'])).eql(['studio', 'laptop']);
    const groups = view.root.findAll(node => node.type === 'div' && node.props.role === 'radiogroup');
    should(groups.map(group => group.props['aria-label'])).eql([
      'studio: how this device connects',
      'laptop: how this device connects',
    ]);
    should(
      rows.map(
        row =>
          row.findByProps({ 'data-carrier-preference': row.props['data-setting-row'] === 'studio' ? 'relay' : 'auto' })
            .props['data-carrier-preference'],
      ),
    ).eql(['relay', 'auto']);
    // The checked option of each group is the machine's own preference, and the only tab stop.
    const checkedOf = (group: (typeof groups)[number]) =>
      group
        .findAllByType('input')
        .filter(input => input.props.checked)
        .map(input => input.props.value);
    should(groups.map(checkedOf)).eql([['relay'], ['auto']]);
    // Two groups on one page never share a radio set.
    const names = groups.map(group => group.findAllByType('input')[0]?.props.name);
    should(names[0]).not.equal(names[1]);
    const tunnelOnLaptop = groups[1]?.findAllByType('input').find(input => input.props.value === 'tunnel');
    run(() => tunnelOnLaptop?.props.onChange());
    should(changes).eql([[LAPTOP, 'tunnel']]);
    // The long explanation sits behind the (i), so it is read only when asked for.
    should(JSON.stringify(view.toJSON())).not.containEql('never sent to it');
    const info = rows[0]?.findByProps({ 'data-setting-info': '' });
    should(info?.props['aria-expanded']).equal(false);
    run(() => info?.props.onClick());
    should(JSON.stringify(view.toJSON())).containEql('never sent to it');
  });

  it('should say why an unusable choice is unusable even while another choice is selected', () => {
    const view = render(
      <ConnectionPreferenceSettings
        machines={[
          {
            daemonId: STUDIO,
            label: 'studio',
            preference: 'relay',
            availability: { webrtc: false, tunnelNote: 'Not set up by the operator.' },
          },
        ]}
        onChange={() => undefined}
      />,
    );
    const group = view.root.find(node => node.type === 'div' && node.props.role === 'radiogroup');
    const radio = (value: string): ReactTestInstance =>
      group.findAllByType('input').find(input => input.props.value === value) as ReactTestInstance;
    const noteFor = (value: string): ReactTestInstance | undefined =>
      view.root.findAll(node => node.props['data-carrier-preference-note'] === value)[0];

    // Relay is selected, yet WebRTC and Tunnel each say why they would carry nothing.
    should(noteFor('webrtc')?.children.join('')).containEql('WebRTC isn’t available in this build yet.');
    should(noteFor('tunnel')?.children.join('')).containEql('Not set up by the operator.');
    should(noteFor('relay')).equal(undefined);
    should(noteFor('auto')).equal(undefined);
    // Each affected radio is described by its own reason, and the usable ones carry no description.
    should(radio('webrtc').props['aria-describedby']).equal(noteFor('webrtc')?.props.id);
    should(radio('tunnel').props['aria-describedby']).equal(noteFor('tunnel')?.props.id);
    should(radio('relay').props['aria-describedby']).equal(undefined);
    should(radio('auto').props['aria-describedby']).equal(undefined);
  });

  it('should offer to turn the tunnel on under the row of a machine whose tunnel is off and whose choice walks it', () => {
    const offer = { sentence: 'Tunnel: off (opt-in).', off: true, turnOn: async () => undefined };
    const view = render(
      <ConnectionPreferenceSettings
        machines={[
          { daemonId: STUDIO, label: 'studio', preference: 'auto', availability: { webrtc: false, tunnel: offer } },
          { daemonId: LAPTOP, label: 'laptop', preference: 'relay', availability: { webrtc: false, tunnel: offer } },
        ]}
        onChange={() => undefined}
      />,
    );
    const rowOf = (name: string): ReactTestInstance =>
      view.root.find(node => node.type === 'li' && node.props['data-setting-row'] === name);

    should(rowOf('studio').findAll(node => node.props['data-tunnel-offer'] !== undefined)).not.have.length(0);
    should(rowOf('laptop').findAll(node => node.props['data-tunnel-offer'] !== undefined)).have.length(0);
  });

  it('should keep what every choice does behind the (i), not only the chosen one', () => {
    const view = render(
      <ConnectionPreferenceSettings
        machines={[{ daemonId: STUDIO, label: 'studio', preference: 'relay', availability: { webrtc: true } }]}
        onChange={() => undefined}
      />,
    );
    run(() => view.root.findByProps({ 'data-setting-info': '' }).props.onClick());
    const text = JSON.stringify(view.toJSON());
    for (const description of Object.values(CARRIER_PREFERENCE_DESCRIPTION)) should(text).containEql(description);
  });
});
