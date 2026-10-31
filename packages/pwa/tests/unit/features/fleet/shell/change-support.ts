/** A scripted daemon for the change suites: one answer (or failure) per path, every call recorded. */

import type {
  FleetAccountChangeOutcome,
  FleetAccountChangeView,
  FleetMachineAuthority,
  FleetMachineView,
} from '@ferretry/protocol';
import type { z } from 'zod';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';

const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

/** What this caller may do, as `GET /v1/fleet/machine` carries it. */
const authority = (overrides: Partial<FleetMachineAuthority> = {}): FleetMachineAuthority => ({
  mayApply: true,
  applyRefusal: 'granted',
  ...overrides,
});

/** `GET /v1/fleet/machine` with the given authority: where every change suite reads what it may do. */
export const machineAnswer = (overrides: Partial<FleetMachineAuthority> = {}): FleetMachineView => ({
  name: 'studio-mac',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  tools: [],
  runtimeCount: 1,
  runningSessions: 0,
  authority: authority(overrides),
});

export const STAGED: FleetAccountChangeView = {
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
  preview: { kind: 'apply', operations: [], documents: [], runtimes: [] },
};

export const OUTCOME: FleetAccountChangeOutcome = {
  outcome: 'executed',
  executor: 'setup',
  summary: 'Imported this machine’s setup',
};

export interface Call {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type Answer = unknown | Error | ((call: Call) => unknown);

/**
 * Answers by path: `/v1/fleet/machine`, `/v1/fleet/proposals`,
 * `/v1/fleet/proposals/<id>/apply`. A path with no answer fails like an unreachable machine.
 */
export const scriptedClient = (answers: Readonly<Record<string, Answer>>, calls: Call[] = []): FleetClient => ({
  request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const call: Call = {
      path,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (!(path in answers)) throw new Error(`no route ${path}`);
    const answer = answers[path];
    const value = typeof answer === 'function' ? (answer as (call: Call) => unknown)(call) : answer;
    if (value instanceof Error) throw value;
    return schema.parse(value);
  },
});

export const APPLY_PATH = `/v1/fleet/proposals/${CHANGE_ID}/apply`;
