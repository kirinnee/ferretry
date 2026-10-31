/** Fixtures shared by the Machines shell suites, written out longhand so a schema change fails them. */

import type { FleetMachineView } from '@ferretry/protocol';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import { daemonConnection } from '../../../../../src/lib/daemon-connection.ts';

export const machineView = (overrides: Partial<FleetMachineView> = {}): FleetMachineView => ({
  name: 'studio-mac',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' }],
  runtimeCount: 2,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
  ...overrides,
});

/** A client that answers `GET /v1/fleet/machine` through the real schema, or fails as told. */
export const machineClient = (answer: FleetMachineView | Error, paths: string[] = []): FleetClient => ({
  request: async (path, schema) => {
    paths.push(path);
    if (answer instanceof Error) throw answer;
    return schema.parse(answer);
  },
});

export const pairing = (id: string, label?: string): DaemonConnectionRecord => ({
  ...daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `${id}-token` }),
  ...(label === undefined ? {} : { label }),
  pairedAt: 1,
  lastSelectedAt: 2,
});
