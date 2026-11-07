/**
 * Plugging the outbox into a browser: how it reaches a machine, what makes it try again, and where a composer
 * finds it.
 *
 * Kept apart from `send-outbox.ts` so the outbox itself knows no connection, carrier or window. Today's app store
 * held one device-wide outbox; Conversation owns it now, as ONE outbox per paired daemon for the life of the
 * document ({@link documentOutbox}), over the same IndexedDB store, each reading and writing only its own
 * daemon's entries. A composer reaches it with {@link useSendOutbox} inside a {@link SendOutboxProvider}.
 */

import { createElement, type ReactNode, useContext, useEffect, useMemo, createContext } from 'react';
import { uploadAttachment } from './attachment-upload.ts';
import { type ConversationCaller, type DaemonConnection, daemonFerretScope } from './seam.ts';
import {
  MemoryOutboxBackend,
  type OutboxBackend,
  type OutboxEntry,
  type OutboxFile,
  type OutboxSender,
  SendOutbox,
} from './send-outbox.ts';
import { browserOutboxBackend } from './send-outbox-storage.ts';

/** What one machine's send (the composer's api) and the half's client make of an {@link OutboxSender}. */
export const outboxSender = (
  connection: DaemonConnection,
  api: Pick<OutboxSender, 'send'>,
  client: ConversationCaller,
): OutboxSender => ({
  send: async (ferretId, input, requestId) => await api.send(ferretId, input, requestId),
  upload: async (ferretId, file: OutboxFile) =>
    (
      await uploadAttachment(client, daemonFerretScope(connection, ferretId), {
        name: file.name,
        type: file.type,
        arrayBuffer: async () => await file.blob.arrayBuffer(),
      })
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

/** The entries of one daemon in a store every daemon's outbox shares: another daemon's rows are never read or written. */
export const daemonOutboxBackend = (backend: OutboxBackend, daemonId: string): OutboxBackend => ({
  all: async () => (await backend.all()).filter(entry => entry.daemonId === daemonId),
  put: async (entry: OutboxEntry) => {
    if (entry.daemonId !== daemonId) throw new Error('an outbox writes only its own daemon’s entries');
    await backend.put(entry);
  },
  delete: async (id: string) => await backend.delete(id),
});

/**
 * The browser's own signals. GAP(app-shell): a half hears no "this machine recovered" moment (today's connection
 * health), so only the browser coming online and the outbox's own retry timer make it try again.
 */
const browserEnvironment: OutboxWatchEnvironment = {
  onRecovered: () => () => undefined,
  onOnline: listener => {
    globalThis.addEventListener?.('online', listener);
    return () => globalThis.removeEventListener?.('online', listener);
  },
};

/** One daemon's outbox, and the senders the composers drawn for that daemon offer it. */
export interface DaemonOutbox {
  readonly outbox: SendOutbox;
  /** A composer for this daemon is up: its sender carries the outbox's entries. Returns the way to take it back. */
  offer(sender: OutboxSender): () => void;
  stop(): void;
}

export interface DaemonOutboxOptions {
  readonly daemonId: string;
  /** IndexedDB by default; a Map in a test. */
  readonly backend?: OutboxBackend;
  readonly environment?: OutboxWatchEnvironment;
  readonly mintId?: () => string;
  readonly now?: () => number;
  readonly retryAfterMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Builds one daemon's outbox: it loads what a previous page left, tries it, and keeps trying at the moments a message
 * could get through. Its machine is reachable only while a composer for it has offered a sender; until then its
 * entries wait (`waiting for connection`), exactly as today's outbox waited for a machine it could not dial.
 */
export const createDaemonOutbox = (options: DaemonOutboxOptions): DaemonOutbox => {
  const senders: OutboxSender[] = [];
  const outbox = new SendOutbox({
    backend: daemonOutboxBackend(options.backend ?? new MemoryOutboxBackend(), options.daemonId),
    mintId: options.mintId ?? (() => crypto.randomUUID()),
    resolve: async daemonId => (daemonId === options.daemonId ? (senders.at(-1) ?? null) : null),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
  });
  void outbox.load().then(() => outbox.drainAll());
  const stop = watchOutbox(outbox, options.environment ?? browserEnvironment);
  return {
    outbox,
    offer: sender => {
      senders.push(sender);
      // A composer coming up is the moment this machine became reachable from here.
      void outbox.drainDaemon(options.daemonId);
      return () => {
        const index = senders.lastIndexOf(sender);
        if (index >= 0) senders.splice(index, 1);
      };
    },
    stop,
  };
};

const documentOutboxes = new Map<string, DaemonOutbox>();

/** The document-lifetime outbox of one daemon, made on first use over the browser's storage. */
export const documentOutbox = (daemonId: string): DaemonOutbox => {
  let existing = documentOutboxes.get(daemonId);
  if (existing === undefined) {
    existing = createDaemonOutbox({ daemonId, backend: browserOutboxBackend() ?? new MemoryOutboxBackend() });
    documentOutboxes.set(daemonId, existing);
  }
  return existing;
};

const SendOutboxContext = createContext<SendOutbox | null>(null);

/**
 * Gives the composers below it their daemon's outbox, and offers it their sender while they are drawn. `outbox` is
 * the document's own for `daemonId` unless a test hands one in.
 */
export function SendOutboxProvider({
  daemonId,
  sender,
  outbox,
  children,
}: {
  readonly daemonId: string;
  readonly sender: OutboxSender;
  readonly outbox?: DaemonOutbox;
  readonly children?: ReactNode;
}) {
  const daemonOutbox = useMemo(() => outbox ?? documentOutbox(daemonId), [outbox, daemonId]);
  useEffect(() => daemonOutbox.offer(sender), [daemonOutbox, sender]);
  return createElement(SendOutboxContext.Provider, { value: daemonOutbox.outbox }, children);
}

/** The daemon's outbox, or `null` outside a provider — a composer without one sends straight away, as it always did. */
export function useSendOutbox(): SendOutbox | null {
  return useContext(SendOutboxContext);
}
