/** Why a send or an interrupt could not be acted on. */
export type SessionSendFailure =
  /** The id is not one the state-home layout would accept, or the request is otherwise unusable. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** The session's own condition refuses it: a quarantine, an unconfirmed kill, an open question. */
  | 'refused'
  /** A launch is still in flight. Pending rather than failed — the caller retries. */
  | 'pending'
  /**
   * It was typed into the agent's composer and nothing proved it landed. Neither refused nor failed:
   * answered as `send_unconfirmed` with the send's id, so the app can act on exactly that send.
   */
  | 'unconfirmed'
  /** It was acted on, and the work it does — typing, reviving, journalling — failed. */
  | 'failed';

/** A refusal raised by the composition root's send handling, in a taxonomy `src/lib` may name. */
export class SessionSendError extends Error {
  constructor(
    readonly failure: SessionSendFailure,
    message: string,
    /**
     * The person's own text the agent's composer is holding, when that is why the send was refused:
     * answered as `composer_occupied` with this draft, so the app can offer to send or clear it.
     */
    readonly draft?: string,
    /** The send an `unconfirmed` answer is about. */
    readonly sendId?: string,
  ) {
    super(message);
    this.name = 'SessionSendError';
  }
}
