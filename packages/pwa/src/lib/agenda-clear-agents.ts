/**
 * "Clear all from agent ferrets", across every machine: the browser's half of `POST /v1/agenda/clear-agents`
 * (docs/agenda.md § Clearing the agent ferrets' backlog).
 *
 * The app ships before the daemon, so each machine's health is read first and only a machine that offers
 * `agenda.clear-agents.1` is sent anything. One that answered without the name is listed as "needs an update";
 * one that did not answer is listed as unreachable — the app cannot tell an old machine from a slow one.
 * Every request goes through the fetch a screen passes (`useDaemonFetch`) and carries no credential.
 */

import {
  AgendaClearAgentsResultSchema,
  DAEMON_FEATURES,
  FY_REQUEST_ID_HEADER,
  HealthViewSchema,
} from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type DaemonHealthRead, machineLacks, machineOffers } from './daemon-health.ts';
import { daemonRequest } from './daemon-transport.ts';
import { UPDATE_MACHINE_WHERE } from './machine-update-words.ts';
import { type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** One paired machine the clear may reach. */
export interface ClearTarget {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly connection: DaemonConnection;
}

/** What the clear needs from the app: a way to read a machine's health, and the fetch to send with. */
export interface ClearPort {
  readonly readHealth: (connection: DaemonConnection) => Promise<DaemonHealthRead>;
  readonly fetcher: DaemonFetch;
}

/** The app's clear port: health read through the client it builds for each machine (a failed read is not an old machine). */
export const agendaClearPort = (
  clients: { readonly client: (connection: DaemonConnection) => Promise<Pick<FyApiClient, 'request'>> },
  fetcher: DaemonFetch,
): ClearPort => ({
  fetcher,
  readHealth: async connection =>
    await clients
      .client(connection)
      .then(async client => await client.request('/v1/health', HealthViewSchema))
      .then(
        (health): DaemonHealthRead => ({ kind: 'read', health }),
        (): DaemonHealthRead => ({ kind: 'failed' }),
      ),
});

/** What one machine said to the dry run. */
type ClearRow =
  | {
      readonly kind: 'ready';
      readonly name: string;
      readonly target: ClearTarget;
      readonly count: number;
      readonly sessions: number;
    }
  | { readonly kind: 'needs-update'; readonly name: string }
  | { readonly kind: 'unreachable'; readonly name: string };

export interface ClearPreview {
  readonly rows: readonly ClearRow[];
  /** Open items the clear would dismiss, over every machine that can do it. */
  readonly total: number;
}

/** What the clear did, in the words the result view prints. */
export interface ClearOutcome {
  readonly cleared: number;
  readonly sessions: number;
  readonly needsUpdate: readonly string[];
  readonly unreachable: readonly string[];
}

export const CLEAR_NEEDS_UPDATE = `needs an update to clear: ${UPDATE_MACHINE_WHERE}`;

const clearRequest = async (
  target: ClearTarget,
  fetcher: DaemonFetch,
  dryRun: boolean,
): Promise<{ readonly cleared: number; readonly sessions: number }> => {
  const request = daemonRequest(target.connection, '/v1/agenda/clear-agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
    body: JSON.stringify(dryRun ? { dryRun: true } : {}),
  });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw new DaemonResponseError(response.status, `HTTP ${response.status}`, undefined);
  return AgendaClearAgentsResultSchema.parse(await response.json());
};

const previewOne = async (target: ClearTarget, port: ClearPort): Promise<ClearRow> => {
  const read = await port.readHealth(target.connection);
  if (machineLacks(read, DAEMON_FEATURES.agendaClearAgents)) return { kind: 'needs-update', name: target.name };
  if (!machineOffers(read, DAEMON_FEATURES.agendaClearAgents)) return { kind: 'unreachable', name: target.name };
  try {
    const counted = await clearRequest(target, port.fetcher, true);
    return { kind: 'ready', name: target.name, target, count: counted.cleared, sessions: counted.sessions };
  } catch {
    return { kind: 'unreachable', name: target.name };
  }
};

/** Asks every machine how many open items its agent ferrets hold, without dismissing any. */
export const previewClearAgents = async (targets: readonly ClearTarget[], port: ClearPort): Promise<ClearPreview> => {
  const rows = await Promise.all(targets.map(target => previewOne(target, port)));
  const total = rows.reduce((sum, row) => sum + (row.kind === 'ready' ? row.count : 0), 0);
  return { rows, total };
};

/** Dismisses the agent ferrets' open items on every machine the preview found able, and says what happened. */
export const clearAgentsEverywhere = async (preview: ClearPreview, port: ClearPort): Promise<ClearOutcome> => {
  let cleared = 0;
  let sessions = 0;
  const unreachable: string[] = [];
  for (const row of preview.rows) {
    if (row.kind !== 'ready') continue;
    try {
      const done = await clearRequest(row.target, port.fetcher, false);
      cleared += done.cleared;
      sessions += done.sessions;
    } catch {
      unreachable.push(row.name);
    }
  }
  return {
    cleared,
    sessions,
    needsUpdate: preview.rows.filter(row => row.kind === 'needs-update').map(row => row.name),
    unreachable: [...preview.rows.filter(row => row.kind === 'unreachable').map(row => row.name), ...unreachable],
  };
};
