/** A scripted daemon for the change suites: one answer (or failure) per path, every call recorded. */

import type { FleetAccountChangeOutcome, FleetAccountChangeView, FleetPermissions } from '@ferretry/protocol';
import type { z } from 'zod';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-api.ts';

export const UNLOCK_TOKEN = `fy_unlock_${'A'.repeat(22)}`;
const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

export const permissions = (overrides: Partial<FleetPermissions> = {}): FleetPermissions => ({
  mayInspect: true,
  mayPropose: true,
  mayApply: true,
  applyRefusal: 'granted',
  confirmation: 'none',
  ...overrides,
});

export const STAGED: FleetAccountChangeView = {
  id: CHANGE_ID,
  revision: 'absent',
  change: { kind: 'machine.settings', agentPermissions: 'skip' },
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

export const UNLOCKED = { token: UNLOCK_TOKEN, expiresAt: '2026-10-13T09:00:00.000Z', ttlSeconds: 300 };

export interface Call {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type Answer = unknown | Error | ((call: Call) => unknown);

/**
 * Answers by path: `/v1/fleet/permissions`, `/v1/grants/unlock`, `/v1/fleet/changes`,
 * `/v1/fleet/changes/<id>/apply`. A path with no answer fails like an unreachable machine.
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

export const APPLY_PATH = `/v1/fleet/changes/${CHANGE_ID}/apply`;
