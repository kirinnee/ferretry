/**
 * The input card, fetched: finds the request an `input` ask points at and keeps it fresh.
 *
 * The request is read from the daemon, never from the ask (the ask holds no facts: they live in the daemon's RAM and
 * are re-observed after a restart). While the daemon is still re-observing the target (`observed` absent) the host
 * asks again every few seconds so Send comes back by itself. The last request read is kept: once it is sent the daemon
 * stops listing it, and the card must still say what happened rather than vanish.
 *
 * WHICH REQUEST. The ask carries the ferret and, when the Agenda passes it, the request id (`ref.request`). The Agenda
 * passes only `{ kind: 'input' }` today (GAP(ask-input)), so the host then picks the ferret's open request whose
 * prompt is the one the ask's context quotes after "The agent says: ". Two requests with the same prompt on one ferret
 * are told apart by the id when it is there, and otherwise the first is drawn.
 */
import { AskOnScreenSchema } from '@ferretry/core-asks/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listInputRequests } from '../../lib/input-api.ts';
import type { InputRequestView } from '../../lib/input-wire.ts';
import type { VaultClient } from '../../shell.tsx';
import { InputCard } from './input-card.tsx';

const INPUT_REFRESH_MS = 3_000;
/** What the daemon writes before the agent's own prompt in the ask's context. */
const PROMPT_MARKER = 'The agent says: ';

export interface InputCardHostProps {
  readonly client: VaultClient;
  /** The value the ask list hands the `ask:input` renderer. */
  readonly value: unknown;
  readonly agentName?: string;
  readonly onDone?: () => void;
  /** Whether the card holds the view it is drawn in: see `InputCardProps.onHold`. */
  readonly onHold?: (holding: boolean, settled?: string) => void;
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'open'; readonly request: InputRequestView }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'failed'; readonly text: string };

/** Whether a listed request is the one this ask is the card of. */
export function isAskRequest(
  request: InputRequestView,
  ask: { readonly ref: { readonly [key: string]: unknown }; readonly context?: string | undefined },
): boolean {
  if (typeof ask.ref.request === 'string') return request.id === ask.ref.request;
  return ask.context?.endsWith(`${PROMPT_MARKER}${request.prompt}`) === true;
}

export function InputCardHost({ client, value, agentName, onDone, onHold }: InputCardHostProps) {
  const ask = AskOnScreenSchema.safeParse(value);
  const ferret = ask.success ? ask.data.ferret : undefined;
  const isAsk = ask.success;
  const askRequest = ask.success && typeof ask.data.ref.request === 'string' ? ask.data.ref.request : undefined;
  const askContext = ask.success ? ask.data.context : undefined;
  const name = agentName ?? (ask.success ? ask.data.ferretName : undefined);
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const settled = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (ferret === undefined || !isAsk || settled.current) return;
    try {
      const listed = await listInputRequests(client, ferret);
      const open = listed.find(
        each =>
          each.kind === 'open' &&
          isAskRequest(each.request, {
            ref: askRequest === undefined ? {} : { request: askRequest },
            context: askContext,
          }),
      );
      const unreadable = listed.find(
        each => each.kind === 'unreadable' && (askRequest === undefined || each.id === askRequest),
      );
      setRead(previous =>
        open?.kind === 'open'
          ? { kind: 'open', request: open.request }
          : unreadable !== undefined && previous.kind !== 'open'
            ? { kind: 'unreadable' }
            : previous.kind === 'open'
              ? previous
              : { kind: 'gone' },
      );
    } catch (cause) {
      setRead(previous =>
        previous.kind === 'open'
          ? previous
          : { kind: 'failed', text: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }, [client, ferret, isAsk, askRequest, askContext]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), INPUT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!ask.success) return null;
  if (read.kind === 'failed')
    return (
      <p className="m-0 text-ui text-err" role="alert">
        Could not read this request: {read.text}
      </p>
    );
  if (read.kind === 'unreadable')
    return (
      <p className="m-0 text-ui text-warn" data-input-unreadable="" role="status">
        This request needs a newer version of the app. Reload the app to answer it.
      </p>
    );
  if (read.kind === 'gone')
    return (
      <p className="m-0 text-ui text-muted" data-input-gone="" role="status">
        This request is no longer open.
      </p>
    );
  if (read.kind === 'loading')
    return (
      <p className="m-0 text-ui text-faint" role="status">
        Reading the request…
      </p>
    );
  return (
    <InputCard
      client={client}
      embedded
      onDone={() => {
        settled.current = true;
        onDone?.();
      }}
      onRefresh={() => void refresh()}
      {...(onHold === undefined ? {} : { onHold })}
      request={read.request}
      {...(name === undefined ? {} : { agentName: name })}
    />
  );
}
