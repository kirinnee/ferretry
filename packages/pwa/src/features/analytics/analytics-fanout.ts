/**
 * ONE QUESTION TO EVERY MACHINE. Analytics live on each daemon, so a fleet-wide figure is read from
 * every paired machine through its own pairing and merged in the browser.
 *
 * A machine that does not answer is not a zero: every read settles on its own, its outcome is reported
 * beside the figures ("2 of 3 machines answered — Mac mini: timed out"), and nothing it would have
 * contributed is assumed. Outcomes arrive one at a time, so a page can show the machines that answered
 * while a slow one — waiting for its unlock, say — is still out.
 *
 * Nothing here knows a transport: the caller hands in the function that reads one machine.
 */

import { AnalyticsMergeError, type AnalyticsResponse, mergeAnalyticsResponses } from '@ferretry/protocol';

import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import type { AnalyticsRequest } from './analytics-custom-query.tsx';
import { analyticsErrorMessage } from './analytics-response-view.tsx';

/** A paired machine, with the name the app shows for it. */
export interface AnalyticsMachine {
  readonly connection: DaemonConnection;
  readonly name: string;
}

export type MachineOutcome<T> =
  | { readonly machine: AnalyticsMachine; readonly status: 'answered'; readonly value: T }
  | { readonly machine: AnalyticsMachine; readonly status: 'failed'; readonly error: string };

/**
 * Reads every machine at once. `onOutcome` hears each machine as it settles; the promise resolves with
 * every outcome, in the machines' order, once the last one has.
 */
export const readEveryMachine = async <T>(
  machines: readonly AnalyticsMachine[],
  read: (connection: DaemonConnection) => Promise<T>,
  onOutcome: (outcome: MachineOutcome<T>) => void = () => {},
): Promise<readonly MachineOutcome<T>[]> =>
  await Promise.all(
    machines.map(async (machine): Promise<MachineOutcome<T>> => {
      const outcome: MachineOutcome<T> = await read(machine.connection).then(
        value => ({ machine, status: 'answered', value }),
        (reason: unknown) => ({ machine, status: 'failed', error: analyticsErrorMessage(reason) }),
      );
      onOutcome(outcome);
      return outcome;
    }),
  );

/** "2 of 3 machines" — or nothing at all when there is only one machine to ask. */
export const machinesSummary = (outcomes: readonly MachineOutcome<unknown>[], expected: number): string | null => {
  if (expected <= 1) return null;
  const answered = outcomes.filter(outcome => outcome.status === 'answered').length;
  return answered === expected ? `all ${expected} machines` : `${answered} of ${expected} machines`;
};

/** A machine that did not answer, or answered in a form the others' answers cannot be merged with. */
export type MachineFailure = Extract<MachineOutcome<unknown>, { readonly status: 'failed' }>;

/** One query's answer from every machine: the merged response, who is missing from it, and where each session lives. */
export interface FleetAnswer {
  readonly response: AnalyticsResponse;
  readonly failed: readonly MachineFailure[];
  /** The machine a session row of the response came from, by session id. */
  readonly daemonOf: (sessionId: string) => DaemonId | undefined;
}

/**
 * Asks EVERY machine one query and merges the answers with the protocol's `mergeAnalyticsResponses`.
 *
 * The answers merge ONE AT A TIME, so an answer that cannot be merged with the rest (a machine on an
 * older build answering a different shape) becomes that machine's failure rather than discarding every
 * machine's answer. Each machine's own `machine` value is kept as it answered: it is the value a
 * `{machine=…}` matcher is compared with on that machine, so what is shown can be typed back.
 * Fails only when no machine answered, with the first machine's reason.
 */
export const askEveryMachine = async (
  machines: readonly AnalyticsMachine[],
  request: AnalyticsRequest,
  query: string | undefined,
): Promise<FleetAnswer> => {
  const outcomes = await readEveryMachine(machines, async connection => await request(connection, query));
  const failed: MachineFailure[] = outcomes.flatMap(outcome => (outcome.status === 'failed' ? [outcome] : []));
  const origin = new Map<string, DaemonId>();
  let merged: AnalyticsResponse | undefined;
  for (const outcome of outcomes) {
    if (outcome.status !== 'answered') continue;
    try {
      merged = merged === undefined ? outcome.value : mergeAnalyticsResponses([merged, outcome.value]);
    } catch (reason) {
      if (!(reason instanceof AnalyticsMergeError)) throw reason;
      failed.push({
        machine: outcome.machine,
        status: 'failed',
        error: `its answer cannot be merged with the others (${reason.message}).`,
      });
      continue;
    }
    if (outcome.value.kind === 'raw')
      for (const row of outcome.value.results) origin.set(row.id, outcome.machine.connection.daemonId);
  }
  if (merged === undefined) throw new Error(failed[0]?.error ?? 'there is no machine to ask');
  return { response: merged, failed, daemonOf: sessionId => origin.get(sessionId) };
};
