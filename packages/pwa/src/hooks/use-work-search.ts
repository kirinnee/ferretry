/**
 * THE DAEMON'S WORK SEARCH AS A HOOK: debounced, abortable, and calm.
 *
 * - One request per pause in typing (`WORK_SEARCH_DEBOUNCE_MS`), never one per keystroke.
 * - A new request aborts the one still in flight, so a slow answer to "tok" never lands over "token".
 * - THE LAST ANSWER STAYS while the next loads: a list that empties on every keystroke flickers, and the
 *   rows a reader was about to pick vanish under their pointer.
 * - An answer belongs to ONE daemon: switching machines drops it, so one machine's cards are never offered
 *   under another's name.
 *
 * `request === null` (or no port) is "nothing to ask": no request, no answer shown.
 */

import type { WorkKind, WorkSearchResponse } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import { WORK_SEARCH_DEBOUNCE_MS, type WorkSearchPort } from '../lib/work-search.ts';

export interface WorkSearchAsk {
  readonly q: string;
  readonly kind?: WorkKind;
  readonly open?: boolean;
  readonly all?: boolean;
  readonly limit?: number;
}

export interface WorkSearchRead {
  readonly hits: WorkSearchResponse['hits'];
  readonly total: number;
  /** The next answer has not arrived; `hits` is the previous one, or empty. */
  readonly pending: boolean;
  /** The last request failed; `hits` is whatever the last good answer held. */
  readonly failed: boolean;
}

const NOTHING: WorkSearchRead = { hits: [], total: 0, pending: false, failed: false };

interface Answer {
  readonly daemonKey: string;
  readonly askKey: string;
  readonly response: WorkSearchResponse | null;
  readonly failed: boolean;
}

const askKeyOf = (ask: WorkSearchAsk): string =>
  `${ask.q.trim()}\u0000${ask.kind ?? ''}\u0000${ask.open === true ? 1 : 0}\u0000${ask.all === true ? 1 : 0}\u0000${ask.limit ?? ''}`;

export function useWorkSearch(
  port: WorkSearchPort | undefined,
  daemonKey: string,
  request: WorkSearchAsk | null,
  debounceMs: number = WORK_SEARCH_DEBOUNCE_MS,
): WorkSearchRead {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const askKey = request === null ? null : askKeyOf(request);
  const live = port !== undefined && request !== null;
  const q = request?.q;
  const kind = request?.kind;
  const open = request?.open;
  const all = request?.all;
  const limit = request?.limit;

  useEffect(() => {
    if (port === undefined || q === undefined || askKey === null) return;
    const ask: WorkSearchAsk = {
      q,
      ...(kind === undefined ? {} : { kind }),
      ...(open === undefined ? {} : { open }),
      ...(all === undefined ? {} : { all }),
      ...(limit === undefined ? {} : { limit }),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      port.search(ask, controller.signal).then(
        response => {
          if (controller.signal.aborted) return;
          setAnswer({ daemonKey, askKey, response, failed: false });
        },
        () => {
          if (controller.signal.aborted) return;
          setAnswer(previous => ({
            daemonKey,
            askKey,
            response: previous?.daemonKey === daemonKey ? previous.response : null,
            failed: true,
          }));
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [port, daemonKey, askKey, q, kind, open, all, limit, debounceMs]);

  if (!live || answer === null || answer.daemonKey !== daemonKey) {
    return live ? { ...NOTHING, pending: true } : NOTHING;
  }
  return {
    hits: answer.response?.hits ?? [],
    total: answer.response?.total ?? 0,
    pending: answer.askKey !== askKey,
    failed: answer.failed,
  };
}
