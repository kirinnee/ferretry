/**
 * A send whose message WAS typed into the agent's box, and which the agent never showed there in time.
 *
 * The daemon types it once, settles it unconfirmed, and answers `send_unconfirmed` with the send's id, so
 * the composer keeps the person's text and offers the three things that finish the job.
 */

import { unconfirmedSendId } from '../../contract/index.ts';
import { DaemonCallError } from './seam.ts';

/** The send a `send_unconfirmed` answer names, or `undefined` for any other failure. */
export const unconfirmedSendOf = (cause: unknown): string | undefined =>
  cause instanceof DaemonCallError && cause.status === 409 ? unconfirmedSendId(cause.body) : undefined;

/** What a person can do about an unconfirmed send, each acting on exactly that send. */
export type UnconfirmedAction = 'submit' | 'clear' | 'retry';

/** What the notice says when a retry came back unconfirmed again. */
export const STILL_UNCONFIRMED_LINE = 'Still not showing in the agent’s box. Open the terminal to check it.';
