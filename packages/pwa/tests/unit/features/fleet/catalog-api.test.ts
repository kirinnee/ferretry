import { describe, expect, it } from 'bun:test';
import type {
  FleetAccountChangeOutcome,
  FleetAccountChangeView,
  FleetComponentCatalog,
  FleetLayeredProfileCatalog,
  FleetMachineView,
  FleetProfileDraftView,
  FleetRuntimeCatalog,
} from '@ferretry/protocol';
import type { z } from 'zod';

import {
  applyFleetChange,
  FLEET_COMPONENTS_PATH,
  FLEET_MACHINE_PATH,
  FLEET_PROFILE_DRAFT_PATH,
  FLEET_PROFILES_PATH,
  FLEET_PROPOSALS_PATH,
  FLEET_RUNTIMES_PATH,
  previewFleetProfileDraft,
  readFleetChange,
  readFleetComponents,
  readFleetMachine,
  readFleetProfiles,
  readFleetRuntimes,
  stageFleetChange,
} from '../../../../src/features/fleet/catalog-api.ts';
import type { FleetClient } from '../../../../src/features/fleet/fleet-client.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

const MACHINE = {
  name: 'studio',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/bin/claude' }],
  runtimeCount: 1,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
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
  change: {
    kind: 'machine.settings',
    agentPermissions: 'skip',
    defaultRuntime: 'claude-default',
    agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  },
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
      await readFleetProfiles(profiles.client),
      await readFleetRuntimes(runtimes.client),
    ];

    // Assert
    expect(answers).toEqual([MACHINE, COMPONENTS, PROFILES, RUNTIMES]);
    expect([machine, components, profiles, runtimes].map(read => read.calls[0]?.path)).toEqual([
      FLEET_MACHINE_PATH,
      FLEET_COMPONENTS_PATH,
      FLEET_PROFILES_PATH,
      FLEET_RUNTIMES_PATH,
    ]);
  });

  it('stages a change as one named intent, never a configuration document', async () => {
    // Arrange
    const { client, calls } = clientFor(VIEW);

    // Act
    const view = await stageFleetChange(client, {
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: 'claude-default',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
    });

    // Assert
    expect(view).toEqual(VIEW);
    expect(calls[0]?.path).toBe(FLEET_PROPOSALS_PATH);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      change: {
        kind: 'machine.settings',
        agentPermissions: 'skip',
        defaultRuntime: 'claude-default',
        agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
      },
    });
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
    expect(calls[0]?.path).toBe(`${FLEET_PROPOSALS_PATH}/${CHANGE_ID}`);
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it('applies a change with an empty body: the passkey step-up is the confirmation', async () => {
    // Arrange
    const { client, calls } = clientFor(OUTCOME);

    // Act
    const outcome = await applyFleetChange(client, CHANGE_ID);

    // Assert
    expect(outcome).toEqual(OUTCOME);
    expect(calls[0]?.path).toBe(`${FLEET_PROPOSALS_PATH}/${CHANGE_ID}/apply`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({});
  });

  it('previews a draft profile as a POST of its layers', async () => {
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
      scope: { kind: 'scoped', scope: 'generic' },
    } satisfies FleetProfileDraftView;
    const { client, calls } = clientFor(draft);

    // Act
    const view = await previewFleetProfileDraft(client, { layers: [], editing: 'agent' });

    // Assert
    expect(view).toEqual(draft);
    expect(calls[0]?.path).toBe(FLEET_PROFILE_DRAFT_PATH);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ layers: [], editing: 'agent' });
  });
});
