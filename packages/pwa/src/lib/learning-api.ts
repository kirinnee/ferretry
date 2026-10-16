/**
 * The browser's half of the Learning routes (docs/learning.md).
 *
 * Every call takes the paired daemon and the fetch to reach it through, and nothing is cached at module
 * scope: a lesson belongs to a MACHINE, and one browser can be paired to several. The fetch a screen
 * passes is the carrier router's (`useDaemonFetch`), so a daemon only the relay reaches is reached, and a
 * repo write a remote device must confirm with a passkey (`403 grant_step_up_required`) is asked for and
 * resent by the router itself — nothing here carries a credential.
 *
 * Accepting a lesson never writes a file. Applying one is two calls: the preview (the diff and the etag
 * that pins it), then the write with that etag, which the daemon refuses with `409 apply_conflict` if the
 * file moved in between.
 */

import {
  FY_REQUEST_ID_HEADER,
  LEARNING_APPLY_CONFLICT_CODE,
  type LearningActionRequest,
  type LearningApplyPreview,
  LearningApplyPreviewSchema,
  type LearningConfig,
  type LearningConfigPatch,
  LearningConfigSchema,
  type LearningScanEstimate,
  LearningScanEstimateSchema,
  type LearningScanProgress,
  LearningScanProgressSchema,
  type LearningScanRequest,
  type LearningScanView,
  LearningScanViewSchema,
  type LearningStatus,
  LearningStatusSchema,
  type ProposalState,
  type ProposalView,
  ProposalViewSchema,
  type SessionLearning,
  type SessionLearningPatchResult,
  SessionLearningPatchResultSchema,
  SessionLearningSchema,
} from '@ferretry/protocol';

import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const ProposalViewListSchema = ProposalViewSchema.array();
const SessionLearningListSchema = SessionLearningSchema.array();

const errorFor = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** A JSON body with a fresh request id, so a retried write is recognisably the same write. */
const jsonBody = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
  body: JSON.stringify(body),
});

/**
 * One learning call. The path comes before the schema and the init so each caller's verb is stated at
 * the call itself (`scripts/validate/route-agreement.ts` reads it there).
 */
const learningCall = async <Value>(
  fetcher: DaemonFetch,
  daemon: DaemonConnection,
  path: string,
  schema: { parse(value: unknown): Value },
  init: RequestInit = {},
): Promise<Value> => {
  const request = daemonRequest(daemon, path, init);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await errorFor(response);
  return schema.parse(await response.json());
};

export const fetchLearningStatus = (daemon: DaemonConnection, fetcher: DaemonFetch): Promise<LearningStatus> =>
  learningCall(fetcher, daemon, '/v1/learning/status', LearningStatusSchema);

export const fetchLearningConfig = (daemon: DaemonConnection, fetcher: DaemonFetch): Promise<LearningConfig> =>
  learningCall(fetcher, daemon, '/v1/learning/config', LearningConfigSchema);

/** Writes the machine default into `learning.yaml`; the daemon keeps the file's comments. */
export const patchLearningConfig = (
  daemon: DaemonConnection,
  patch: LearningConfigPatch,
  fetcher: DaemonFetch,
): Promise<LearningConfig> =>
  learningCall(fetcher, daemon, '/v1/learning/config', LearningConfigSchema, { method: 'PATCH', ...jsonBody(patch) });

/** Every lesson, or those in one state. */
export const fetchLearningProposals = (
  daemon: DaemonConnection,
  fetcher: DaemonFetch,
  state?: ProposalState,
): Promise<readonly ProposalView[]> =>
  learningCall(
    fetcher,
    daemon,
    `/v1/learning/proposals${state === undefined ? '' : `?state=${encodeURIComponent(state)}`}`,
    ProposalViewListSchema,
  );

export const actOnLearningProposal = (
  daemon: DaemonConnection,
  id: string,
  action: LearningActionRequest,
  fetcher: DaemonFetch,
): Promise<ProposalView> =>
  learningCall(fetcher, daemon, `/v1/learning/proposals/${encodeURIComponent(id)}`, ProposalViewSchema, {
    method: 'POST',
    ...jsonBody(action),
  });

/** Exactly what Apply will write, and the etag that pins it. Reads only. */
export const fetchApplyPreview = (
  daemon: DaemonConnection,
  id: string,
  fetcher: DaemonFetch,
): Promise<LearningApplyPreview> =>
  learningCall(
    fetcher,
    daemon,
    `/v1/learning/proposals/${encodeURIComponent(id)}/apply-preview`,
    LearningApplyPreviewSchema,
  );

/** Writes the previewed diff, only if the file still has the previewed etag. */
export const applyLearningProposal = (
  daemon: DaemonConnection,
  id: string,
  etag: string,
  fetcher: DaemonFetch,
): Promise<ProposalView> =>
  learningCall(fetcher, daemon, `/v1/learning/proposals/${encodeURIComponent(id)}/apply`, ProposalViewSchema, {
    method: 'POST',
    ...jsonBody({ etag }),
  });

/** The daemon refused an apply because the file moved since its preview. */
export const isApplyConflict = (reason: unknown): boolean =>
  reason instanceof DaemonResponseError && reason.status === 409 && reason.code === LEARNING_APPLY_CONFLICT_CODE;

/** Which ferrets are instructed to file lessons. */
export const fetchSessionLearning = (
  daemon: DaemonConnection,
  fetcher: DaemonFetch,
): Promise<readonly SessionLearning[]> =>
  learningCall(fetcher, daemon, '/v1/learning/sessions', SessionLearningListSchema);

/** Switches one ferret; a running one is re-instructed with a queued message that costs it a turn. */
export const patchSessionLearning = (
  daemon: DaemonConnection,
  sessionId: string,
  passive: boolean,
  fetcher: DaemonFetch,
): Promise<SessionLearningPatchResult> =>
  learningCall(
    fetcher,
    daemon,
    `/v1/sessions/${encodeURIComponent(sessionId)}/learning`,
    SessionLearningPatchResultSchema,
    { method: 'PATCH', ...jsonBody({ passive }) },
  );

/** What a scan would read and cost. Spends nothing. */
export const estimateLearningScan = (
  daemon: DaemonConnection,
  request: LearningScanRequest,
  fetcher: DaemonFetch,
): Promise<LearningScanEstimate> =>
  learningCall(fetcher, daemon, '/v1/learning/scan/estimate', LearningScanEstimateSchema, {
    method: 'POST',
    ...jsonBody(request),
  });

/** Starts a scan. Only ever called from the Start button, after an estimate was on screen. */
export const startLearningScan = (
  daemon: DaemonConnection,
  request: LearningScanRequest,
  fetcher: DaemonFetch,
): Promise<LearningScanProgress> =>
  learningCall(fetcher, daemon, '/v1/learning/scan', LearningScanProgressSchema, {
    method: 'POST',
    ...jsonBody(request),
  });

export const fetchLearningScan = (daemon: DaemonConnection, fetcher: DaemonFetch): Promise<LearningScanView> =>
  learningCall(fetcher, daemon, '/v1/learning/scan', LearningScanViewSchema);

export const cancelLearningScan = (daemon: DaemonConnection, fetcher: DaemonFetch): Promise<LearningScanProgress> =>
  learningCall(fetcher, daemon, '/v1/learning/scan/cancel', LearningScanProgressSchema, {
    method: 'POST',
    ...jsonBody({}),
  });

/** A failure as one sentence a reader can act on. */
export const learningErrorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'Learning is unavailable on this daemon.';
