/**
 * The `conversation.row-body` panel `agenda-message`: a person's message about agenda items (an answer from a card, a
 * reply naming `!A45`, a batch of them) drawn as its compact agenda card INSTEAD of the raw words
 * (`../components/agenda-message.tsx`). Conversation hands the row, the plain words as `fallback` and, for a send still
 * on its way, `onItsWay`; a message that is no agenda message returns `fallback` as it is, and reads nothing.
 *
 * Only a message the reader recognises (or one on its way, worded against the open items) reads the ferret's board:
 * every other row of the chat costs this panel one parse.
 */

import { parseAgendaMessage } from '@ferretry/core-asks/contract';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ConversationRowBodyProps } from '@ferretry/plugin-conversation/contract';
import { type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { AgendaItemsProvider, AgendaMessageOr, useAgendaChatReply } from '../components/agenda-message.tsx';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';
import { daemonSessionScope } from '../lib/machine.ts';

/** What the chat hands a `conversation.row-body` panel: the ferret as `subject`, the row, and the plain words. */
type RowBodyPanelProps = PanelProps &
  Partial<Omit<ConversationRowBodyProps, 'fallback'>> & { readonly fallback?: ReactNode };

/** The message as its card, worded as the ferret will receive it while it is still on its way. */
function Card({
  text,
  onItsWay,
  fallback,
}: {
  readonly text: string;
  readonly onItsWay: boolean;
  readonly fallback: ReactNode;
}) {
  const worded = useAgendaChatReply(text);
  return <AgendaMessageOr fallback={fallback} text={onItsWay ? worded : text} />;
}

/** The card with this ferret's board read behind it (its items name and title what the message answers). */
function Board({
  runtime,
  ferret,
  text,
  onItsWay,
  fallback,
}: {
  readonly runtime: AgendaRuntime;
  readonly ferret: string;
  readonly text: string;
  readonly onItsWay: boolean;
  readonly fallback: ReactNode;
}) {
  const scope = useMemo(() => daemonSessionScope(runtime.connection, ferret), [runtime.connection, ferret]);
  useEffect(() => {
    runtime.agenda.hydrate(runtime.connection, scope).catch(() => undefined);
  }, [runtime, scope]);
  const store = runtime.agenda.store;
  useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  );
  // A board not read yet is not a board without the item: the card falls back to the ask its message quoted.
  const board = store.agenda(scope) ?? null;
  return (
    <AgendaItemsProvider snapshot={board}>
      <Card fallback={fallback} onItsWay={onItsWay} text={text} />
    </AgendaItemsProvider>
  );
}

export function createAgendaMessagePanel(runtime: AgendaRuntime) {
  return function AgendaMessagePanel({ subject, entry, onItsWay = false, fallback }: RowBodyPanelProps) {
    if (fallback === undefined) return null;
    if (subject === undefined || entry === undefined) return <>{fallback}</>;
    // A message already on the log is recognised by its own words; one on its way may name an open item (`!A5 …`),
    // which only the board can word, so it reads the board whatever its words say.
    if (!onItsWay && parseAgendaMessage(entry.text) === undefined) return <>{fallback}</>;
    return <Board fallback={fallback} ferret={subject} onItsWay={onItsWay} runtime={runtime} text={entry.text} />;
  };
}
