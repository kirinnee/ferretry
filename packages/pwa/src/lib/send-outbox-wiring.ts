/**
 * Plugging the outbox into a browser: how it reaches a machine, and what makes it try again.
 *
 * Kept apart from `send-outbox.ts` so the outbox itself knows no connection, carrier or window.
 */

import type { IFyApiClient } from '@ferretry/protocol';
import { uploadAttachment } from './attachment-upload.ts';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonSessionScope } from './daemon-scope.ts';
import type { OutboxFile, OutboxSender, SendOutbox } from './send-outbox.ts';
import type { DaemonFetch } from './runtime-models.ts';

/** What one machine's typed client and its carried fetch make of an {@link OutboxSender}. */
export const outboxSender = (
  connection: DaemonConnection,
  api: Pick<IFyApiClient, 'send'>,
  fetcher: DaemonFetch,
): OutboxSender => ({
  send: async (sessionId, input, requestId) => await api.send(sessionId, input, requestId),
  upload: async (sessionId, file: OutboxFile) =>
    (
      await uploadAttachment(
        connection,
        daemonSessionScope(connection, sessionId),
        { name: file.name, type: file.type, arrayBuffer: async () => await file.blob.arrayBuffer() },
        fetcher,
      )
    ).id,
});

export interface OutboxWatchEnvironment {
  /** The machine answers again: the health model's own "recovered" moment. */
  readonly onRecovered: (daemonId: string, listener: () => void) => () => void;
  /** The browser's own "network is back" signal. */
  readonly onOnline: (listener: () => void) => () => void;
}

/**
 * Makes the outbox try again at the moments a message could now get through: the browser comes back online,
 * and each machine that has something waiting reports itself recovered. Returns the way to stop.
 */
export const watchOutbox = (outbox: SendOutbox, environment: OutboxWatchEnvironment): (() => void) => {
  const recovered = new Map<string, () => void>();
  const sync = (): void => {
    const waiting = new Set(outbox.snapshot().map(entry => entry.daemonId));
    for (const daemonId of waiting) {
      if (recovered.has(daemonId)) continue;
      recovered.set(
        daemonId,
        environment.onRecovered(daemonId, () => void outbox.drainDaemon(daemonId)),
      );
    }
  };
  const unsubscribe = outbox.subscribe(sync);
  const offline = environment.onOnline(() => void outbox.drainAll());
  sync();
  return () => {
    unsubscribe();
    offline();
    for (const stop of recovered.values()) stop();
    recovered.clear();
    outbox.stop();
  };
};
