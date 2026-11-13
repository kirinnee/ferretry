import { isTerminalHandoverPhase } from './policy.ts';
import type { RememberedHandoverRoster } from './reconcile.ts';
import type { HandoverReceipt, HandoverReceiptStore } from './types.ts';

/**
 * The receipt store, remembering which receipts are open so the reconciler need not read them all.
 *
 * WHY MEMORY IS ENOUGH. The handover service is the only writer of a receipt, and it writes every one
 * through this store; so after one full read, the open set changes only by writes this store sees — a
 * receipt opening or reaching a terminal phase — or by a session directory removed underneath it, which
 * a read answering `null` reports. Nothing else in Ferretry writes `handover.json`.
 *
 * A READ THAT RACES A WRITE. A full read lists and reads directories one by one, so a receipt written
 * while it runs may be read before or after the write. Writes made during a read are therefore applied
 * over its answer, and the newest word on a receipt is always the write.
 *
 * A DAMAGED RECEIPT still fails the full read, exactly as the file store does: the reconciler reports
 * it, and nothing is remembered until a read succeeds.
 */
export class RememberedHandoverReceipts implements HandoverReceiptStore, RememberedHandoverRoster {
  /** Which receipts are open, once a full read has said; `undefined` until then, or once forgotten. */
  #open: Set<string> | undefined;
  /** Writes made while a full read runs, by session: whether each left its receipt open. */
  #during: Map<string, boolean> | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly store: HandoverReceiptStore) {}

  async read(sourceSessionId: string): Promise<HandoverReceipt | null> {
    const receipt = await this.store.read(sourceSessionId);
    if (receipt === null) this.#note(sourceSessionId, false);
    return receipt;
  }

  async write(receipt: HandoverReceipt): Promise<void> {
    await this.store.write(receipt);
    const open = !isTerminalHandoverPhase(receipt.phase);
    this.#note(receipt.sourceSessionId, open);
    if (open) for (const listener of [...this.#listeners]) listener();
  }

  async pendingSourceSessionIds(): Promise<readonly string[]> {
    if (this.#open === undefined) {
      const during = new Map<string, boolean>();
      this.#during = during;
      try {
        const open = new Set(await this.store.pendingSourceSessionIds());
        for (const [id, stillOpen] of during) {
          if (stillOpen) open.add(id);
          else open.delete(id);
        }
        this.#open = open;
      } finally {
        if (this.#during === during) this.#during = undefined;
      }
    }
    return [...this.#open];
  }

  anyOpen(): boolean {
    return (this.#open?.size ?? 0) > 0;
  }

  onOpened(listener: () => void): () => void {
    const own = (): void => listener();
    this.#listeners.add(own);
    return () => this.#listeners.delete(own);
  }

  forget(): void {
    this.#open = undefined;
  }

  #note(sourceSessionId: string, open: boolean): void {
    this.#during?.set(sourceSessionId, open);
    if (open) this.#open?.add(sourceSessionId);
    else this.#open?.delete(sourceSessionId);
  }
}
