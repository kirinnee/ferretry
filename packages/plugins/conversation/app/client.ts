/**
 * THE CLIENT CONTEXT. The shell hands this half one generated client per daemon (§9.6); every surface of the half
 * reads it from here, so no Conversation file is passed a client through six levels of props and none can reach a
 * daemon any other way (no `fetch`, no store, no connection object). The chat's `call`/`subscribe`/`socket` all go
 * through it; Ferrets' reads are called by route key too (the client guards the caller AND the owner).
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { daemonOfClient } from '@ferretry/app';
import { createContext, createElement, type ReactNode, useContext } from 'react';

const ConversationClientContext = createContext<PluginClient | null>(null);

export function ConversationClientProvider({
  client,
  children,
}: {
  readonly client: PluginClient;
  readonly children: ReactNode;
}) {
  return createElement(ConversationClientContext.Provider, { value: client }, children);
}

/** The client of the daemon this view is drawn for. Throws outside a surface the half built. */
export function useConversationClient(): PluginClient {
  const client = useContext(ConversationClientContext);
  if (client === null) throw new Error('useConversationClient must be used inside a Conversation surface');
  return client;
}

/** The daemon this half was built for (the shell records it against the client), for an address or a cache key. */
export function useConversationDaemon(): string | undefined {
  return daemonOfClient(useConversationClient());
}
