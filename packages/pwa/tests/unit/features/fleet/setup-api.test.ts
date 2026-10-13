import { describe, expect, it } from 'bun:test';
import {
  type FleetCloneBundle,
  type FleetSetupScan,
  type FleetToolInstallResult,
  OPERATOR_UNLOCK_HEADER,
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

const TOKEN = `fy_unlock_${'A'.repeat(22)}`;

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
  it('reads the scan and the export from their own paths, with no unlock by default', async () => {
    // Arrange
    const scan = clientFor(SCAN);
    const bundle = clientFor(BUNDLE);

    // Act
    const answers = [await readFleetSetupScan(scan.client), await readFleetExport(bundle.client)];

    // Assert
    expect(answers).toEqual([SCAN, BUNDLE]);
    expect([scan, bundle].map(read => read.calls[0]?.path)).toEqual([FLEET_SETUP_SCAN_PATH, FLEET_EXPORT_PATH]);
    expect([scan, bundle].map(read => read.calls[0]?.init?.method)).toEqual([undefined, undefined]);
    expect([scan, bundle].map(read => headerOf(read.calls[0], OPERATOR_UNLOCK_HEADER))).toEqual([undefined, undefined]);
  });

  it('carries the unlock on every read when there is one', async () => {
    // Arrange
    const reads = [readFleetSetupScan, readFleetExport] as const;
    const answers = [SCAN, BUNDLE];

    // Act
    const headers = await Promise.all(
      reads.map(async (read, index) => {
        const { client, calls } = clientFor(answers[index]);
        await read(client, TOKEN);
        return headerOf(calls[0], OPERATOR_UNLOCK_HEADER);
      }),
    );

    // Assert
    expect(headers).toEqual([TOKEN, TOKEN]);
  });

  it('posts a tool install as JSON with the unlock when there is one, and without it when there is not', async () => {
    // Arrange
    const unlocked = clientFor(INSTALL);
    const local = clientFor(INSTALL);
    const request = { harnesses: ['claude', 'codex'] } as const;

    // Act
    const result = await installFleetTools(unlocked.client, { ...request, harnesses: [...request.harnesses] }, TOKEN);
    await installFleetTools(local.client, { harnesses: ['claude'] });

    // Assert
    expect(result).toEqual(INSTALL);
    expect(unlocked.calls[0]?.path).toBe(FLEET_TOOLS_INSTALL_PATH);
    expect(unlocked.calls[0]?.init?.method).toBe('POST');
    expect(headerOf(unlocked.calls[0], 'content-type')).toBe('application/json');
    expect(headerOf(unlocked.calls[0], OPERATOR_UNLOCK_HEADER)).toBe(TOKEN);
    expect(JSON.parse(unlocked.calls[0]?.init?.body as string)).toEqual({ harnesses: ['claude', 'codex'] });
    expect(headerOf(local.calls[0], OPERATOR_UNLOCK_HEADER)).toBeUndefined();
    expect(JSON.parse(local.calls[0]?.init?.body as string)).toEqual({ harnesses: ['claude'] });
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
