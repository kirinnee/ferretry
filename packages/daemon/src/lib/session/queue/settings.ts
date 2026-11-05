/**
 * THE KNOBS OF COMBINED DELIVERY (docs/message-delivery.md § Labels and combined delivery), named in one
 * place so the hold set at enqueue and the decision at delivery cannot read different numbers.
 */
export interface QueueCoalesceSettings {
  /**
   * The kill switch. Off, every ferret message is treated as a blocker: delivered at once, one turn each,
   * in acceptance order — the queue as it was before labels. The label is still recorded and shown.
   */
  readonly coalesce: boolean;
  /** How long a ferret's `action` message waits for others to ride with it, from its own arrival. */
  readonly actionWindowMs: number;
  /** The longest a ferret's `fyi` message waits for its receiver's turn to end. */
  readonly fyiMaxHoldMs: number;
  /** The most messages one combined turn carries; the rest follow under the normal rules. */
  readonly batchMax: number;
}

export const defaultQueueCoalesceSettings: QueueCoalesceSettings = {
  coalesce: true,
  actionWindowMs: 60_000,
  fyiMaxHoldMs: 600_000,
  batchMax: 20,
};
