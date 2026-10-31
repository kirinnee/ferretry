/**
 * The input card, fetched: finds the request an `input` agenda item points at and keeps it fresh.
 *
 * The request is read from the daemon by the item's `input.requestId`, never from the item (the item holds no
 * facts: they live in the daemon's RAM and are re-observed after a restart). While the daemon is still
 * re-observing the target (`observed` absent) the host asks again every few seconds so Send comes back by itself.
 * The last request read is kept: once it is sent the daemon stops listing it, and the card must still say what
 * happened rather than vanish.
 */

import type { AgendaItem, InputRequest } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { InputClient } from '../../lib/input-api.ts';
import { readInputRequest } from '../../lib/input-api.ts';
import { fieldsOf } from '../../lib/input-card.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { InputCard } from './input-card.tsx';

const INPUT_REFRESH_MS = 3_000;

export interface InputCardHostProps {
  readonly connection: DaemonConnection;
  readonly sessionId: string;
  readonly item: Pick<AgendaItem, 'input'>;
  readonly agentName?: string;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<InputClient>;
  readonly onDone?: () => void;
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'open'; readonly request: InputRequest }
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed'; readonly text: string };

export function InputCardHost({
  connection,
  sessionId,
  item,
  agentName,
  createClient: injected,
  onDone,
}: InputCardHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const requestId = item.input?.requestId;
  const [client, setClient] = useState<InputClient | null>(null);
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const settled = useRef(false);

  useEffect(() => {
    let current = true;
    setClient(null);
    void createClient(connection)
      .then(next => {
        if (current) setClient(next);
      })
      .catch(cause => {
        if (current) setRead({ kind: 'failed', text: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const refresh = useCallback(async (): Promise<void> => {
    if (client === null || requestId === undefined || settled.current) return;
    try {
      const request = await readInputRequest(client, sessionId, requestId);
      setRead(previous =>
        request !== undefined ? { kind: 'open', request } : previous.kind === 'open' ? previous : { kind: 'gone' },
      );
    } catch (cause) {
      setRead(previous =>
        previous.kind === 'open'
          ? previous
          : { kind: 'failed', text: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }, [client, requestId, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), INPUT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (requestId === undefined) return null;
  if (read.kind === 'failed')
    return (
      <p className="m-0 text-ui text-err" role="alert">
        Could not read this request: {read.text}
      </p>
    );
  if (read.kind === 'gone')
    return (
      <p className="m-0 text-ui text-muted" data-input-gone="" role="status">
        This request is no longer open.
      </p>
    );
  if (read.kind === 'loading' || client === null)
    return (
      <p className="m-0 text-ui text-faint" role="status">
        Reading the request…
      </p>
    );
  return (
    <InputCard
      client={client}
      embedded
      fields={fieldsOf(read.request)}
      onDone={() => {
        settled.current = true;
        onDone?.();
      }}
      onRefresh={() => void refresh()}
      request={read.request}
      {...(agentName === undefined ? {} : { agentName })}
    />
  );
}
