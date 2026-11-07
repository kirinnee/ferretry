/**
 * THE OPEN INBOX ITEM'S COMPOSER — the chat's own `Composer`, bound to the ferret that asked and to THIS item's own
 * draft, so what the owner types under an item is a reply to that item and nothing else:
 *
 * - IT GOES TO THAT FERRET'S CHAT, ABOUT THE ITEM: the message carries the item's reference (`!A5 …`) through the
 *   same `withReferencePrefix` the chat's "about !A5" chip uses, so the daemon delivers it as `[re !A5 …]`.
 * - IT HAS ITS OWN DRAFT, NOT THE CHAT'S: each card keeps a draft of its own (the composer's `draftSlot`), synced
 *   across the owner's devices like the chat's but never with it. Typing here never shows in the ferret's chat box
 *   (nor what is typed there under this card), and two cards of one ferret never share a box. A quick reply tapped
 *   on the item takes THIS draft as its note (`agenda-inbox-page.tsx`). Closing the item discards its draft; a
 *   reply that leaves it open empties only what was sent.
 *
 * A REPLY MOVES THE INBOX ON: once a chat message about the item is accepted, `onReplied` tells the host (the item
 * is marked replied at once, `lib/agenda-replied.ts`). A form item's Send is an answer, not a reply, and tells nothing.
 * `restore` is the words of a reply the owner took back: they go into the box once.
 *
 * A FORM ITEM'S Send answers the form: `answerForm` (the page's) combines the picks on the card with what is typed, and
 * the message is not sent as chat. It may throw the one sentence the composer shows (empty fields, asked once).
 *
 * The client is the host's (one per paired machine); until it is ready the composer is not drawn.
 *
 * THE COMPOSER ITSELF IS CONVERSATION'S, and this half never imports it (lead decision Q9). This is the Agenda's half
 * of the reply box: which ferret, which item's draft, the `!A5` prefix, a form's Send. The box is whatever composer the
 * host puts in {@link AgendaComposerContext} — Conversation's, where it binds one — and with none bound nothing is drawn.
 * The ask screen draws the ferret's conversation through the `agenda.conversation` slot instead; this binder stays for a
 * host that hands the Inbox a composer of its own.
 */

import type { AgendaId } from '@ferretry/core-asks/contract';
import type { SessionView } from '../../shell.ts';
import { type ComponentType, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useFormComposer } from '../../lib/agenda-form-send.ts';
import { withReferencePrefix } from '../../lib/answer-chip.ts';
import type { DaemonConnection } from '../../shell.ts';
import { sessionsBarNames } from '../../lib/ferret-names.ts';

/** What the composer sends through: the ferret's chat, by id. */
export interface AgendaComposerApi {
  readonly send: (sessionId: string, request: { readonly message: string }) => Promise<unknown>;
}

/** A message the composer saw accepted: the owner's own words, and how it went. */
export interface AgendaComposerSent {
  readonly words: string;
  readonly sendId?: string | undefined;
  readonly disposition?: string | undefined;
}

/** What the Agenda hands the host's composer. */
export interface AgendaComposerProps {
  readonly api: AgendaComposerApi;
  readonly daemon: DaemonConnection;
  readonly sessionId: string;
  /** This item's own draft: never the ferret's chat box, never another item's. */
  readonly draftSlot: AgendaId;
  readonly compact: boolean;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly allowEmptySend: boolean;
  readonly clearErrorOn?: unknown;
  readonly onSent?: (sent: AgendaComposerSent) => void;
  readonly restore?: string;
  readonly onRestored?: () => void;
  readonly dictationSettings?: unknown;
  readonly enterKeyPreference: unknown;
  readonly phoneEnterKeyPreference: unknown;
  readonly autocompleteFetcher?: unknown;
}

/** The composer the host binds for the Inbox; `null` (no host composer) draws no box. */
export const AgendaComposerContext = createContext<ComponentType<AgendaComposerProps> | null>(null);

/** The ferret the reply goes to, as the sidebar names it. */
const ferretName = (view: SessionView): string => {
  const names = sessionsBarNames(view);
  return names.ferret ?? names.title;
};

export interface AgendaInboxComposerProps {
  readonly connection: DaemonConnection;
  /** The ferret's conversation: the composer writes to it. */
  readonly view: SessionView;
  /** The open item: every message sent from here is about it. */
  readonly itemId: AgendaId;
  /** The machine's client; the host keeps one per machine. */
  readonly clientFor: (connection: DaemonConnection) => Promise<AgendaComposerApi>;
  /** Phone chrome. */
  readonly compact: boolean;
  readonly disabled?: boolean;
  /** The open item is a form: Send runs this instead of chatting, even with an empty box. */
  readonly answerForm?: (() => void) | undefined;
  /** The open form's picks key: a changed pick clears the "nothing to send" line under the box. */
  readonly formKey?: string | undefined;
  readonly autocompleteFetcher?: unknown;
  readonly enterKeyPreference?: unknown;
  /** This device's dictation settings, the chat composer's own: present, the box carries the same mic. */
  readonly dictationSettings?: unknown;
  readonly phoneEnterKeyPreference?: unknown;
  /** A chat message about the item was accepted. Not called for a form's answer. */
  readonly onReplied?: ((sent: AgendaComposerSent) => void) | undefined;
  /** The words of a reply that was taken back, for the box; `onRestored` fires once they are in. */
  readonly restore?: string | undefined;
  readonly onRestored?: (() => void) | undefined;
}

export function AgendaInboxComposer({
  connection,
  view,
  itemId,
  clientFor,
  compact,
  disabled = false,
  answerForm,
  formKey,
  autocompleteFetcher,
  enterKeyPreference = null,
  dictationSettings,
  phoneEnterKeyPreference = null,
  onReplied,
  restore,
  onRestored,
}: AgendaInboxComposerProps) {
  const Composer = useContext(AgendaComposerContext);
  const [client, setClient] = useState<{ readonly daemonId: string; readonly api: AgendaComposerApi } | null>(null);
  useEffect(() => {
    let current = true;
    void clientFor(connection).then(
      api => {
        if (current) setClient({ daemonId: connection.daemonId, api });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [clientFor, connection]);
  const api: AgendaComposerApi | null = client?.daemonId === connection.daemonId ? client.api : null;
  const chat = useMemo(() => (api === null ? null : withReferencePrefix(api, () => [itemId])), [api, itemId]);
  const form = useFormComposer(chat, answerForm, formKey);
  const forForm = form.allowEmptySend;
  if (form.api === null || Composer === null) return null;
  return (
    <Composer
      allowEmptySend={forForm}
      {...(form.clearErrorOn === undefined ? {} : { clearErrorOn: form.clearErrorOn })}
      api={form.api}
      compact={compact}
      daemon={connection}
      disabled={disabled}
      draftSlot={itemId}
      {...(forForm || onReplied === undefined ? {} : { onSent: onReplied })}
      {...(restore === undefined ? {} : { restore })}
      {...(onRestored === undefined ? {} : { onRestored })}
      {...(dictationSettings === undefined ? {} : { dictationSettings })}
      enterKeyPreference={enterKeyPreference}
      phoneEnterKeyPreference={phoneEnterKeyPreference}
      placeholder={forForm ? `Anything else for ${ferretName(view)}?` : `Reply to ${ferretName(view)}…`}
      sessionId={view.config.id}
      {...(autocompleteFetcher === undefined ? {} : { autocompleteFetcher })}
    />
  );
}
