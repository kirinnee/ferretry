/**
 * A PLUGIN CHAT'S READING POSITION, from the shell's one scroll memory (`fy:app:scroll`, this tab only): the slot a
 * conversation reads once on open and writes as the reader moves. Outside a shell (a harness, a test) there is no
 * memory, and the chat opens at the latest message as it always did without one.
 */
import { useMemo } from 'react';
import { useOptionalShell } from '../shell/context.tsx';
import { type ChatScrollSlot, chatScrollSlot } from './scroll-memory.ts';

/** The slot for one conversation, keyed by its daemon-scoped key; `undefined` outside a shell. */
export function useChatScrollSlot(key: string): ChatScrollSlot | undefined {
  const shell = useOptionalShell();
  const memory = shell?.scroll;
  return useMemo(() => (memory === undefined ? undefined : chatScrollSlot(memory, key)), [memory, key]);
}
