/**
 * "Clear all from agent ferrets", across every machine: the browser's half of `POST /v1/agenda/clear-agents`
 * (docs/agenda.md § Clearing the agent ferrets' backlog).
 *
 * Each machine is asked for a dry run first and then, once the owner confirms, to do it. One that did not answer is
 * listed as unreachable. Every request goes through the fetch a screen passes (`useDaemonFetch`) and carries no
 * credential.
 */

import { AgendaClearAgentsResultSchema } from '../wire/index.ts';
import { FY_REQUEST_ID_HEADER } from '../shell.ts';
import type { DaemonConnection, DaemonId } from '../shell.ts';
import { type DaemonFetch, DaemonResponseError, daemonRequest } from '../shell.ts';

/** One paired machine the clear may reach. */
export interface ClearTarget {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly connection: DaemonConnection;
}

/** What the clear needs from the app: the fetch to send with. */
export interface ClearPort {
  readonly fetcher: DaemonFetch;
}

/** What one machine said to the dry run. */
type ClearRow =
  | {
      readonly kind: 'ready';
      readonly name: string;
      readonly target: ClearTarget;
      readonly count: number;
      readonly ferrets: number;
    }
  | { readonly kind: 'unreachable'; readonly name: string };

export interface ClearPreview {
  readonly rows: readonly ClearRow[];
  /** Open asks the clear would dismiss, over every machine that answered. */
  readonly total: number;
}

/** What the clear did, in the words the result view prints. */
export interface ClearOutcome {
  readonly cleared: number;
  readonly ferrets: number;
  readonly unreachable: readonly string[];
}

const clearRequest = async (
  target: ClearTarget,
  fetcher: DaemonFetch,
  dryRun: boolean,
): Promise<{ readonly cleared: number; readonly ferrets: number }> => {
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
  try {
    const counted = await clearRequest(target, port.fetcher, true);
    return { kind: 'ready', name: target.name, target, count: counted.cleared, ferrets: counted.ferrets };
  } catch {
    return { kind: 'unreachable', name: target.name };
  }
};

/** Asks every machine how many open asks its agent ferrets hold, without dismissing any. */
export const previewClearAgents = async (targets: readonly ClearTarget[], port: ClearPort): Promise<ClearPreview> => {
  const rows = await Promise.all(targets.map(target => previewOne(target, port)));
  const total = rows.reduce((sum, row) => sum + (row.kind === 'ready' ? row.count : 0), 0);
  return { rows, total };
};

/** Dismisses the agent ferrets' open asks on every machine the preview found able, and says what happened. */
export const clearAgentsEverywhere = async (preview: ClearPreview, port: ClearPort): Promise<ClearOutcome> => {
  let cleared = 0;
  let ferrets = 0;
  const unreachable: string[] = [];
  for (const row of preview.rows) {
    if (row.kind !== 'ready') continue;
    try {
      const done = await clearRequest(row.target, port.fetcher, false);
      cleared += done.cleared;
      ferrets += done.ferrets;
    } catch {
      unreachable.push(row.name);
    }
  }
  return {
    cleared,
    ferrets,
    unreachable: [...preview.rows.filter(row => row.kind === 'unreachable').map(row => row.name), ...unreachable],
  };
};
