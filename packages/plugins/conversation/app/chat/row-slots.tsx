/**
 * WHERE OTHER PLUGINS DRAW INSIDE A TRANSCRIPT ROW (`contract/slots.ts`): the chat says which daemon and ferret it is
 * drawing once, and each row mounts the panels contributed to a Conversation slot with its entry. Outside a chat that
 * provided them (a test, a harness) the slots draw nothing, exactly as a slot no plugin contributed to.
 */
import { PanelSlot } from '@ferretry/app';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { ConversationRowProps, ConversationSlot } from '../../contract/index.ts';
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

/** Every panel contributed to `slot`, for this row. */
export function RowSlot({ slot, entry }: { readonly slot: ConversationSlot; readonly entry: TranscriptEntry }) {
  const place = useContext(RowSlotContext);
  if (place === null) return null;
  const props: ConversationRowProps = { entry };
  return <PanelSlot daemon={place.daemon} props={{ ...props }} slot={slot} subject={place.ferret} />;
}
