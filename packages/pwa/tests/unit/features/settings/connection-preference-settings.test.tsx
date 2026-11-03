/**
 * Settings › This device › Connection: one connection preference per paired machine, kept on this
 * device (`docs/relay-protocol.md` §15 "The choice").
 */

import { describe, it } from 'bun:test';
import should from 'should';
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
});
