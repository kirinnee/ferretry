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
    should(view.root.findAllByType('fieldset')).have.length(0);
  });

  it('should give each machine its own named group, and say which machine a change is for', () => {
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
    const groups = view.root.findAllByType('fieldset');
    should(groups.map(group => group.findByType('legend').children.join(''))).eql(['studio', 'laptop']);
    should(groups.map(group => group.props['data-carrier-preference'])).eql(['relay', 'auto']);
    // Two groups on one page never share a radio set.
    const names = groups.map(group => group.findAllByType('input')[0]?.props.name);
    should(names[0]).not.equal(names[1]);
    const tunnelOnLaptop = groups[1]?.findAllByType('input').find(input => input.props.value === 'tunnel');
    run(() => tunnelOnLaptop?.props.onChange());
    should(changes).eql([[LAPTOP, 'tunnel']]);
    should(JSON.stringify(view.toJSON())).containEql('never sent to it');
  });
});
