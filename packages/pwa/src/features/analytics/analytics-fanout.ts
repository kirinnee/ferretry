/**
 * ONE QUESTION TO EVERY MACHINE. Analytics live on each daemon, so a fleet-wide figure is read from
 * every paired machine through its own pairing and merged in the browser.
 *
 * A machine that does not answer is not a zero: every read settles on its own, its outcome is reported
 * beside the figures ("2 of 3 machines answered — Mac mini: timed out"), and nothing it would have
 * contributed is assumed. Outcomes arrive one at a time, so a page can show the machines that answered
 * while a slow one — waiting for its unlock, say — is still out.
 *
 * AND EVERY MACHINE IS BOUNDED ON ITS OWN. A machine that never answers — asleep behind a relay that
 * still holds the socket, parked behind an unlock nobody will give — used to keep the merged answer, and
 * so the whole Query page, on "querying" forever. Past {@link MACHINE_READ_DEADLINE_MS} its read is a
 * failure like any other ("did not answer within 20s") and the machines that answered are shown.
 *
 * Nothing here knows a transport: the caller hands in the function that reads one machine.
 */

import { AnalyticsMergeError, type AnalyticsResponse, mergeAnalyticsResponses } from '@ferretry/protocol';

import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import {
  type DeadlineSchedule,
  MACHINE_READ_DEADLINE_MS,
  realSchedule,
  withDeadline,
} from '../../lib/machine-deadline.ts';
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

/** How long each machine may take, and the timer that says so; injected only by tests. */
export interface MachineDeadline {
  readonly deadlineMs?: number;
  readonly schedule?: DeadlineSchedule;
}

/**
 * Reads every machine at once. `onOutcome` hears each machine as it settles; the promise resolves with
 * every outcome, in the machines' order, once the last one has — and the last one settles by its
 * deadline at the latest, so no machine can hold the others' answer hostage.
 */
export const readEveryMachine = async <T>(
  machines: readonly AnalyticsMachine[],
  read: (connection: DaemonConnection) => Promise<T>,
  onOutcome: (outcome: MachineOutcome<T>) => void = () => {},
  { deadlineMs = MACHINE_READ_DEADLINE_MS, schedule = realSchedule }: MachineDeadline = {},
): Promise<readonly MachineOutcome<T>[]> =>
  await Promise.all(
    machines.map(async (machine): Promise<MachineOutcome<T>> => {
      const outcome: MachineOutcome<T> = await withDeadline(read(machine.connection), deadlineMs, schedule).then(
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

/** What decides whether two answers merge: their kind, aggregation, metric and grouping. */
const answerShape = (response: AnalyticsResponse): string =>
  JSON.stringify([
    response.kind,
    response.kind === 'aggregate' ? response.aggregation : null,
    response.parsed.metric ?? null,
    response.parsed.groupBy,
  ]);

/**
 * The answers in the order they merge: the MOST COMMON shape first (the earliest machine breaking a
 * tie), the rest after it. Seeding from whichever machine happens to come first would let one machine on
 * an older build turn every other machine into "cannot be merged".
 */
const mergeOrder = <T extends { readonly value: AnalyticsResponse }>(answers: readonly T[]): readonly T[] => {
  const counts = new Map<string, number>();
  for (const answer of answers) counts.set(answerShape(answer.value), (counts.get(answerShape(answer.value)) ?? 0) + 1);
  const common = answers.reduce<string | undefined>((best, answer) => {
    const shape = answerShape(answer.value);
    return best === undefined || counts.get(shape)! > counts.get(best)! ? shape : best;
  }, undefined);
  return [
    ...answers.filter(answer => answerShape(answer.value) === common),
    ...answers.filter(answer => answerShape(answer.value) !== common),
  ];
};

/**
 * Asks EVERY machine one query and merges the answers with the protocol's `mergeAnalyticsResponses`.
 *
 * The answers merge ONE AT A TIME, from the most common shape (`mergeOrder`), so an answer that cannot
 * be merged with the rest (a machine on an older build answering a different shape) becomes that
 * machine's failure rather than discarding every machine's answer. Each machine's own `machine` value is kept as it answered: it is the value a
 * `{machine=…}` matcher is compared with on that machine, so what is shown can be typed back.
 * Fails only when no machine answered, with the first machine's reason.
 */
export const askEveryMachine = async (
  machines: readonly AnalyticsMachine[],
  request: AnalyticsRequest,
  query: string | undefined,
  deadline: MachineDeadline = {},
): Promise<FleetAnswer> => {
  const outcomes = await readEveryMachine(
    machines,
    async connection => await request(connection, query),
    () => {},
    deadline,
  );
  const failed: MachineFailure[] = outcomes.flatMap(outcome => (outcome.status === 'failed' ? [outcome] : []));
  const origin = new Map<string, DaemonId>();
  let merged: AnalyticsResponse | undefined;
  const answered = outcomes.flatMap(outcome => (outcome.status === 'answered' ? [outcome] : []));
  for (const outcome of mergeOrder(answered)) {
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
