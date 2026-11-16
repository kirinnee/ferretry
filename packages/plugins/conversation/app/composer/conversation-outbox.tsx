/**
 * THE DEVICE OUTBOX FOR ONE DAEMON'S COMPOSERS. Today the app store held it, so a message saved while the machine
 * could not be reached went later even with no composer open. In 5.0 the outbox is Conversation's: the chat screen
 * (and any surface that draws a {@link Composer}) wraps itself in this, and every composer below saves a send on this
 * device first and hands it to the daemon second. Without it a composer sends straight away, as a detached one does.
 */
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useConversationClient, useConversationDaemon } from '../client.ts';
import { composerApi } from './composer-api.ts';
import { daemonConnection } from './seam.ts';
import { outboxSender, SendOutboxProvider } from './send-outbox-wiring.ts';

export function ConversationOutbox({ children }: { readonly children?: ReactNode }): ReactNode {
  const client = useConversationClient();
  const daemonId = useConversationDaemon();
  const sender = useMemo(
    () => (daemonId === undefined ? undefined : outboxSender(daemonConnection(daemonId), composerApi(client), client)),
    [client, daemonId],
  );
  // A client the shell recorded no daemon for has no outbox to keep: its composers send straight away.
  if (daemonId === undefined || sender === undefined) return children;
  return (
    <SendOutboxProvider daemonId={daemonId} sender={sender}>
      {children}
    </SendOutboxProvider>
  );
}
