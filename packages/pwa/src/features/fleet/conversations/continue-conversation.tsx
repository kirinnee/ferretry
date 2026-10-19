/**
 * New session › "Continue a conversation": search every Claude Code and Codex conversation already on
 * this machine and pick one to carry on with, so earlier work feels imported rather than left behind.
 *
 * The search runs on the daemon (`q`, `harness`, `since`). Picking a row a ferret already keeps opens
 * that ferret instead of making a second one. Any other row is adopted with `start: true` on a runtime
 * that drives its CLI — the only one, or one the person picks — and the new session opens, where Chat
 * shows the conversation's full history from the CLI's own file.
 */

import type { FleetRuntimeView, ImportableConversation } from '@ferretry/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { daemonSessionPath } from '../../../lib/pages/routes.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { readFleetRuntimes } from '../catalog-api.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { useSetupAccess } from '../setup/setup-access.ts';
import { SETUP_HARNESS_NAMES } from '../setup/setup-words.ts';
import { ConversationMeta, previewText, Segmented } from './conversation-picker.tsx';
import {
  DATE_FILTERS,
  type DateFilter,
  HARNESS_FILTERS,
  type HarnessFilter,
  listingQuery,
  runtimeChoice,
} from './conversation-picker-model.ts';
import { adoptConversations, readImportableConversations } from './conversations-api.ts';

/** How many matches one search shows, newest first. */
export const CONTINUE_LIMIT = 50;
/** How long typing pauses before the daemon is searched. */
const SEARCH_DEBOUNCE_MS = 250;

export interface ContinueConversationProps {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** Receives the session to open. */
  readonly onNavigate: (path: string) => void;
  /** Supplied in tests. */
  readonly now?: () => number;
  readonly debounceMs?: number;
}

type Results =
  | { readonly kind: 'reading' }
  | { readonly kind: 'refused'; readonly sentence: string }
  | { readonly kind: 'read'; readonly rows: readonly ImportableConversation[]; readonly matched: number };

/** A picked row waiting for its runtime, or the sentence saying why it can't continue. */
type Picking =
  | { readonly kind: 'runtime'; readonly row: ImportableConversation; readonly runtimes: readonly FleetRuntimeView[] }
  | { readonly kind: 'issue'; readonly id: string; readonly sentence: string };

export function ContinueConversation({
  connection,
  createClient,
  onNavigate,
  now = Date.now,
  debounceMs = SEARCH_DEBOUNCE_MS,
}: ContinueConversationProps) {
  const { read, act } = useSetupAccess({ connection, createClient });
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [harness, setHarness] = useState<HarnessFilter>('all');
  const [date, setDate] = useState<DateFilter>('any');
  const [results, setResults] = useState<Results>({ kind: 'reading' });
  const [runtimes, setRuntimes] = useState<readonly FleetRuntimeView[]>([]);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const searchId = useId();
  const clock = useRef(now);
  clock.current = now;

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), debounceMs);
    return () => clearTimeout(timer);
  }, [text, debounceMs]);

  useEffect(() => {
    let live = true;
    void read(client => readFleetRuntimes(client)).then(answer => {
      if (live && answer.kind === 'done') setRuntimes(answer.value.runtimes);
    });
    return () => {
      live = false;
    };
  }, [read]);

  useEffect(() => {
    let live = true;
    const search = listingQuery({ text: query, harness, date }, clock.current(), CONTINUE_LIMIT);
    void read(client => readImportableConversations(client, search)).then(answer => {
      if (!live) return;
      setResults(
        answer.kind === 'done'
          ? { kind: 'read', rows: answer.value.conversations, matched: answer.value.matched }
          : { kind: 'refused', sentence: answer.sentence },
      );
    });
    return () => {
      live = false;
    };
  }, [read, query, harness, date]);

  const adopt = async (row: ImportableConversation, wrapper: string): Promise<void> => {
    setBusy(row.id);
    setPicking(null);
    const answer = await act(client =>
      adoptConversations(client, {
        harness: row.harness,
        runtime: wrapper,
        conversations: [{ id: row.id, start: true }],
      }),
    );
    setBusy(null);
    if (answer.kind === 'refused') {
      setPicking({ kind: 'issue', id: row.id, sentence: answer.sentence });
      return;
    }
    const [made] = answer.value.adopted;
    if (made !== undefined) {
      onNavigate(daemonSessionPath(connection.daemonId, made.session));
      return;
    }
    const [refused] = answer.value.refused;
    setPicking({ kind: 'issue', id: row.id, sentence: refused?.reason ?? 'This machine didn’t keep it.' });
  };

  const pick = (row: ImportableConversation): void => {
    if (row.adoptedBy !== undefined) {
      onNavigate(daemonSessionPath(connection.daemonId, row.adoptedBy));
      return;
    }
    const choice = runtimeChoice(runtimes, row.harness);
    if (choice.kind === 'none') setPicking({ kind: 'issue', id: row.id, sentence: choice.sentence });
    else if (choice.kind === 'one') void adopt(row, choice.runtime.wrapper);
    else setPicking({ kind: 'runtime', row, runtimes: choice.runtimes });
  };

  const at = now();
  return (
    <div className="flex min-w-0 flex-col gap-3" data-continue-conversation="">
      <label htmlFor={searchId} className="text-ui font-semibold text-fg">
        Search your conversations
      </label>
      <input
        id={searchId}
        type="search"
        className="kt-input w-full"
        placeholder="Words from a message, or a folder"
        autoComplete="off"
        data-continue-search=""
        value={text}
        onChange={event => setText(event.target.value)}
      />
      <div className="flex min-w-0 flex-wrap gap-2">
        <Segmented<HarnessFilter>
          label="CLI"
          name="harness"
          options={HARNESS_FILTERS}
          value={harness}
          onChoose={setHarness}
        />
        <Segmented<DateFilter> label="Last active" name="date" options={DATE_FILTERS} value={date} onChoose={setDate} />
      </div>

      {results.kind === 'reading' ? (
        <p role="status" className="m-0 text-cell text-muted" data-continue-reading="">
          Searching…
        </p>
      ) : results.kind === 'refused' ? (
        <p role="alert" className="m-0 text-cell leading-base text-warn" data-continue-refused="">
          {results.sentence}
        </p>
      ) : results.rows.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-continue-empty="">
          No conversation matches.
        </p>
      ) : (
        <>
          <p className="m-0 text-meta text-muted" data-continue-count="">
            {results.matched > results.rows.length
              ? `${results.rows.length} most recent of ${results.matched} matches`
              : `${results.matched} ${results.matched === 1 ? 'match' : 'matches'}`}
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {results.rows.map(row => (
              <li key={row.id} className="flex min-w-0 flex-col gap-1">
                <button
                  type="button"
                  className="kt-panel flex min-h-control w-full min-w-0 flex-col items-start gap-1 p-panel text-left hover:border-accent disabled:opacity-70"
                  data-continue-row={row.id}
                  disabled={busy !== null}
                  onClick={() => pick(row)}
                >
                  <span className="break-all font-mono text-meta text-muted">{row.project}</span>
                  <span className="[overflow-wrap:anywhere] text-row text-fg">{previewText(row)}</span>
                  {row.latest === undefined ? null : (
                    <span className="[overflow-wrap:anywhere] text-cell text-muted">Latest: {row.latest}</span>
                  )}
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge tone="accent">{SETUP_HARNESS_NAMES[row.harness]}</Badge>
                    <ConversationMeta row={row} now={at} />
                  </span>
                  <span className="text-meta font-semibold text-accent">
                    {busy === row.id ? 'Starting…' : row.adoptedBy === undefined ? 'Continue' : `Open ${row.adoptedBy}`}
                  </span>
                </button>
                {picking?.kind === 'runtime' && picking.row.id === row.id ? (
                  <div className="flex min-w-0 flex-col gap-1" data-continue-runtimes={row.id}>
                    <p className="m-0 text-cell text-fg">Continue on which runtime?</p>
                    <div className="flex min-w-0 flex-wrap gap-2">
                      {picking.runtimes.map(runtime => (
                        <Button
                          key={runtime.name}
                          type="button"
                          size="sm"
                          className="font-mono"
                          data-continue-runtime={runtime.name}
                          onClick={() => void adopt(row, runtime.wrapper)}
                        >
                          {runtime.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {picking?.kind === 'issue' && picking.id === row.id ? (
                  <p role="alert" className="m-0 text-cell text-warn" data-continue-issue={row.id}>
                    {picking.sentence}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
