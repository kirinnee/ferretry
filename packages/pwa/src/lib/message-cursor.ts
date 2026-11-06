import { FyHttpError } from '@ferretry/protocol/client';

/** A release or transcript replacement invalidated the caller's message evidence. */
export const staleMessageEvidence = (reason: unknown, code: 'message_cursor_stale' | 'selection_stale'): boolean =>
  reason instanceof FyHttpError && reason.status === 409 && reason.code === code;

/** Restart a whole paged read once, with fresh accumulators and no cursor from the failed attempt. */
export const withFreshMessageCursor = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (reason) {
    if (!staleMessageEvidence(reason, 'message_cursor_stale')) throw reason;
    return await read();
  }
};
