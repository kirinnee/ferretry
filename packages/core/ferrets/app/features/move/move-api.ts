/**
 * The daemon calls behind the move page, each by its route key through the half's own client: the ferret read, the
 * move, the ask that clears an agent's own background jobs, and the two calls of a conversion (the preview read and
 * the move onto the other CLI). Every answer is PARSED with the contract's schema, so a body this page cannot read is
 * a failed read rather than a claim about the ferret.
 *
 * A move kills a pane and relaunches it, and the client retries a POST on transport failure, so the move carries the
 * request id the daemon needs to recognise a retry of the same act (`missing_request_id` otherwise).
 */

import {
  type AskToStopJobsResult,
  AskToStopJobsResultSchema,
  type ConversionPreview,
  ConversionPreviewRequestSchema,
  ConversionPreviewSchema,
  type FerretSummary,
  FerretSummarySchema,
  type MoveConversation,
  MoveSessionRequestSchema,
} from '../../../contract/index.ts';
import type { FerretsClient } from '../../lib/client.ts';
import type { MoveTarget } from './move-model.ts';

const FERRET_ROUTE = 'GET /v1/ferrets/:ferretId';
const MOVE_ROUTE = 'POST /v1/ferrets/:ferretId/move';
const ASK_TO_STOP_JOBS_ROUTE = 'POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs';
const CONVERSION_PREVIEW_ROUTE = 'POST /v1/ferrets/:ferretId/conversion-preview';

/** The answer was not the shape the contract says. Carries no daemon text: a raw parse dump says nothing to a person. */
export class UnreadableAnswerError extends Error {
  constructor(readonly route: string) {
    super('the daemon answered with a body this page cannot read');
    this.name = 'UnreadableAnswerError';
  }
}

const parsed = <T>(route: string, result: { success: true; data: T } | { success: false }): T => {
  if (!result.success) throw new UnreadableAnswerError(route);
  return result.data;
};

export const readFerret = async (client: FerretsClient, ferret: string): Promise<FerretSummary> =>
  parsed(
    FERRET_ROUTE,
    FerretSummarySchema.safeParse(await client.call(FERRET_ROUTE, { params: { ferretId: ferret } })),
  );

const moveBody = (target: MoveTarget, forceInflight: boolean, conversation?: MoveConversation): unknown =>
  MoveSessionRequestSchema.parse({
    agent: target.agent,
    ...(target.model === undefined ? {} : { model: target.model }),
    allowContextDowngrade: target.allowContextDowngrade,
    forceInflight,
    ...(conversation === undefined ? {} : { conversation }),
  });

/** Moves the ferret onto `target` on its own CLI. Nothing changes when it throws. */
export const moveFerret = async (
  client: FerretsClient,
  ferret: string,
  target: MoveTarget,
  requestId: string,
): Promise<FerretSummary> =>
  parsed(
    MOVE_ROUTE,
    FerretSummarySchema.safeParse(
      await client.call(MOVE_ROUTE, {
        params: { ferretId: ferret },
        body: moveBody(target, false),
        headers: { 'x-fy-request-id': requestId },
      }),
    ),
  );

/** The one remedy of a refusal whose blockers are all the agent's own background jobs: ask the agent. */
export const askToStopJobs = async (client: FerretsClient, ferret: string): Promise<AskToStopJobsResult> =>
  parsed(
    ASK_TO_STOP_JOBS_ROUTE,
    AskToStopJobsResultSchema.safeParse(await client.call(ASK_TO_STOP_JOBS_ROUTE, { params: { ferretId: ferret } })),
  );

/** Asks what moving the ferret onto `agent` (the other CLI) would carry, or why it cannot. A read: no request id. */
export const readConversionPreview = async (
  client: FerretsClient,
  ferret: string,
  agent: string,
): Promise<ConversionPreview> =>
  parsed(
    CONVERSION_PREVIEW_ROUTE,
    ConversionPreviewSchema.safeParse(
      await client.call(CONVERSION_PREVIEW_ROUTE, {
        params: { ferretId: ferret },
        body: ConversionPreviewRequestSchema.parse({ agent }),
      }),
    ),
  );

/**
 * Moves the ferret onto `agent` of the OTHER CLI, converting its conversation into that CLI's own format. The daemon
 * runs the target CLI once to prove it opens the converted file, so this can take a little while. `forceInflight`
 * is only ever set after the person confirmed it.
 */
export const moveToOtherHarness = async (
  client: FerretsClient,
  ferret: string,
  agent: string,
  requestId: string,
  forceInflight: boolean,
): Promise<FerretSummary> =>
  parsed(
    MOVE_ROUTE,
    FerretSummarySchema.safeParse(
      await client.call(MOVE_ROUTE, {
        params: { ferretId: ferret },
        body: moveBody({ agent, allowContextDowngrade: false }, forceInflight, 'convert'),
        headers: { 'x-fy-request-id': requestId },
      }),
    ),
  );
