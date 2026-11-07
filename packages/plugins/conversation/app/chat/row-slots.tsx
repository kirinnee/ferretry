/**
 * WHERE OTHER PLUGINS DRAW INSIDE A TRANSCRIPT ROW (`contract/slots.ts`): the chat says which daemon and ferret it is
 * drawing once, and each row mounts the panels contributed to a Conversation slot with its entry. Outside a chat that
 * provided them (a test, a harness) the slots draw nothing, exactly as a slot no plugin contributed to.
 */
import { PanelSlot } from '@ferretry/app';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { ConversationRowEntry, ConversationRowProps, ConversationSlot } from '../../contract/index.ts';
import type { TranscriptEntry } from './transcript-entries.ts';

interface RowSlotPlace {
  readonly daemon: string;
  readonly ferret: string;
}

const RowSlotContext = createContext<RowSlotPlace | null>(null);

export function RowSlotProvider({
  daemon,
  ferret,
  children,
}: {
  readonly daemon: string;
  readonly ferret: string;
  readonly children: ReactNode;
}) {
  const place = useMemo(() => ({ daemon, ferret }), [daemon, ferret]);
  return <RowSlotContext.Provider value={place}>{children}</RowSlotContext.Provider>;
}

/**
 * What a contributing plugin may see of a row: ONLY the fields `ConversationRowEntry` names, and only for a row whose
 * words came from the daemon's reading of this ferret's transcript, which is masked there (a value Vault masks is
 * masked in the text). A `ledger` row is this device's own record of a send that has not landed, or never will (a
 * refused send stays in the outbox): its text is what was typed here, before any daemon masked it, so it is never
 * offered to a slot. Nothing else of the row (the send, the ledger record, the peer, the tool calls) leaves this file.
 */
export function rowSlotEntry(entry: TranscriptEntry): ConversationRowEntry | null {
  if (entry.kind === 'ledger') return null;
  return {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    ...(entry.at === undefined ? {} : { at: entry.at }),
    ...(entry.label === undefined ? {} : { label: entry.label }),
  };
}

/** Every panel contributed to `slot`, for this row; none for a row that is only on this device. */
export function RowSlot({ slot, entry }: { readonly slot: ConversationSlot; readonly entry: TranscriptEntry }) {
  const place = useContext(RowSlotContext);
  const offered = rowSlotEntry(entry);
  if (place === null || offered === null) return null;
  const props: ConversationRowProps = { entry: offered };
  return <PanelSlot daemon={place.daemon} props={{ ...props }} slot={slot} subject={place.ferret} />;
}
