import type { FerretSummary } from '../../../contract/ids.ts';
import type { ConversionPreview, MoveConversation } from '../../../contract/move.ts';

/**
 * The destructive, request-id-protected move call and the read that previews a cross-harness conversion before it
 * (today's `IFyApiClient.migrate` / `conversionPreview`, spelled out so the verb does not depend on the old client).
 *
 * `requestId` is the LOGICAL identity of one move, and it is what makes the route safe to retry: a move kills and
 * relaunches the pane, and a retried POST without a stable id would relaunch it twice. Omitted, one is minted per call.
 */
export interface IMoveGateway {
  move(
    id: string,
    agent: string,
    model?: string,
    allowContextDowngrade?: boolean,
    requestId?: string,
    forceInflight?: boolean,
    /** Omitted, the daemon resumes the bound conversation or refuses; see `MoveConversation`. */
    conversation?: MoveConversation,
  ): Promise<FerretSummary>;
  /** A read: nothing is written and no request id is needed. */
  conversionPreview(id: string, agent: string, model?: string): Promise<ConversionPreview>;
}
