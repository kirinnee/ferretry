import { describe, expect, it } from 'bun:test';
import type {
  FleetCloneBundle,
  FleetSetupScan,
  FleetToolInstallResult,
} from '@ferretry/protocol';
import type { z } from 'zod';

import type { FleetClient } from '../../../../src/features/fleet/fleet-client.ts';
import {
  FLEET_EXPORT_PATH,
  FLEET_SETUP_SCAN_PATH,
  FLEET_TOOLS_INSTALL_PATH,
  installFleetTools,
  readFleetExport,
  readFleetSetupScan,
} from '../../../../src/features/fleet/setup-api.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}


const SCAN = {
  machine: 'studio',
  format: 'version-2',
  tools: [{ harness: 'claude', label: 'Claude Code', installed: true }],
  harnesses: [],
  runtimes: [],
  updates: [],
  duplicates: [],
  notes: [],
  importing: { available: true },
} satisfies FleetSetupScan;

const INSTALL = {
  outcomes: [{ harness: 'claude', outcome: 'already-installed' }],
} satisfies FleetToolInstallResult;

const BUNDLE = {
  format: 'ferretry-clone',
  version: 1,
  machine: 'studio',
  exportedAt: '2026-10-13T08:00:00.000Z',
  credentials: [],
  components: {},
  profiles: {},
  runtimes: {},
  files: [],
  notCopied: [],
} satisfies FleetCloneBundle;

const clientFor = (answer: unknown): { client: FleetClient; calls: Call[] } => {
  const calls: Call[] = [];
  const client: FleetClient = {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return schema.parse(answer);
    },
  };
  return { client, calls };
};

const headerOf = (call: Call | undefined, name: string): string | undefined =>
  (call?.init?.headers as Record<string, string> | undefined)?.[name];

describe('the setup wire client', () => {
  it('reads the scan and the export from their own paths, from their own paths', async () => {
    // Arrange
    const scan = clientFor(SCAN);
    const bundle = clientFor(BUNDLE);

    // Act
    const answers = [await readFleetSetupScan(scan.client), await readFleetExport(bundle.client)];

    // Assert
    expect(answers).toEqual([SCAN, BUNDLE]);
    expect([scan, bundle].map(read => read.calls[0]?.path)).toEqual([FLEET_SETUP_SCAN_PATH, FLEET_EXPORT_PATH]);
    expect([scan, bundle].map(read => read.calls[0]?.init?.method)).toEqual([undefined, undefined]);
  });

  it('posts a tool install as JSON', async () => {
    // Arrange
    const { client, calls } = clientFor(INSTALL);

    // Act
    const result = await installFleetTools(client, { harnesses: ['claude', 'codex'] });

    // Assert
    expect(result).toEqual(INSTALL);
    expect(calls[0]?.path).toBe(FLEET_TOOLS_INSTALL_PATH);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(headerOf(calls[0], 'content-type')).toBe('application/json');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ harnesses: ['claude', 'codex'] });
  });

  it('refuses to send a tool install the shared schema does not describe', async () => {
    // Arrange
    const { client, calls } = clientFor(INSTALL);

    // Act
    const installed = installFleetTools(client, { harnesses: [] });

    // Assert
    await expect(installed).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
