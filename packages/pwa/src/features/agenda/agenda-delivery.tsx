/**
 * WHERE THE OWNER'S ANSWER STANDS, drawn where the owner looks for it: on the card, and in the pinned panel.
 *
 * An answer is DONE only when the ferret has it (docs/agenda.md § Delivery), so the board says two
 * things this file draws and nothing else:
 *
 * - "Sending…": the daemon holds the answer (`replies.pending`) or has handed it over and not yet seen it
 *   arrive (`delivery.sending`). It is the same words in both cases — the owner cannot act on the
 *   difference — and it goes when the daemon stops listing the item.
 * - "Your answer didn't reach <ferret>": the item is open again (`undelivered`), with the answer it was
 *   given, so Retry sends exactly that again. It is the same action the answer was, through the same client:
 *   the card holds no transport (`onAct`), and the host decides whether an undo window comes first.
 *
 * The strip reads the panel's facts through {@link AgendaDeliveryContext} rather than new props on the
 * card: the card stays the one component every place draws, and a place that provides no context (the
 * inbox's deck, whose answered cards leave it at once) simply has no "Sending…" to say.
 */

import { type AgendaId, type AgendaItem, type AgendaSnapshot, agendaTitle, hasOwnTitle } from '@ferretry/protocol';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { createContext, useContext } from 'react';
import { type InboxAction, undeliveredAction } from '../../lib/agenda-answers.ts';
import { Button } from '../../shell/primitives.tsx';

/** What the strip needs beyond the item itself, provided by the host that knows the board. */
export interface AgendaDeliveryState {
  /** Items whose answer is held or on its way to the ferret. */
  readonly sending: ReadonlySet<AgendaId>;
  /** The ferret's spoken name, for hosts whose card has no origin to name it. */
  readonly ferret?: string;
}

const NOTHING_SENDING: AgendaDeliveryState = { sending: new Set() };

export const AgendaDeliveryContext = createContext<AgendaDeliveryState>(NOTHING_SENDING);

/** The ids whose answer is held for the settle window or handed to the ferret and not yet proven. */
export const deliveringIds = (snapshot: AgendaSnapshot | null): ReadonlySet<AgendaId> =>
  new Set([...(snapshot?.replies?.pending ?? []), ...(snapshot?.delivery?.sending ?? [])]);

/** The heading a card shows for an item: its own title, or its whole ask for an item from before titles. */
export const agendaHeading = (item: Pick<AgendaItem, 'subject' | 'title'>): string =>
  hasOwnTitle(item) ? agendaTitle(item) : item.subject.trim();

export interface AgendaDeliveryProps {
  readonly item: AgendaItem;
  /** The ferret's name when the card knows it (the inbox's origin); else the host's, else "the ferret". */
  readonly ferret?: string | undefined;
  /** An answer for this card is already on its way: Retry waits for it. */
  readonly busy?: boolean;
  readonly onAct: (action: InboxAction) => void;
}

/** Under the card's header: "Sending…", or "Your answer didn't reach <ferret> — answer again or Retry". */
export function AgendaDelivery({ item, ferret, busy = false, onAct }: AgendaDeliveryProps) {
  const state = useContext(AgendaDeliveryContext);
  const name = ferret ?? state.ferret ?? 'the ferret';
  if (state.sending.has(item.id))
    return (
      <p className="fy-attn-delivery" data-agenda-delivery="sending" role="status">
        <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
        Sending…
      </p>
    );
  const { undelivered } = item;
  if (undelivered === undefined) return null;
  return (
    <div className="fy-attn-delivery" data-agenda-delivery="undelivered" data-tone="err" role="alert">
      <TriangleAlert aria-hidden="true" size={14} />
      <span className="fy-attn-delivery__text">
        Your answer didn&apos;t reach {name} — answer again or retry.
        <span className="fy-attn-delivery__reason"> {undelivered.reason}</span>
      </span>
      <Button
        data-agenda-retry=""
        disabled={busy}
        onClick={() => onAct(undeliveredAction(undelivered.reply))}
        size="sm"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}
