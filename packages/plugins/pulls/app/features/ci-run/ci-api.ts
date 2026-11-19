/**
 * CI run page, the wire half (r9 E9): the two reads E8's daemon answers, parsed whole by E1's `CiRunSchema` so a shape the
 * daemon did not mean is refused here instead of drawn wrong. Nothing is cached in this folder: a read is one call.
 */
import type { ReadPress } from '@ferretry/app/ui';
import { z } from 'zod';
import { type CiRun, CiRunSchema } from '../../../contract/wire.ts';
import { repoSegment } from '../../../contract/repo-segment.ts';
import type { RepoRef } from '../../../contract/wire.ts';

/** The one client call this folder uses. */
export interface CiClient {
  call<Answer = unknown>(
    route: string,
    init?: {
      readonly params?: Readonly<Record<string, string>>;
      readonly query?: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
      readonly quiet?: boolean;
    },
  ): Promise<Answer>;
}

export const RUNS_ROUTE = 'GET /v1/pulls/:project/:repo/runs';
export const RUN_ROUTE = 'GET /v1/pulls/:project/:repo/runs/:runId';

/** What the runs of: a pull request's head commit, or a branch's. */
export type CiTarget = { readonly pr: number } | { readonly branch: string };

/** A project's repository, as every E route names it. */
export interface CiScope {
  readonly project: string;
  readonly repo: Pick<RepoRef, 'owner' | 'name'>;
}

const RunsSchema = z.array(CiRunSchema).max(256);

export const fetchRuns = async (
  client: CiClient,
  scope: CiScope,
  target: CiTarget,
  signal?: AbortSignal,
  press: ReadPress = {},
): Promise<readonly CiRun[]> =>
  RunsSchema.parse(
    await client.call(RUNS_ROUTE, {
      params: { project: scope.project, repo: repoSegment(scope.repo) },
      query: 'pr' in target ? { pr: String(target.pr) } : { branch: target.branch },
      // A poll the page makes on its own never raises a passkey prompt; a Try again's `press` (`quiet: false`) may.
      quiet: true,
      ...(signal === undefined ? {} : { signal }),
      ...press,
    }),
  );

export const fetchRun = async (
  client: CiClient,
  scope: CiScope,
  runId: number,
  attempt?: number,
  signal?: AbortSignal,
  press: ReadPress = {},
): Promise<CiRun> =>
  CiRunSchema.parse(
    await client.call(RUN_ROUTE, {
      params: { project: scope.project, repo: repoSegment(scope.repo), runId: String(runId) },
      ...(attempt === undefined ? {} : { query: { attempt: String(attempt) } }),
      quiet: true,
      ...(signal === undefined ? {} : { signal }),
      ...press,
    }),
  );

/** What a failed read says, in the daemon's own words; a budget pause also says until when (ISO), so the screen says it once. */
export interface CiFailure {
  readonly message: string;
  readonly pausedUntil?: string;
}

export function failureOf(cause: unknown): CiFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  const body = (cause as { readonly body?: unknown } | null)?.body;
  const until =
    typeof body === 'object' && body !== null ? (body as { readonly pausedUntil?: unknown }).pausedUntil : undefined;
  return typeof until === 'string' && Number.isFinite(Date.parse(until))
    ? { message, pausedUntil: until }
    : { message };
}
