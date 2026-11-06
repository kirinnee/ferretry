import { describe, expect, it } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { useDensity } from '../../src/hooks/use-density.ts';
import { useFleetView } from '../../src/hooks/use-fleet-view.ts';
import { useGroupNeedsYou } from '../../src/hooks/use-group-needs-you.ts';
import { useMachineOrder } from '../../src/hooks/use-machine-order.ts';
import { type ControlsStorage, DaemonControlsStore } from '../../src/lib/controls.ts';
import { daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { sessionView } from '../support/sessions.ts';

// A server render reads every external store through its server snapshot, so each hook must produce
// the same first paint there as on the client (or, for an attention status, the documented 'idle').

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });

const memoryStorage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

describe('hooks rendered on the server', () => {
  it('reads the device controls: density, machine order and the needs-you grouping', () => {
    const controls = new DaemonControlsStore(memoryStorage());
    controls.setDeviceControls({ density: 'minimal', machineOrder: [daemonId('beta'), daemonId('alpha')] });
    controls.setDeviceControls({ groupNeedsYou: false });
    const Probe = () => {
      const density = useDensity(controls);
      const order = useMachineOrder(controls);
      const grouped = useGroupNeedsYou(controls);
      return <output>{`${density.density}:${order.saved.join(',')}:${String(grouped)}`}</output>;
    };
    expect(renderToString(<Probe />)).toContain('minimal:beta,alpha:false');
  });

  it('renders a fleet view from the fleet and controls stores', () => {
    const fleet = new DaemonFleetStore({
      list: async () => [sessionView('s1')],
      get: async () => sessionView('s1'),
    });
    const controls = new DaemonControlsStore(memoryStorage());
    const Probe = () => {
      const view = useFleetView({ fleet, controls, daemonId: daemon.daemonId });
      return (
        <output>{`${view.slice.status}:${view.slice.sessions === null ? 'unread' : view.slice.sessions.length}`}</output>
      );
    };
    expect(renderToString(<Probe />)).toContain('idle:unread');
  });
});
