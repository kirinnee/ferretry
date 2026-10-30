import { describe, expect, it } from 'bun:test';
import type { AgendaSnapshot, PinSnapshot, SessionView } from '@ferretry/protocol';
import { renderToString } from 'react-dom/server';
import { useAgendaCount, useAgendaSession, useAgendaSnapshot } from '../../src/hooks/use-agenda.ts';
import { useDensity } from '../../src/hooks/use-density.ts';
import { useFleetView } from '../../src/hooks/use-fleet-view.ts';
import { useGroupNeedsYou } from '../../src/hooks/use-group-needs-you.ts';
import { useMachineOrder } from '../../src/hooks/use-machine-order.ts';
import { usePinsSession, useSessionPins } from '../../src/hooks/use-pins.ts';
import { useKnownProjects, useProjectsSlice } from '../../src/hooks/use-projects.ts';
import {
  useMachinesUsage,
  useOptionalSessionQuota,
  useSessionQuota,
  useUsage,
  useUsageSlice,
} from '../../src/hooks/use-usage.ts';
import { DaemonAgendaClient } from '../../src/lib/agenda-client.ts';
import { type ControlsStorage, DaemonControlsStore } from '../../src/lib/controls.ts';
import { daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonFleetStore } from '../../src/lib/fleet-store.ts';
import { DaemonPinClient } from '../../src/lib/pin-client.ts';
import { DaemonProjectsStore } from '../../src/lib/projects-store.ts';
import { DaemonUsageStore } from '../../src/lib/usage-store.ts';
import { sessionView } from '../support/sessions.ts';

// A server render reads every external store through its server snapshot, so each hook must produce
// the same first paint there as on the client (or, for a pin/attention status, the documented 'idle').

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(daemon, 'session-a');

const memoryStorage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

const agendaBoard: AgendaSnapshot = {
  v: 1,
  sessionId: 'session-a',
  items: [
    {
      id: 'A1',
      source: 'question',
      sourceRef: null,
      subject: 'Question',
      why: 'Decision needed',
      waitingSince: '2026-08-01T00:00:00.000Z',
      howToResolve: 'Answer it',
      raisedBy: 'human',
      raisedBySession: null,
      raisedByName: null,
    },
  ],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const pinBoard: PinSnapshot = { v: 1, sessionId: 'session-a', updatedAt: '2026-08-01T00:00:00.000Z', pins: [] };

describe('hooks rendered on the server', () => {
  it('reads the agenda store as idle status, its board and its badge count', () => {
    const client = new DaemonAgendaClient();
    client.store.applySnapshot(scope, agendaBoard);
    const Probe = () => {
      const status = useAgendaSession(client, daemon, scope);
      const board = useAgendaSnapshot(client, scope);
      const count = useAgendaCount(client, daemon, scope);
      return <output>{`${status}:${board?.count ?? 'none'}:${count}`}</output>;
    };
    expect(renderToString(<Probe />)).toContain('idle:1:1');
  });

  it('reads the pin store as idle status and its board', () => {
    const client = new DaemonPinClient();
    client.store.applySnapshot(scope, pinBoard);
    const Probe = () => {
      const status = usePinsSession(client, daemon, scope);
      const board = useSessionPins(client, scope);
      return <output>{`${status}:${board?.sessionId ?? 'none'}`}</output>;
    };
    expect(renderToString(<Probe />)).toContain('idle:session-a');
  });

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

  it('reads the registered projects, known projects and the usage slices', () => {
    const projects = new DaemonProjectsStore({ projects: async () => [] });
    const usage = new DaemonUsageStore({
      usage: async () => ({ at: '2026-08-01T09:00:00.000Z', stale: false, accounts: [] }),
    });
    const view: SessionView = sessionView('s1');
    const Probe = () => {
      const slice = useProjectsSlice(projects, daemon);
      const known = useKnownProjects(projects, daemon.daemonId);
      const live = useUsage(usage, daemon);
      const passive = useUsageSlice(usage, daemon.daemonId);
      useMachinesUsage(usage, [daemon]);
      const quota = useSessionQuota(usage, daemon.daemonId, view);
      const optional = useOptionalSessionQuota(usage, daemon, view);
      return (
        <output>{`${slice.status}:${known.length}:${live.status}:${passive.status}:${quota === null ? 'null' : 'quota'}:${optional === null ? 'null' : 'quota'}`}</output>
      );
    };
    expect(renderToString(<Probe />)).toContain('idle:0:idle:idle:null:null');
  });
});
