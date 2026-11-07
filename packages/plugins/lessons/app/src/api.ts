/**
 * The browser's half of the lesson routes (docs/lessons.md).
 *
 * Every call goes through the generated per-daemon client (§9.6): it carries the carrier, the contract-hash guard and a
 * repo write a remote device must confirm with a passkey (`403 grant_step_up_required`) is asked for and resent by the
 * client itself, so nothing here carries a credential. Nothing is cached at module scope: a lesson belongs to a daemon.
 *
 * Accepting a lesson never writes a file. Applying one is two calls: the preview (the diff and the etag that pins it),
 * then the write with that etag, which the daemon refuses with `409 apply_conflict` if the file moved in between.
 */

import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  LESSONS_APPLY_CONFLICT_CODE,
  type LessonsFerret,
  LessonsFerretSchema,
  type FerretLessons,
  type FerretLessonsPatchResult,
  FerretLessonsPatchResultSchema,
  FerretLessonsSchema,
  type LessonsActionRequest,
  type LessonsApplyPreview,
  LessonsApplyPreviewSchema,
  type LessonsConfig,
  type LessonsConfigPatch,
  type LessonsGlobalDocument,
  LessonsGlobalDocumentSchema,
  LessonsConfigSchema,
  type LessonsScanEstimate,
  LessonsScanEstimateSchema,
  type LessonsScanProgress,
  LessonsScanProgressSchema,
  type LessonsScanRequest,
  type LessonsScanView,
  LessonsScanViewSchema,
  type ProposalState,
  type ProposalView,
  ProposalViewSchema,
} from '../../contract/index.ts';

/** What every call needs: the client bound to the daemon on screen. */
export interface LessonsConnection {
  /** A stable identity for the daemon on screen: a switch of daemon starts a view from nothing. */
  readonly key: string;
  readonly client: Pick<PluginClient, 'call'>;
}

const ProposalViewListSchema = ProposalViewSchema.array();
const FerretLessonsListSchema = FerretLessonsSchema.array();

/** One call, its answer parsed against the wire schema the daemon's own contract states. */
const lessonsCall = async <Value>(
  connection: LessonsConnection,
  route: string,
  schema: { parse(value: unknown): Value },
  init: {
    readonly params?: Record<string, string>;
    readonly query?: Record<string, string>;
    readonly body?: unknown;
  } = {},
): Promise<Value> => schema.parse(await connection.client.call(route, init));

export const fetchLessonsConfig = (connection: LessonsConnection): Promise<LessonsConfig> =>
  lessonsCall(connection, 'GET /v1/lessons/config', LessonsConfigSchema);

/** Asks the daemon to write the machine default into `lessons.yaml`; answers the settings in effect afterwards. */
export const patchLessonsConfig = (connection: LessonsConnection, patch: LessonsConfigPatch): Promise<LessonsConfig> =>
  lessonsCall(connection, 'PATCH /v1/lessons/config', LessonsConfigSchema, { body: patch });

/** The Global lessons document every ferret reads, and the etag a rewrite names. */
export const fetchGlobalLessons = (connection: LessonsConnection): Promise<LessonsGlobalDocument> =>
  lessonsCall(connection, 'GET /v1/lessons/global', LessonsGlobalDocumentSchema);

/** Rewrites the whole Global document (how an applied Global lesson is changed or removed); `409` if it moved. */
export const putGlobalLessons = (
  connection: LessonsConnection,
  text: string,
  etag: string,
): Promise<LessonsGlobalDocument> =>
  lessonsCall(connection, 'PUT /v1/lessons/global', LessonsGlobalDocumentSchema, { body: { text, etag } });

/** Every lesson, or those in one state. */
export const fetchLessonsProposals = (
  connection: LessonsConnection,
  state?: ProposalState,
): Promise<readonly ProposalView[]> =>
  lessonsCall(
    connection,
    'GET /v1/lessons/proposals',
    ProposalViewListSchema,
    state === undefined ? {} : { query: { state } },
  );

export const actOnLessonsProposal = (
  connection: LessonsConnection,
  id: string,
  action: LessonsActionRequest,
): Promise<ProposalView> =>
  lessonsCall(connection, 'POST /v1/lessons/proposals/:id', ProposalViewSchema, { params: { id }, body: action });

/** Exactly what Apply will write, and the etag that pins it. Reads only. */
export const fetchApplyPreview = (connection: LessonsConnection, id: string): Promise<LessonsApplyPreview> =>
  lessonsCall(connection, 'GET /v1/lessons/proposals/:id/apply-preview', LessonsApplyPreviewSchema, {
    params: { id },
  });

/** Writes the previewed diff, only if the file still has the previewed etag. */
export const applyLessonsProposal = (connection: LessonsConnection, id: string, etag: string): Promise<ProposalView> =>
  lessonsCall(connection, 'POST /v1/lessons/proposals/:id/apply', ProposalViewSchema, {
    params: { id },
    body: { etag },
  });

/** The daemon refused an apply because the file moved since its preview. */
export const isApplyConflict = (reason: unknown): boolean =>
  reason instanceof DaemonCallError && reason.status === 409 && reason.code === LESSONS_APPLY_CONFLICT_CODE;

/** Which ferrets are instructed to file lessons. */
export const fetchFerretLessons = (connection: LessonsConnection): Promise<readonly FerretLessons[]> =>
  lessonsCall(connection, 'GET /v1/lessons/ferrets', FerretLessonsListSchema);

/** Switches one ferret; a running one is re-instructed with a queued message that costs it a turn. */
export const patchFerretLessons = (
  connection: LessonsConnection,
  ferretId: string,
  passive: boolean,
): Promise<FerretLessonsPatchResult> =>
  lessonsCall(connection, 'PATCH /v1/ferrets/:ferretId/lessons', FerretLessonsPatchResultSchema, {
    params: { ferretId },
    body: { passive },
  });

/** What a scan would read and cost. Spends nothing. */
export const estimateLessonsScan = (
  connection: LessonsConnection,
  request: LessonsScanRequest,
): Promise<LessonsScanEstimate> =>
  lessonsCall(connection, 'POST /v1/lessons/scan/estimate', LessonsScanEstimateSchema, { body: request });

/** Starts a scan. Only ever called from the Start button, after an estimate was on screen. */
export const startLessonsScan = (
  connection: LessonsConnection,
  request: LessonsScanRequest,
): Promise<LessonsScanProgress> =>
  lessonsCall(connection, 'POST /v1/lessons/scan', LessonsScanProgressSchema, { body: request });

export const fetchLessonsScan = (connection: LessonsConnection): Promise<LessonsScanView> =>
  lessonsCall(connection, 'GET /v1/lessons/scan', LessonsScanViewSchema);

export const cancelLessonsScan = (connection: LessonsConnection): Promise<LessonsScanProgress> =>
  lessonsCall(connection, 'POST /v1/lessons/scan/cancel', LessonsScanProgressSchema, { body: {} });

/** A failure as one sentence a reader can act on. */
export const lessonsErrorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'Lessons are unavailable on this daemon.';

/** The ferrets the screens name: ids, names and the folders they run in. */
export const fetchLessonsFerrets = (connection: LessonsConnection): Promise<readonly LessonsFerret[]> =>
  lessonsCall(connection, 'GET /v1/lessons/directory', LessonsFerretSchema.array());
