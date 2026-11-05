import { describe, expect, it } from 'bun:test';
import {
  type FleetCloneBundle,
  type FleetSetupScan,
  type FleetToolInstallResult,
  mcpOAuthSecretNames,
} from '@ferretry/protocol';
import type { z } from 'zod';

import type { FleetClient } from '../../../../src/features/fleet/fleet-client.ts';
import {
  FLEET_EXPORT_PATH,
  FLEET_CLONE_REVIEW_PATH,
  FLEET_SETUP_SCAN_PATH,
  FLEET_TOOLS_INSTALL_PATH,
  installFleetTools,
  readFleetExport,
  readFleetSetupScan,
  recordCloneKeys,
  reviewFleetClone,
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

describe('the clone keys wire client', () => {
  const REVIEW = {
    mode: 'update',
    source: { name: 'studio', verified: 'browser' },
    items: [],
    settings: [],
    logins: [],
    keys: [{ name: 'GLM_API_KEY', outcome: 'newer' }],
    same: { count: 0, probable: 0 },
    fingerprint: 'f'.repeat(64),
  };

  it('asks for a review with the source’s names and instants, as JSON', async () => {
    const { client, calls } = clientFor(REVIEW);
    const sourceSecrets = [{ name: 'GLM_API_KEY', updatedAt: '2026-10-20T08:00:00.000Z' }];

    const answer = await reviewFleetClone(client, { bundle: BUNDLE, source: { daemonId: 'studio' }, sourceSecrets });

    expect(answer.keys.map(key => `${key.name}:${key.outcome}`)).toEqual(['GLM_API_KEY:newer']);
    expect(calls[0]?.path).toBe(FLEET_CLONE_REVIEW_PATH);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string).sourceSecrets).toEqual(sourceSecrets);
  });

  it('records the instants of the keys a sealed copy filed, and refuses a sign-in token’s name before sending', async () => {
    const { client, calls } = clientFor({ recorded: 1 });
    const keys = [{ name: 'GLM_API_KEY', sourceUpdatedAt: '2026-10-20T08:00:00.000Z' }];

    const filedAt = '2026-10-21T08:00:00.000Z';

    expect(await recordCloneKeys(client, { source: { daemonId: 'studio' }, filedAt, keys })).toEqual({ recorded: 1 });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ source: { daemonId: 'studio' }, filedAt, keys });

    const refused = recordCloneKeys(client, {
      source: { daemonId: 'studio' },
      filedAt,
      keys: [
        {
          name: mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access,
          sourceUpdatedAt: keys[0]?.sourceUpdatedAt ?? '',
        },
      ],
    });
    await expect(refused).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
