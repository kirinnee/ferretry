/**
 * New session › "Continue a conversation", from one of two sources the person picks at the top:
 *
 *   Ferretry sessions   every STOPPED ferret on this machine; continuing one resumes it in place, with
 *                       its conversation intact, through the same resume the session page offers
 *   All conversations   every Claude Code and Codex conversation in Ferretry's own history (which holds
 *                       what was imported at setup), searched on the daemon (`q`, `harness`, `since`)
 *
 * Each row says what it is about without asking anything: what the owner first said, the latest thing
 * they said, and where. Tapping a row opens a short preview of its last few exchanges with the button
 * that continues it. A conversation a ferret already keeps resumes (or opens) that ferret instead of
 * making a second one; any other is adopted with `start: true` on a runtime that drives its CLI — the
 * only one, or one the person picks — and the new session opens on its full history.
 */

import type {
  ConversationPreview,
  FleetRuntimeView,
  Harness,
  ImportableConversation,
  SessionView,
} from '@ferretry/protocol';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { daemonSessionPath } from '../../../lib/pages/routes.ts';
import { relativeTime, sessionStatusLabel } from '../../../lib/session-screens.ts';
import { Button } from '../../../shell/primitives.tsx';
import { readFleetRuntimes } from '../catalog-api.ts';
import { HARNESS_SHORT } from '../credentials/credentials-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { useSetupAccess } from '../setup/setup-access.ts';
import {
  CONTINUE_SOURCES,
  type ContinueSource,
  conversationsQuery,
  keptConversationAction,
  keptConversationsQuery,
  type StoppedSessionRow,
  stoppedSessionRows,
} from './continue-model.ts';
import { ConversationLines, Segmented } from './conversation-picker.tsx';
import {
  DATE_FILTERS,
  type DateFilter,
  folderLabel,
  HARNESS_FILTERS,
  type HarnessFilter,
  runtimeChoice,
} from './conversation-picker-model.ts';
import { adoptConversations, readConversationPreview, readImportableConversations } from './conversations-api.ts';

/** How many matches one search shows, newest first. */
export const CONTINUE_LIMIT = 50;
/** How many kept conversations are read to describe the stopped ferrets. */
export const KEPT_LIMIT = 1_000;
/** How long typing pauses before the daemon is searched. */
const SEARCH_DEBOUNCE_MS = 250;

export interface ContinueConversationProps {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** Receives the session to open. */
  readonly onNavigate: (path: string) => void;
  /**
   * This machine's ferrets, as the app already reads them (`null` while the first read is out). With
   * `resume`, it adds the "Ferretry sessions" source; without them only "All conversations" is shown.
   */
  readonly sessions?: readonly SessionView[] | null;
  /** Resumes a stopped ferret in place. */
  readonly resume?: (sessionId: string) => Promise<void>;
  /** Supplied in tests. */
  readonly now?: () => number;
  readonly debounceMs?: number;
}

type Listing =
  | { readonly kind: 'reading' }
  | { readonly kind: 'refused'; readonly sentence: string }
  | { readonly kind: 'read'; readonly rows: readonly ImportableConversation[]; readonly matched: number };

/** A picked row waiting for its runtime, or the sentence saying why it can't continue. */
type Picking =
  | { readonly kind: 'runtime'; readonly row: ImportableConversation; readonly runtimes: readonly FleetRuntimeView[] }
  | { readonly kind: 'issue'; readonly key: string; readonly sentence: string };

type Preview =
  | { readonly kind: 'reading' }
  | { readonly kind: 'refused'; readonly sentence: string }
  | { readonly kind: 'read'; readonly preview: ConversationPreview };

const conversationKey = (harness: Harness, id: string): string => `conversation:${harness}:${id}`;
const sessionKey = (id: string): string => `session:${id}`;

export function ContinueConversation({
  connection,
  createClient,
  onNavigate,
  sessions,
  resume,
  now = Date.now,
  debounceMs = SEARCH_DEBOUNCE_MS,
}: ContinueConversationProps) {
  const { read, act } = useSetupAccess({ connection, createClient });
  const offersSessions = sessions !== undefined && resume !== undefined;
  const [source, setSource] = useState<ContinueSource>(offersSessions ? 'sessions' : 'conversations');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [harness, setHarness] = useState<HarnessFilter>('all');
  const [date, setDate] = useState<DateFilter>('any');
  const [results, setResults] = useState<Listing>({ kind: 'reading' });
  const [kept, setKept] = useState<Listing>({ kind: 'reading' });
  const [runtimes, setRuntimes] = useState<readonly FleetRuntimeView[]>([]);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previews, setPreviews] = useState<ReadonlyMap<string, Preview>>(new Map());
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
    if (source !== 'conversations') return;
    let live = true;
    const search = conversationsQuery({ text: query, harness, date }, clock.current(), CONTINUE_LIMIT);
    void read(client => readImportableConversations(client, search)).then(answer => {
      if (live) setResults(listingResult(answer));
    });
    return () => {
      live = false;
    };
  }, [read, source, query, harness, date]);

  useEffect(() => {
    if (source !== 'sessions') return;
    let live = true;
    void read(client => readImportableConversations(client, keptConversationsQuery(KEPT_LIMIT))).then(answer => {
      if (live) setKept(listingResult(answer));
    });
    return () => {
      live = false;
    };
  }, [read, source]);

  const toggle = (key: string, conversation: ImportableConversation | undefined): void => {
    setPicking(null);
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (conversation === undefined || previews.has(key)) return;
    setPreviews(current => new Map(current).set(key, { kind: 'reading' }));
    void read(client => readConversationPreview(client, conversation.harness, conversation.id)).then(answer => {
      const preview: Preview =
        answer.kind === 'done'
          ? { kind: 'read', preview: answer.value }
          : { kind: 'refused', sentence: answer.sentence };
      setPreviews(current => new Map(current).set(key, preview));
    });
  };

  const resumeFerret = async (key: string, sessionId: string): Promise<void> => {
    if (resume === undefined) return;
    setBusy(key);
    setPicking(null);
    try {
      await resume(sessionId);
      onNavigate(daemonSessionPath(connection.daemonId, sessionId));
    } catch (error) {
      setBusy(null);
      setPicking({
        kind: 'issue',
        key,
        sentence: error instanceof Error && error.message !== '' ? error.message : 'The ferret could not resume.',
      });
    }
  };

  const adopt = async (row: ImportableConversation, wrapper: string): Promise<void> => {
    const key = conversationKey(row.harness, row.id);
    setBusy(key);
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
      setPicking({ kind: 'issue', key, sentence: answer.sentence });
      return;
    }
    const [made] = answer.value.adopted;
    if (made !== undefined) {
      onNavigate(daemonSessionPath(connection.daemonId, made.session));
      return;
    }
    const [refused] = answer.value.refused;
    setPicking({ kind: 'issue', key, sentence: refused?.reason ?? 'This machine didn’t keep it.' });
  };

  const continueConversation = (row: ImportableConversation): void => {
    const key = conversationKey(row.harness, row.id);
    if (row.adoptedBy !== undefined) {
      if (keptConversationAction(row, sessions ?? []) === 'resume') void resumeFerret(key, row.adoptedBy);
      else onNavigate(daemonSessionPath(connection.daemonId, row.adoptedBy));
      return;
    }
    const choice = runtimeChoice(runtimes, row.harness);
    if (choice.kind === 'none') setPicking({ kind: 'issue', key, sentence: choice.sentence });
    else if (choice.kind === 'one') void adopt(row, choice.runtime.wrapper);
    else setPicking({ kind: 'runtime', row, runtimes: choice.runtimes });
  };

  const at = now();
  const notes = (key: string): ReactNode => (
    <>
      {picking?.kind === 'runtime' && conversationKey(picking.row.harness, picking.row.id) === key ? (
        <div className="fy-convo-note flex min-w-0 flex-col gap-1" data-continue-runtimes={picking.row.id}>
          <p className="m-0 text-cell text-fg">Continue on which runtime?</p>
          <div className="flex min-w-0 flex-wrap gap-2">
            {picking.runtimes.map(runtime => (
              <Button
                key={runtime.name}
                type="button"
                size="sm"
                className="font-mono"
                data-continue-runtime={runtime.name}
                onClick={() => void adopt(picking.row, runtime.wrapper)}
              >
                {runtime.name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {picking?.kind === 'issue' && picking.key === key ? (
        <p role="alert" className="fy-convo-note m-0 text-cell text-warn" data-continue-issue={key}>
          {picking.sentence}
        </p>
      ) : null}
    </>
  );

  const conversationRows = (rows: readonly ImportableConversation[]): ReactNode =>
    rows.map(row => {
      const key = conversationKey(row.harness, row.id);
      const action = row.adoptedBy === undefined ? 'adopt' : keptConversationAction(row, sessions ?? []);
      return (
        <ContinueRow
          key={key}
          rowKey={key}
          open={expanded === key}
          disabled={busy !== null}
          onToggle={() => toggle(key, row)}
          lines={<ConversationLines row={row} now={at} />}
          preview={previews.get(key)}
          actionLabel={
            busy === key
              ? 'Starting…'
              : action === 'adopt'
                ? 'Continue'
                : action === 'resume'
                  ? 'Resume ferret'
                  : 'Open ferret'
          }
          onAction={() => continueConversation(row)}
          notes={notes(key)}
          data={{ 'data-continue-row': row.id }}
        />
      );
    });

  const sessionRows = (rows: readonly StoppedSessionRow[]): ReactNode =>
    rows.map(row => {
      const key = sessionKey(row.view.config.id);
      return (
        <ContinueRow
          key={key}
          rowKey={key}
          open={expanded === key}
          disabled={busy !== null}
          onToggle={() => toggle(key, row.conversation)}
          lines={
            row.conversation === undefined ? (
              <SessionLines row={row} now={at} />
            ) : (
              <ConversationLines
                row={{ ...row.conversation, lastActivityAt: row.lastActivityAt }}
                now={at}
                lead={row.name}
              />
            )
          }
          preview={row.conversation === undefined ? undefined : previews.get(key)}
          actionLabel={busy === key ? 'Resuming…' : 'Resume'}
          onAction={() => void resumeFerret(key, row.view.config.id)}
          notes={notes(key)}
          data={{ 'data-continue-session': row.view.config.id }}
        />
      );
    });

  const listed = (() => {
    if (source === 'conversations') {
      if (results.kind !== 'read') return <ListingState listing={results} />;
      if (results.rows.length === 0)
        return (
          <p className="m-0 text-cell text-muted" data-continue-empty="">
            No conversation matches.
          </p>
        );
      return (
        <>
          <p className="m-0 text-meta text-muted" data-continue-count="">
            {results.matched > results.rows.length
              ? `${results.rows.length} most recent of ${results.matched} matches`
              : `${results.matched} ${results.matched === 1 ? 'match' : 'matches'}`}
          </p>
          <ul className="kt-panel fy-session-group__list fy-convo-list">{conversationRows(results.rows)}</ul>
        </>
      );
    }
    if (sessions === null || sessions === undefined || kept.kind === 'reading')
      return <ListingState listing={{ kind: 'reading' }} />;
    const rows = stoppedSessionRows(
      sessions,
      kept.kind === 'read' ? kept.rows : [],
      { text: query, harness, date },
      at,
    );
    if (rows.length === 0)
      return (
        <p className="m-0 text-cell text-muted" data-continue-empty="">
          {query === '' && harness === 'all' && date === 'any'
            ? 'No ferret on this machine is stopped. A running one is in Sessions.'
            : 'No stopped ferret matches.'}
        </p>
      );
    return (
      <>
        <p className="m-0 text-meta text-muted" data-continue-count="">
          {`${rows.length} stopped ${rows.length === 1 ? 'ferret' : 'ferrets'}`}
        </p>
        <ul className="kt-panel fy-session-group__list fy-convo-list">{sessionRows(rows)}</ul>
      </>
    );
  })();

  return (
    <div className="flex min-w-0 flex-col gap-3" data-continue-conversation="">
      {offersSessions ? (
        <Segmented<ContinueSource>
          label="Continue from"
          name="continue-source"
          options={CONTINUE_SOURCES}
          value={source}
          onChoose={choice => {
            setSource(choice);
            setExpanded(null);
            setPicking(null);
          }}
        />
      ) : null}
      <label htmlFor={searchId} className="sr-only">
        {source === 'sessions' ? 'Search stopped ferrets' : 'Search your conversations'}
      </label>
      <input
        id={searchId}
        type="search"
        className="kt-input w-full"
        placeholder={
          source === 'sessions' ? 'A name, words from a message, or a folder' : 'Words from a message, or a folder'
        }
        autoComplete="off"
        data-continue-search=""
        value={text}
        onChange={event => setText(event.target.value)}
      />
      <div className="flex min-w-0 gap-2" data-continue-filters="">
        <div className="min-w-0 flex-auto">
          <Segmented<HarnessFilter>
            fit
            label="CLI"
            name="harness"
            options={HARNESS_FILTERS}
            value={harness}
            onChoose={setHarness}
          />
        </div>
        <div className="min-w-0 flex-auto">
          <Segmented<DateFilter>
            fit
            label="Last active"
            name="date"
            options={DATE_FILTERS}
            value={date}
            onChoose={setDate}
          />
        </div>
      </div>
      {listed}
    </div>
  );
}

const listingResult = (
  answer:
    | {
        readonly kind: 'done';
        readonly value: { readonly conversations: readonly ImportableConversation[]; readonly matched: number };
      }
    | { readonly kind: 'refused'; readonly sentence: string },
): Listing =>
  answer.kind === 'done'
    ? { kind: 'read', rows: answer.value.conversations, matched: answer.value.matched }
    : { kind: 'refused', sentence: answer.sentence };

function ListingState({ listing }: { readonly listing: Exclude<Listing, { readonly kind: 'read' }> }) {
  return listing.kind === 'reading' ? (
    <p role="status" className="m-0 text-cell text-muted" data-continue-reading="">
      Searching…
    </p>
  ) : (
    <p role="alert" className="m-0 text-cell leading-base text-warn" data-continue-refused="">
      {listing.sentence}
    </p>
  );
}

/** A stopped ferret whose conversation the listing does not have: its name, where, and how it stopped. */
function SessionLines({ row, now }: { readonly row: StoppedSessionRow; readonly now: number }) {
  const { config, state } = row.view;
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-sm">
        <span className="min-w-0 flex-1 truncate text-row text-fg">{row.name}</span>
        <span className="mono shrink-0 text-meta text-faint" data-conversation-age="">
          {relativeTime(row.lastActivityAt, now)}
        </span>
      </span>
      <span className="flex min-w-0 items-baseline gap-1 overflow-hidden text-meta text-faint">
        <span className="max-w-[45%] shrink-0 truncate font-mono" title={config.cwd}>
          {folderLabel(config.cwd)}
        </span>
        <span className="shrink-0 whitespace-nowrap">
          · {HARNESS_SHORT[config.harness]} · {sessionStatusLabel(state.status)}
        </span>
      </span>
    </>
  );
}

interface ContinueRowProps {
  readonly rowKey: string;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly lines: ReactNode;
  /** The preview's read, or `undefined` for a row with no conversation to preview. */
  readonly preview: Preview | undefined;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly notes: ReactNode;
  readonly data: Readonly<Record<`data-${string}`, string>>;
}

/** One row: its lines are the tap target that opens the preview, which holds the button that continues it. */
function ContinueRow({
  rowKey,
  open,
  disabled,
  onToggle,
  lines,
  preview,
  actionLabel,
  onAction,
  notes,
  data,
}: ContinueRowProps) {
  const panelId = `fy-continue-${useId()}`;
  return (
    <li className="fy-convo-item">
      <button
        type="button"
        className="fy-convo-row disabled:opacity-70"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={onToggle}
        {...data}
      >
        <span className="fy-convo-main">{lines}</span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cn('shrink-0 text-faint transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div id={panelId} className="fy-convo-preview" data-continue-preview={rowKey}>
          <PreviewMessages preview={preview} />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={disabled}
              onClick={onAction}
              data-continue-action={rowKey}
            >
              {actionLabel}
            </Button>
          </div>
        </div>
      ) : null}
      {notes}
    </li>
  );
}

/** The last few exchanges, oldest first: the owner's words, then the reply that ended each turn. */
function PreviewMessages({ preview }: { readonly preview: Preview | undefined }) {
  if (preview === undefined)
    return <p className="m-0 text-meta text-muted">No preview of this ferret’s conversation is available.</p>;
  if (preview.kind === 'reading')
    return (
      <p role="status" className="m-0 text-meta text-muted">
        Reading the last messages…
      </p>
    );
  if (preview.kind === 'refused') return <p className="m-0 text-meta text-warn">{preview.sentence}</p>;
  const { messages } = preview.preview;
  if (messages.length === 0) return <p className="m-0 text-meta text-muted">Nothing was said in it yet.</p>;
  return (
    <ol className="fy-convo-exchanges" aria-label="Last messages">
      {messages.map((message, index) => (
        // A preview is a fixed, read-once list: its order is its identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <li key={index} className="fy-convo-exchange" data-role={message.role}>
          <span className="fy-convo-exchange__who">{message.role === 'user' ? 'You' : 'Agent'}</span>
          <span className="fy-convo-exchange__text">{message.text}</span>
        </li>
      ))}
    </ol>
  );
}
