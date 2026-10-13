import { describe, expect, it } from 'bun:test';
import {
  type FleetAccountChangeOutcome,
  type FleetAccountChangeView,
  type FleetComponentCatalog,
  type FleetLayeredProfileCatalog,
  type FleetMachineView,
  type FleetProfileDraftView,
  type FleetRuntimeCatalog,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';
import type { z } from 'zod';

import {
  applyFleetChange,
  FLEET_CHANGES_PATH,
  FLEET_COMPONENTS_PATH,
  FLEET_MACHINE_PATH,
  FLEET_PROFILE_DRAFT_PATH,
  FLEET_PROFILE_STACKS_PATH,
  FLEET_RUNTIMES_PATH,
  readFleetChange,
  readFleetComponents,
  readFleetMachine,
  readFleetProfileStacks,
  previewFleetProfileDraft,
  readFleetRuntimes,
  stageFleetChange,
} from '../../../../src/features/fleet/catalog-api.ts';
import type { FleetClient } from '../../../../src/features/fleet/fleet-api.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

const TOKEN = `fy_unlock_${'A'.repeat(22)}`;
const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

const MACHINE = {
  name: 'studio',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/bin/claude' }],
  runtimeCount: 1,
  runningSessions: 0,
  changes: { available: true },
} satisfies FleetMachineView;

const COMPONENTS = {
  format: 'version-2',
  kinds: [{ kind: 'mcp', label: 'MCP servers', description: 'Tools a session can call.', components: [] }],
} satisfies FleetComponentCatalog;

const PROFILES = { format: 'version-2', profiles: [] } satisfies FleetLayeredProfileCatalog;

const RUNTIMES = { format: 'version-2', runtimes: [] } satisfies FleetRuntimeCatalog;

const VIEW = {
  id: CHANGE_ID,
  revision: 'absent',
  change: { kind: 'machine.settings', agentPermissions: 'skip' },
  summary: 'Set agent permissions to Skip all permission checks',
  consequences: ['Applies to new sessions.'],
  expiresAt: '2026-10-13T08:15:00.000Z',
  state: 'pending',
  preview: { kind: 'apply', operations: [], documents: [{ path: '/fy/fleet/config.yaml', bytes: 12 }], runtimes: [] },
} satisfies FleetAccountChangeView;

const OUTCOME = {
  outcome: 'executed',
  executor: 'setup',
  summary: 'Imported this machine’s setup',
} satisfies FleetAccountChangeOutcome;

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

describe('the catalogue wire client', () => {
  it('reads the machine, components, profile stacks and runtimes from their own paths', async () => {
    // Arrange
    const machine = clientFor(MACHINE);
    const components = clientFor(COMPONENTS);
    const profiles = clientFor(PROFILES);
    const runtimes = clientFor(RUNTIMES);

    // Act
    const answers = [
      await readFleetMachine(machine.client),
      await readFleetComponents(components.client),
      await readFleetProfileStacks(profiles.client),
      await readFleetRuntimes(runtimes.client),
    ];

    // Assert
    expect(answers).toEqual([MACHINE, COMPONENTS, PROFILES, RUNTIMES]);
    expect([machine, components, profiles, runtimes].map(read => read.calls[0]?.path)).toEqual([
      FLEET_MACHINE_PATH,
      FLEET_COMPONENTS_PATH,
      FLEET_PROFILE_STACKS_PATH,
      FLEET_RUNTIMES_PATH,
    ]);
    expect(headerOf(machine.calls[0], OPERATOR_UNLOCK_HEADER)).toBeUndefined();
  });

  it('carries the unlock on every read when there is one', async () => {
    // Arrange
    const reads = [readFleetMachine, readFleetComponents, readFleetProfileStacks, readFleetRuntimes] as const;
    const answers = [MACHINE, COMPONENTS, PROFILES, RUNTIMES];

    // Act
    const headers = await Promise.all(
      reads.map(async (read, index) => {
        const { client, calls } = clientFor(answers[index]);
        await read(client, TOKEN);
        return headerOf(calls[0], OPERATOR_UNLOCK_HEADER);
      }),
    );

    // Assert
    expect(headers).toEqual([TOKEN, TOKEN, TOKEN, TOKEN]);
  });

  it('stages a change as one named intent, never a configuration document', async () => {
    // Arrange
    const { client, calls } = clientFor(VIEW);

    // Act
    const view = await stageFleetChange(client, { kind: 'machine.settings', agentPermissions: 'skip' }, TOKEN);

    // Assert
    expect(view).toEqual(VIEW);
    expect(calls[0]?.path).toBe(FLEET_CHANGES_PATH);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      change: { kind: 'machine.settings', agentPermissions: 'skip' },
    });
    expect(headerOf(calls[0], OPERATOR_UNLOCK_HEADER)).toBe(TOKEN);
  });

  it('refuses to send a change the shared schema does not describe', async () => {
    // Arrange
    const { client, calls } = clientFor(VIEW);

    // Act
    const staged = stageFleetChange(client, { kind: 'machine.settings', agentPermissions: 'ask' } as never);

    // Assert
    await expect(staged).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('reads a staged change back by its id', async () => {
    // Arrange
    const { client, calls } = clientFor(VIEW);

    // Act
    const view = await readFleetChange(client, CHANGE_ID);

    // Assert
    expect(view).toEqual(VIEW);
    expect(calls[0]?.path).toBe(`${FLEET_CHANGES_PATH}/${CHANGE_ID}`);
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it('applies a change with the operator password for that change, and with none by default', async () => {
    // Arrange
    const confirmed = clientFor(OUTCOME);
    const local = clientFor(OUTCOME);

    // Act
    const outcome = await applyFleetChange(confirmed.client, CHANGE_ID, { operatorPassword: 'correct horse' }, TOKEN);
    await applyFleetChange(local.client, CHANGE_ID);

    // Assert
    expect(outcome).toEqual(OUTCOME);
    expect(confirmed.calls[0]?.path).toBe(`${FLEET_CHANGES_PATH}/${CHANGE_ID}/apply`);
    expect(confirmed.calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(confirmed.calls[0]?.init?.body as string)).toEqual({ operatorPassword: 'correct horse' });
    expect(headerOf(confirmed.calls[0], OPERATOR_UNLOCK_HEADER)).toBe(TOKEN);
    expect(JSON.parse(local.calls[0]?.init?.body as string)).toEqual({});
  });

  it('previews a draft profile as a POST of its layers, with the unlock and with none', async () => {
    // Arrange
    const draft = {
      harnesses: [
        {
          harness: 'claude',
          available: { available: false, reason: 'This profile has no layers yet.' },
          applied: [],
          skipped: [],
          conflicts: [],
          partial: [],
        },
      ],
    } satisfies FleetProfileDraftView;
    const unlocked = clientFor(draft);
    const local = clientFor(draft);

    // Act
    const view = await previewFleetProfileDraft(unlocked.client, { layers: [], editing: 'agent' }, TOKEN);
    await previewFleetProfileDraft(local.client, { layers: ['mcp/notes'] });

    // Assert
    expect(view).toEqual(draft);
    expect(unlocked.calls[0]?.path).toBe(FLEET_PROFILE_DRAFT_PATH);
    expect(unlocked.calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(unlocked.calls[0]?.init?.body as string)).toEqual({ layers: [], editing: 'agent' });
    expect(headerOf(unlocked.calls[0], OPERATOR_UNLOCK_HEADER)).toBe(TOKEN);
    expect(headerOf(local.calls[0], OPERATOR_UNLOCK_HEADER)).toBeUndefined();
  });
});
