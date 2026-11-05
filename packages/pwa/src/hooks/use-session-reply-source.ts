/**
 * THE SESSION VIEW AS LIVE VOICE WATCHES IT: a snapshot Live can read now, and a way to hear about every
 * change. The chat page already holds the session; this only lets Live look at it without a new route.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { ReplySnapshot, ReplySource } from '../lib/voice-chat/reply-feed.ts';

export function useSessionReplySource(snapshot: ReplySnapshot): ReplySource {
  const current = useRef(snapshot);
  current.current = snapshot;
  const listeners = useRef(new Set<() => void>());
  const source = useMemo<ReplySource>(
    () => ({
      current: () => current.current,
      subscribe: listener => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
    }),
    [],
  );
  const { turnState, turnStateAt, status } = snapshot;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of any of the three is the signal
  useEffect(() => {
    for (const listener of [...listeners.current]) listener();
  }, [turnState, turnStateAt, status]);
  return source;
}
