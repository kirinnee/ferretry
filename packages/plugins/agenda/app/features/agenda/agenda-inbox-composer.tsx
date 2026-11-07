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
 */

import type { AgendaId } from '../../wire/index.ts';
import type { SessionView } from '../../shell.ts';
import { useEffect, useMemo, useState } from 'react';
import { Composer, type ComposerProps, type ComposerSent } from '../../shell.ts';
import { useOptionalSessionQuota } from '../../shell.ts';
import { useFormComposer } from '../../lib/agenda-form-send.ts';
import { withReferencePrefix } from '../../lib/answer-chip.ts';
import type { DaemonConnection } from '../../shell.ts';
import type { DaemonUsageStore } from '../../shell.ts';
import { sessionsBarNames } from '../../shell.ts';

/** The ferret the reply goes to, as the sidebar names it. */
const ferretName = (view: SessionView): string => {
  const names = sessionsBarNames(view);
  return names.ferret ?? names.title;
};

export interface AgendaInboxComposerProps {
  readonly connection: DaemonConnection;
  /** The ferret's conversation: the composer writes to it, and its account's usage is shown as in the chat. */
  readonly view: SessionView;
  /** The host's usage readings; absent, the composer says the usage is unknown. */
  readonly usage?: DaemonUsageStore | undefined;
  /** The open item: every message sent from here is about it. */
  readonly itemId: AgendaId;
  /** The machine's client; the host keeps one per machine. */
  readonly clientFor: (connection: DaemonConnection) => Promise<ComposerProps['api']>;
  /** Phone chrome. */
  readonly compact: boolean;
  readonly disabled?: boolean;
  /** The open item is a form: Send runs this instead of chatting, even with an empty box. */
  readonly answerForm?: (() => void) | undefined;
  /** The open form's picks key: a changed pick clears the "nothing to send" line under the box. */
  readonly formKey?: string | undefined;
  readonly autocompleteFetcher?: ComposerProps['autocompleteFetcher'];
  readonly enterKeyPreference?: ComposerProps['enterKeyPreference'];
  /** This device's dictation settings, the chat composer's own: present, the box carries the same mic. */
  readonly dictationSettings?: ComposerProps['dictationSettings'];
  readonly phoneEnterKeyPreference?: ComposerProps['phoneEnterKeyPreference'];
  /** A chat message about the item was accepted. Not called for a form's answer. */
  readonly onReplied?: ((sent: ComposerSent) => void) | undefined;
  /** The words of a reply that was taken back, for the box; `onRestored` fires once they are in. */
  readonly restore?: string | undefined;
  readonly onRestored?: (() => void) | undefined;
}

export function AgendaInboxComposer({
  connection,
  view,
  usage,
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
  const quota = useOptionalSessionQuota(usage, connection, view);
  const [client, setClient] = useState<{ readonly daemonId: string; readonly api: ComposerProps['api'] } | null>(null);
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
  const api = client?.daemonId === connection.daemonId ? client.api : null;
  const chat = useMemo(() => (api === null ? null : withReferencePrefix(api, () => [itemId])), [api, itemId]);
  const form = useFormComposer(chat, answerForm, formKey);
  const forForm = form.allowEmptySend;
  if (form.api === null) return null;
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
      quota={quota}
      sessionId={view.config.id}
      {...(autocompleteFetcher === undefined ? {} : { autocompleteFetcher })}
    />
  );
}
