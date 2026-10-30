/**
 * Signals: what this agent is waiting on you for, and what you already answered.
 *
 * The answer controls are the attention board's own (`AttentionAnswerControls`), so an answer given here
 * is exactly the answer the board, the action modal and the chat card would have sent — one presenter of
 * an ask's valid answers, never a second.
 */

import type { AttentionResponse, AttentionSnapshot } from '@ferretry/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AttentionLoadStatus } from '../../lib/attention-store.ts';
import { cn } from '../../lib/class-names.ts';
import { Button } from '../../shell/primitives.tsx';
import { AttentionAnswerControls } from '../attention/attention-answer-controls.tsx';
import {
  CONTEXT_RAIL_SEARCH_LABEL,
  contextEmptyCopy,
  type SignalChip,
  type SignalRow,
  signalChips,
  signalMeta,
  signalOutcome,
  signalRows,
  visibleSignals,
} from './context-rail-model.ts';
import { ContextFailure, ContextFilterBar, ContextNote, loadFailureReason } from './context-rail-parts.tsx';
import type { ContextSignalsPort } from './context-rail-ports.ts';

export interface ContextSignalsRead {
  readonly status: AttentionLoadStatus;
  readonly snapshot: AttentionSnapshot | undefined;
}

/**
 * This agent's attention board, live, read on first use. A failed read is left for the panel to report:
 * the store already holds the `error` status, so swallowing the rejection here loses nothing.
 */
export function useContextSignals(port: ContextSignalsPort): ContextSignalsRead {
  const status = useSyncExternalStore(port.subscribe, port.status);
  const snapshot = useSyncExternalStore(port.subscribe, port.snapshot);
  useEffect(() => {
    port.load().catch(() => undefined);
  }, [port]);
  return { status, snapshot };
}

export interface ContextSignalsPanelProps {
  readonly port: ContextSignalsPort;
  readonly read: ContextSignalsRead;
  readonly agentName: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly chip: SignalChip;
  readonly onChipChange: (chip: SignalChip) => void;
  readonly now: () => number;
  readonly searchDebounceMs?: number;
}

export function ContextSignalsPanel({
  port,
  read,
  agentName,
  query,
  onQueryChange,
  chip,
  onChipChange,
  now,
  searchDebounceMs,
}: ContextSignalsPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ readonly id: string; readonly reason: string } | null>(null);

  if (read.snapshot === undefined)
    return read.status === 'error' ? (
      <ContextFailure
        title="Couldn’t read what this agent is waiting on"
        reason="The agenda did not load."
        onRetry={() => {
          port.load().catch(() => undefined);
        }}
      />
    ) : (
      <ContextNote>Reading signals…</ContextNote>
    );

  const rows = signalRows(read.snapshot);
  const chips = signalChips(rows, query);
  const visible = visibleSignals(rows, query, chip);
  const total = rows.filter(row => row.state === chip).length;
  const chipLabel = chip === 'open' ? 'Open' : 'Answered';

  const act = (id: string, send: () => Promise<void>): void => {
    setBusy(id);
    setRefusal(null);
    send().then(
      () => setBusy(null),
      (error: unknown) => {
        setBusy(null);
        setRefusal({ id, reason: loadFailureReason(error) });
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <ContextFilterBar
        searchLabel={CONTEXT_RAIL_SEARCH_LABEL.signals}
        query={query}
        onQueryChange={onQueryChange}
        chips={chips}
        chip={chip}
        onChipChange={onChipChange}
        {...(searchDebounceMs === undefined ? {} : { debounceMs: searchDebounceMs })}
      />
      {visible.length === 0 ? (
        <ContextNote>{contextEmptyCopy('signals', total, query, chipLabel)}</ContextNote>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-xs p-0" data-context-list="signals">
          {visible.map(row => (
            <SignalItem
              key={row.item.id}
              row={row}
              agentName={agentName}
              nowMs={now()}
              busy={busy === row.item.id}
              refusal={refusal?.id === row.item.id ? refusal.reason : null}
              onRespond={response => act(row.item.id, () => port.respond(row.item.id, response))}
              onResolve={() => act(row.item.id, () => port.resolve(row.item.id))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface SignalItemProps {
  readonly row: SignalRow;
  readonly agentName: string;
  readonly nowMs: number;
  readonly busy: boolean;
  readonly refusal: string | null;
  readonly onRespond: (response: AttentionResponse) => void;
  readonly onResolve: () => void;
}

function SignalItem({ row, agentName, nowMs, busy, refusal, onRespond, onResolve }: SignalItemProps) {
  const open = row.state === 'open';
  return (
    <li
      className={cn(
        'kt-panel flex min-w-0 flex-col gap-xs p-panel',
        open ? 'border-l-heavy border-l-warn' : 'opacity-90',
      )}
      data-context-signal={row.item.id}
      data-context-signal-state={row.state}
    >
      <p className="m-0 break-words text-cell font-semibold text-fg">{row.item.subject}</p>
      <p className="m-0 text-meta text-muted">{signalMeta(row, agentName, nowMs)}</p>
      {row.state === 'answered' ? (
        <p className="m-0 break-words text-meta text-fg-soft" data-context-signal-outcome="">
          {signalOutcome(row.item)}
        </p>
      ) : row.item.ask === undefined ? (
        <div>
          <Button type="button" size="sm" disabled={busy} onClick={onResolve} data-context-signal-done="">
            Mark done
          </Button>
        </div>
      ) : (
        <AttentionAnswerControls ask={row.item.ask} busy={busy} onRespond={onRespond} />
      )}
      {refusal === null ? null : (
        <p className="m-0 break-words text-meta text-err" role="alert" data-context-signal-refusal="">
          Couldn’t send that: {refusal}
        </p>
      )}
    </li>
  );
}
