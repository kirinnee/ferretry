/**
 * THE OPEN INBOX ITEM'S COMPOSER — the chat's own `Composer`, bound to the ferret that asked, so what the owner
 * types under an item in the Inbox is exactly what they would have typed under it in the chat:
 *
 * - IT GOES TO THAT FERRET'S CHAT, ABOUT THE ITEM: the message carries the item's reference (`!A5 …`) through the
 *   same `withReferencePrefix` the chat's "about !A5" chip uses, so the daemon delivers it as `[re !A5 …]`.
 * - IT IS THE SAME DRAFT: drafts are kept per conversation, so a word typed here is there when the chat opens, and
 *   a quick reply tapped on the item takes it as its note (`agenda-inbox-page.tsx`).
 *
 * A FORM ITEM'S Send answers the form: `answerForm` (the page's) combines the picks on the card with what is typed, and
 * the message is not sent as chat. It may throw the one sentence the composer shows (empty fields, asked once).
 *
 * The client is the host's (one per paired machine); until it is ready the composer is not drawn.
 */

import type { AgendaId, SessionView } from '@ferretry/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Composer, type ComposerProps } from '../../components/composer.tsx';
import { useOptionalSessionQuota } from '../../hooks/use-usage.ts';
import { withFormSend } from '../../lib/agenda-form-send.ts';
import { useFormChanges } from '../../lib/agenda-form-state.ts';
import { withReferencePrefix } from '../../lib/answer-chip.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonUsageStore } from '../../lib/usage-store.ts';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';

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
  /** The open form's picks key: a changed pick clears the "not answered yet" line under the box. */
  readonly formKey?: string | undefined;
  readonly autocompleteFetcher?: ComposerProps['autocompleteFetcher'];
  readonly enterKeyPreference?: ComposerProps['enterKeyPreference'];
  /** This device's dictation settings, the chat composer's own: present, the box carries the same mic. */
  readonly dictationSettings?: ComposerProps['dictationSettings'];
  readonly phoneEnterKeyPreference?: ComposerProps['phoneEnterKeyPreference'];
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
  const changes = useFormChanges(formKey ?? '');
  const answer = useRef(answerForm);
  answer.current = answerForm;
  const forForm = answerForm !== undefined;
  const about = useMemo(() => {
    if (api === null) return null;
    const chat = withReferencePrefix(api, () => [itemId]);
    return forForm ? withFormSend(chat, () => answer.current?.()) : chat;
  }, [api, itemId, forForm]);
  if (about === null) return null;
  return (
    <Composer
      allowEmptySend={forForm}
      {...(forForm ? { clearErrorOn: changes } : {})}
      api={about}
      compact={compact}
      daemon={connection}
      disabled={disabled}
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
