/**
 * THE BACKGROUND OUTBOX HOST (B12). Today's app store loaded and drained the device outbox at boot, so a message saved
 * while a machine could not be reached went out later even with no chat on screen. In 5.0 the outbox is Conversation's
 * and a composer offered it a sender, so a saved message waited until a chat drew one — reopening the app on another
 * page left it undelivered with the machine reachable.
 *
 * The shell mounts this once per paired daemon at the frame root (`shell.background`), handing it the plugin's own
 * client there in BACKGROUND passkey origin: a call to a locked machine waits for the unlock and never raises a prompt.
 * The host offers the daemon's document outbox a sender over that client for as long as it is mounted, which is the
 * moment the machine is reachable from here ({@link DaemonOutbox.offer} drains it). It draws nothing.
 *
 * Nothing new can be sent twice: the outbox sends an entry under the id it was saved with (the daemon's idempotency
 * key), so a send the machine already has is answered from its first record whichever sender carried it.
 */
import type { BackgroundViewProps } from '@ferretry/app';
import { useEffect } from 'react';
import { composerApi } from './composer-api.ts';
import { daemonConnection } from './seam.ts';
import { documentOutbox, outboxSender } from './send-outbox-wiring.ts';

export function OutboxHost({ daemon, client }: BackgroundViewProps): null {
  useEffect(
    () => documentOutbox(daemon).offer(outboxSender(daemonConnection(daemon), composerApi(client), client)),
    [daemon, client],
  );
  return null;
}
