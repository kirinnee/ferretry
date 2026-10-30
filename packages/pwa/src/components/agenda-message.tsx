/**
 * AN AGENDA MESSAGE, DRAWN AS WHAT IT IS.
 *
 * The owner's answer from an agenda card, a request for more information, a wish to talk an item through
 * and the owner's own chat message about items all reach the ferret as ordinary chat messages the daemon
 * words — `[answer to !A45 «ask»] Button only` — and a bubble of that raw text is hard to read: the bracket
 * and the long quoted ask bury the answer. So a message the protocol reads as agenda forms
 * (`parseAgendaMessage`, the one reader of the one writer) is drawn as a compact card per form instead:
 *
 *   * a header row — what happened (`Answered`, `Reply`, `Discussing`, …) and the item's reference chip,
 *     which is the reference grammar's own `!A45` proved and opened exactly as everywhere else;
 *   * the item's title, muted and clamped: from the item when the board still holds it, else the ask
 *     the message quoted;
 *   * the owner's words, prominent — and a choice they picked (an option, an approval) as a selected pill.
 *
 * NOTHING IS HIDDEN. The text the ferret actually received stays one tap away ("Show sent text") and can
 * be copied whole; the card is a reading of it, never a replacement.
 *
 * Anything the reader does not recognise is drawn as it always was (`fallback`).
 */

import {
  type AgendaMessageKind,
  type AgendaMessagePart,
  type AgendaItem,
  type AgendaSnapshot,
  agendaTitle,
  parseAgendaMessage,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';
import { Check } from 'lucide-react';
import { createContext, type ReactNode, useContext, useId, useMemo, useState } from 'react';
import { browserClipboardWriter, type ClipboardWriter, CopyButton } from '../features/onboarding/copy-button.tsx';
import { Markdown } from './markdown.tsx';
import { useReferenceSurface } from './reference-surface.tsx';

/** An item as the agenda holds it, open or resolved. */
type AgendaItemOrResolved = AgendaItem | ResolvedAgendaItem;

/** Finds an item of this session's agenda by id; `undefined` when the board is unread or does not hold it. */
export type AgendaItemLookup = (id: string) => AgendaItemOrResolved | undefined;

const AgendaItemsContext = createContext<AgendaItemLookup>(() => undefined);

/**
 * The session's agenda, for the cards in its conversation. Absent, every card falls back to the ask its
 * message quoted and draws an answer as words: a board not read yet is not a board without the item.
 */
export function AgendaItemsProvider({
  snapshot,
  children,
}: {
  readonly snapshot: AgendaSnapshot | null | undefined;
  readonly children: ReactNode;
}) {
  const lookup = useMemo((): AgendaItemLookup => {
    const byId = new Map<string, AgendaItemOrResolved>(
      snapshot == null ? [] : [...snapshot.resolved, ...snapshot.items].map(item => [item.id, item]),
    );
    return id => byId.get(id);
  }, [snapshot]);
  return <AgendaItemsContext.Provider value={lookup}>{children}</AgendaItemsContext.Provider>;
}

/** What each form says happened, as the card's header names it. */
export const AGENDA_KIND_LABEL: Readonly<Record<AgendaMessageKind, string>> = {
  answer: 'Answered',
  done: 'Done',
  dismissed: 'Dismissed',
  'needs-info': 'Needs more info',
  discuss: 'Discussing',
  re: 'Reply',
};

/**
 * Whether an answer is a CHOICE — drawn as the selected option rather than as words: the option the owner
 * picked, an approval or rejection, or a plain "Done". A written answer stays words.
 */
export const isChosenAnswer = (part: AgendaMessagePart, item: AgendaItemOrResolved | undefined): boolean => {
  if (part.kind !== 'answer') return false;
  if (part.text === 'Done') return true;
  const response = item !== undefined && 'response' in item ? item.response : undefined;
  if (response?.kind === 'permission') return true;
  if (response?.kind === 'multiple-choice') return response.choice === part.text;
  return item?.ask?.kind === 'multiple-choice' && item.ask.options.some(option => option.label === part.text);
};

/** The `!A45` chip: the reference grammar's own token, so it is proved and opened like every other reference. */
function AgendaReferenceChip({ id }: { readonly id: string }) {
  const surface = useReferenceSurface();
  return (
    <div className="fy-agenda-msg-chip" data-agenda-item={id}>
      <Markdown text={`!${id}`} {...surface} />
    </div>
  );
}

function AgendaPart({ part }: { readonly part: AgendaMessagePart }) {
  const lookup = useContext(AgendaItemsContext);
  const items = part.items.map(named => ({ named, item: lookup(named.id) }));
  const first = items[0]?.item;
  const chosen = isChosenAnswer(part, first);
  return (
    <section className="fy-agenda-msg-part" data-agenda-kind={part.kind}>
      <header className="fy-agenda-msg-head">
        <span className="fy-agenda-msg-kind">{AGENDA_KIND_LABEL[part.kind]}</span>
        {items.map(({ named }) => (
          <AgendaReferenceChip id={named.id} key={named.id} />
        ))}
      </header>
      {items.map(({ named, item }) => (
        <p className="fy-agenda-msg-title" key={named.id}>
          {item === undefined ? named.quote : agendaTitle(item)}
        </p>
      ))}
      {part.text === '' ? null : chosen ? (
        <p className="fy-agenda-msg-choice">
          <span className="fy-agenda-msg-option">
            <Check aria-hidden="true" size={14} strokeWidth={2.5} />
            <span>{part.text}</span>
          </span>
        </p>
      ) : (
        <p className="fy-agenda-msg-text">{part.text}</p>
      )}
      {part.note === undefined ? null : (
        <p className="fy-agenda-msg-note">
          <span className="fy-agenda-msg-note-label">Note:</span> {part.note}
        </p>
      )}
    </section>
  );
}

/**
 * The owner's message as agenda cards when it is one — a single form or a batch — else `fallback`.
 * `write` is the clipboard the "copy sent text" control writes through; the browser's by default.
 */
export function AgendaMessageOr({
  text,
  fallback,
  write = browserClipboardWriter(),
}: {
  readonly text: string;
  readonly fallback: ReactNode;
  readonly write?: ClipboardWriter;
}) {
  const message = useMemo(() => parseAgendaMessage(text), [text]);
  const [raw, setRaw] = useState(false);
  const rawId = useId();
  if (message === undefined) return <>{fallback}</>;
  return (
    <div className="fy-agenda-msg" data-agenda-message={message.parts.length > 1 ? 'batch' : 'single'}>
      {message.parts.map(part => (
        <AgendaPart key={part.raw} part={part} />
      ))}
      <div className="fy-agenda-msg-raw-bar">
        <button
          aria-controls={rawId}
          aria-expanded={raw}
          className="fy-agenda-msg-raw-toggle"
          onClick={() => setRaw(open => !open)}
          type="button"
        >
          {raw ? 'Hide sent text' : 'Show sent text'}
        </button>
        <CopyButton label="Copy the sent text" text={text} write={write} />
      </div>
      {raw ? (
        <pre className="fy-agenda-msg-raw" id={rawId}>
          {text}
        </pre>
      ) : null}
    </div>
  );
}
