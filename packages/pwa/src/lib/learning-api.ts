import {
  FY_REQUEST_ID_HEADER,
  type LearningActionRequest,
  type LearningPatchResponse,
  LearningPatchResponseSchema,
  type LearningStatus,
  LearningStatusSchema,
  type ProposalState,
  type ProposalView,
  ProposalViewSchema,
  type RunManifest,
  RunManifestSchema,
} from '@ferretry/protocol';

import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const errorFor = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const requestLearning = async <Value>(
  daemon: DaemonConnection,
  path: string,
  schema: { parse(value: unknown): Value },
  init: RequestInit = {},
  fetcher: DaemonFetch = fetch,
): Promise<Value> => {
  const request = daemonRequest(daemon, path, init);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await errorFor(response);
  return schema.parse(await response.json());
};

/** Every learning request is bound to the explicitly paired daemon. */
export const fetchLearningStatus = (daemon: DaemonConnection, fetcher: DaemonFetch = fetch): Promise<LearningStatus> =>
  requestLearning(daemon, '/v1/learning/status', LearningStatusSchema, {}, fetcher);

export const fetchLearningProposals = (
  daemon: DaemonConnection,
  state?: ProposalState,
  fetcher: DaemonFetch = fetch,
): Promise<readonly ProposalView[]> =>
  requestLearning(
    daemon,
    `/v1/learning/proposals${state === undefined ? '' : `?state=${encodeURIComponent(state)}`}`,
    { parse: value => ProposalViewSchema.array().parse(value) },
    {},
    fetcher,
  );

const mutation = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
  body: JSON.stringify(body),
});

export const actOnLearningProposal = (
  daemon: DaemonConnection,
  id: string,
  action: LearningActionRequest,
  fetcher: DaemonFetch = fetch,
): Promise<ProposalView> =>
  requestLearning(
    daemon,
    `/v1/learning/proposals/${encodeURIComponent(id)}`,
    ProposalViewSchema,
    mutation(action),
    fetcher,
  );

export const fetchLearningPatch = (
  daemon: DaemonConnection,
  id: string,
  fetcher: DaemonFetch = fetch,
): Promise<LearningPatchResponse> =>
  requestLearning(
    daemon,
    `/v1/learning/proposals/${encodeURIComponent(id)}/patch`,
    LearningPatchResponseSchema,
    mutation({}),
    fetcher,
  );

export const runLearningScan = (
  daemon: DaemonConnection,
  spawn = false,
  fetcher: DaemonFetch = fetch,
): Promise<RunManifest> => requestLearning(daemon, '/v1/learning/run', RunManifestSchema, mutation({ spawn }), fetcher);
