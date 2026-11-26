import type { SocketListeners, TransportAnswer, TransportSocket } from './transport.ts';

/** A pressed stream retries its OWN admission after the shell's existing unlock/step-up flow. No preceding act spends it. */
export function confirmedSocket(
  open: (listeners: SocketListeners) => TransportSocket,
  confirm: (
    first: TransportAnswer,
    resend: () => Promise<TransportAnswer>,
    signal: AbortSignal,
  ) => Promise<TransportAnswer>,
  listeners: SocketListeners,
): TransportSocket {
  const abort = new AbortController();
  let inner: TransportSocket | undefined;
  let ended: { reason: string; code?: number; refusal?: { status: number; body: unknown } } | undefined;
  let closed = false;
  const attempt = (): Promise<TransportAnswer> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('the stream was closed'));
        return;
      }
      let opened = false;
      try {
        inner = open({
          onOpen: () => {
            if (closed) return;
            opened = true;
            resolve({ status: 200, headers: {}, body: undefined });
            listeners.onOpen?.();
          },
          onFrame: frame => {
            if (!closed) listeners.onFrame(frame);
          },
          onClose: (reason, code, refusal) => {
            if (closed) return;
            ended = { reason, code, refusal };
            if (opened || refusal === undefined) {
              closed = true;
              listeners.onClose(reason, code, refusal);
            }
            resolve({ status: refusal?.status ?? 0, headers: {}, body: refusal?.body });
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  void (async () => {
    const first = await attempt();
    if (closed || first.status < 400) return;
    const answer = await confirm(first, attempt, abort.signal);
    if (closed || answer.status < 400) return;
    closed = true;
    if (ended !== undefined) listeners.onClose(ended.reason, ended.code, ended.refusal);
  })().catch(error => {
    if (closed) return;
    closed = true;
    listeners.onClose(error instanceof Error ? error.message : String(error));
  });
  return {
    send: frame => {
      if (!closed) inner?.send(frame);
    },
    close: (code, reason) => {
      closed = true;
      abort.abort();
      inner?.close(code, reason);
    },
  };
}
