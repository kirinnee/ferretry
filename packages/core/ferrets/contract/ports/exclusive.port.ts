import type { FerretId } from '@ferretry/kernel/contract';

/** The ferret's one mutation queue, lent to the Mailbox so a typed send is never interleaved with a start, stop or resume. */
export interface ExclusiveApi {
  /**
   * Additive (Mailbox's alone): runs `work` on the ferret's ONE per-ferret mutation queue, the one a start, a stop, a resume,
   * a token cut-off and a runtime switch run on, so a message typed into the pane (an answer to an ask included) never lands
   * between two keys of a stop or on a pane a resume is replacing. The queue is NOT re-entrant: `work` must not call
   * `start`, `stop`, `resume` or anything else that takes the same ferret's queue (a send that revives a stopped ferret runs
   * its `resume` OUTSIDE this call). Any other consumer is refused with a 403 `forbidden`. Unbound only in a unit fixture:
   * a caller then runs `work` itself.
   */
  exclusive?<T>(ferret: FerretId, work: () => Promise<T>): Promise<T>;
}
