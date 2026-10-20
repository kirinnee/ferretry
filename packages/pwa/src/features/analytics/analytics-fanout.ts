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

import { type AnalyticsResponse, mergeAnalyticsResponses } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
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

/**
 * Names one machine's answer as the app names the machine: every raw row's `machine`, and a `machine`
 * group label. Two machines that share a host name then stay two rows of "by machine", and a row can be
 * traced back to the machine it came from.
 */
export const stampMachine = (response: AnalyticsResponse, name: string): AnalyticsResponse =>
  response.kind === 'raw'
    ? { ...response, results: response.results.map(row => ({ ...row, machine: name })) }
    : {
        ...response,
        results: response.results.map(result =>
          'machine' in result.labels ? { ...result, labels: { ...result.labels, machine: name } } : result,
        ),
      };

/**
 * A request that asks EVERY machine the same query and answers with one merged response
 * (`mergeAnalyticsResponses`). `onFailures` hears, after each run, the machines that did not answer;
 * when none did, the run fails with the first machine's reason.
 */
export const requestAcrossMachines =
  (
    machines: readonly AnalyticsMachine[],
    request: AnalyticsRequest,
    onFailures: (failed: readonly Extract<MachineOutcome<AnalyticsResponse>, { status: 'failed' }>[]) => void,
  ): AnalyticsRequest =>
  async (_connection, query) => {
    const outcomes = await readEveryMachine(machines, async connection => await request(connection, query));
    const failed = outcomes.flatMap(outcome => (outcome.status === 'failed' ? [outcome] : []));
    const answered = outcomes.flatMap(outcome =>
      outcome.status === 'answered' ? [stampMachine(outcome.value, outcome.machine.name)] : [],
    );
    onFailures(failed);
    if (answered.length === 0) throw new Error(failed[0]?.error ?? 'no machine to ask');
    return mergeAnalyticsResponses(answered);
  };
