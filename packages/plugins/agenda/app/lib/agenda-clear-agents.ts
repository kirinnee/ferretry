/**
 * "Clear all from agent ferrets", across every machine: the browser's half of `POST /v1/agenda/clear-agents`
 * (docs/agenda.md § Clearing the agent ferrets' backlog).
 *
 * Each machine is asked for a dry run first and then, once the owner confirms, to do it. One that did not answer is
 * listed as unreachable. Every request goes through the client the page passes (this half's own) and carries no
 * credential.
 */

import { AgendaClearAgentsResultSchema } from '../wire/index.ts';
import { type AgendaCall, agendaCall, requestIdHeaders } from './agenda-call.ts';
import { AGENDA_CLEAR_AGENTS } from './agenda-wire.ts';
import type { DaemonConnection, DaemonId } from './machine.ts';

/** One paired machine the clear may reach. */
export interface ClearTarget {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly connection: DaemonConnection;
}

/**
 * What the clear needs from the app: the client that reaches a machine. A half's client reaches its own machine only, so
 * a machine with no client here is listed as unreachable rather than asked through another machine's client.
 */
export interface ClearPort {
  readonly clientFor: (target: ClearTarget) => AgendaCall | undefined;
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
  port: ClearPort,
  dryRun: boolean,
): Promise<{ readonly cleared: number; readonly ferrets: number }> => {
  const client = port.clientFor(target);
  if (client === undefined) throw new Error(`${target.name} is not reachable from here`);
  return AgendaClearAgentsResultSchema.parse(
    await agendaCall(client, AGENDA_CLEAR_AGENTS, {
      body: dryRun ? { dryRun: true } : {},
      headers: requestIdHeaders(),
    }),
  );
};

const previewOne = async (target: ClearTarget, port: ClearPort): Promise<ClearRow> => {
  try {
    const counted = await clearRequest(target, port, true);
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
      const done = await clearRequest(row.target, port, false);
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
