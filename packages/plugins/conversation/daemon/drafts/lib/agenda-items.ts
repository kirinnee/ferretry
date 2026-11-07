/**
 * WHERE AN ITEM'S DRAFT LIVES AND DIES: ON THE AGENDA BOARD.
 *
 * A draft for one agenda item exists while the item is open. {@link AgendaDraftSessions} answers "is this
 * item open on this session's board?" for the shared-draft service, and {@link AgendaItemDraftDiscard} is the
 * board observer that deletes an item's draft when the item closes — answered, resolved or dismissed, any
 * change that sets `addressed`. A REPLIED item is parked, not closed: it stays on the board, so it keeps its
 * draft (the send already took out what was sent).
 */
import type { AgendaId } from '../../seams/protocol.ts';
/** What a board change tells the discard: which item was closed, or that an answer rested it. */
export interface AgendaBoardChange {
  readonly change: string;
  readonly item?: { readonly id: string } | undefined;
  readonly addressed?: { readonly id: string } | undefined;
}

/** Told after a durable board change. */
export interface AgendaChangeObserver {
  changed(sessionId: string, change: AgendaBoardChange): Promise<void>;
}
import type { SharedDraftSessionDirectory } from './types.ts';

/** The one thing the draft service needs from an agenda ledger: which entries are on the board, and whether each is open. */
export interface AgendaItemLedgers {
  read(sessionId: string): Promise<{
    readonly entries: readonly { readonly lifecycle: string; readonly item: { readonly id: string } }[];
  } | null>;
}

/** A session directory that also knows which agenda items are open on a session. */
export class AgendaDraftSessions implements SharedDraftSessionDirectory {
  constructor(
    private readonly sessions: Pick<SharedDraftSessionDirectory, 'has'>,
    private readonly ledgers: AgendaItemLedgers,
  ) {}

  async has(sessionId: string): Promise<boolean> {
    return await this.sessions.has(sessionId);
  }

  async hasOpenItem(sessionId: string, item: AgendaId): Promise<boolean> {
    const ledger = await this.ledgers.read(sessionId);
    return ledger?.entries.some(entry => entry.lifecycle === 'active' && entry.item.id === item) ?? false;
  }
}

/** Deletes an item's draft with the item. Total: a failure leaves a stale file that counts toward the cap, never a refused change. */
export class AgendaItemDraftDiscard implements AgendaChangeObserver {
  constructor(private readonly drafts: { discard(sessionId: string, item: AgendaId): Promise<void> }) {}

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    // An answer that rested the item sent what the draft held, so it goes too; a chat reply keeps it (above).
    const id = change.addressed?.id ?? (change.change === 'answered' ? change.item?.id : undefined);
    if (id === undefined) return;
    await this.drafts.discard(sessionId, id).catch(() => undefined);
  }
}
