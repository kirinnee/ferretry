/**
 * "Continue a conversation" (today New session › Continue; now on the Conversations screen): ONE list of Ferretry's conversations and stopped ferrets,
 * narrowed by the source chips (All · Ferretry · On this computer · Claude · Codex, see
 * `continue-model.ts`), the date and a search the daemon runs (`source=synced`, `q`, `harness`,
 * `since`). The list is read afresh every time Continue opens (never on a timer), so a conversation
 * started in the CLI's own terminal a minute ago is there. Each row is the shared conversation card.
 *
 * Each row says what it is about without asking anything: what the owner first said, the latest thing
 * they said, and where. Tapping a row opens a short preview of its last few exchanges with the button
 * that continues it. A conversation a ferret already keeps resumes (or opens) that ferret instead of
 * making a second one; any other is kept with `start: true` on a runtime that drives its CLI — the
 * only one, or one the person picks — and the new ferret opens on its full history.
 */

import { Button } from '@ferretry/app/ui';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { LinkableConversation, LinkPreview } from '../../contract/index.ts';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  CONTINUE_SOURCES,
  type ContinueEntry,
  type ContinueSource,
  continueEntries,
  conversationsQuery,
  keptConversationAction,
  keptConversationsQuery,
  ferretActivityAt,
} from './continue-model.ts';
import { ConversationLines, FerretLines, SourceChips } from './conversation-card.tsx';
import { noRuntimeSentence, type RuntimeField, Segmented } from './conversation-picker.tsx';
import { DATE_FILTERS, type DateFilter } from './conversation-picker-model.ts';
import { keepConversations, readConversationPreview, readLinkableConversations } from './conversations-api.ts';
import { guarded } from './link-ui.tsx';
import { harnessKeyOf } from './link-words.ts';

/** How many matches one search shows, newest first. */
const CONTINUE_LIMIT = 50;
/** How many kept conversations are read to describe the stopped ferrets. */
const KEPT_LIMIT = 1_000;
/** How long typing pauses before the daemon is searched. */
const SEARCH_DEBOUNCE_MS = 250;

export interface ContinueConversationProps {
  readonly client: Pick<PluginClient, 'call'>;
  /** The daemon this list is of: another daemon is another list. */
  readonly daemon: string;
  /** Opens one ferret's chat. */
  readonly onOpenFerret: (ferretId: string) => void;
  /** Which runtime a conversation continues on: `runtimeSlotField(daemon)` on a screen, a stand-in in tests. */
  readonly runtimeField: RuntimeField;
  /**
   * This machine's ferrets (`null` while the first read is out): they mark the conversations they keep and add the
   * stopped ones the listing does not describe.
   */
  readonly ferrets?: readonly FerretSummary[] | null;
  /** Resumes a stopped ferret in place. */
  readonly resume?: (ferretId: string) => Promise<void>;
  /** Supplied in tests. */
  readonly now?: () => number;
  readonly debounceMs?: number;
}

type Listing =
  | { readonly kind: 'reading' }
  | { readonly kind: 'refused'; readonly sentence: string }
  | {
      readonly kind: 'read';
      readonly rows: readonly LinkableConversation[];
      readonly matched: number;
      /** `false` when "Keep in sync" is off, so the computer's conversations are not in the rows. */
      readonly computerListed: boolean;
    };

/** A picked row waiting for its runtime, or the sentence saying why it can't continue. */
type Picking =
  | { readonly kind: 'runtime'; readonly row: LinkableConversation; readonly draft: string }
  | { readonly kind: 'issue'; readonly key: string; readonly sentence: string };

type Preview =
  | { readonly kind: 'reading' }
  | { readonly kind: 'refused'; readonly sentence: string }
  | { readonly kind: 'read'; readonly preview: LinkPreview };

const conversationKey = (harness: string, id: string): string => `conversation:${harness}:${id}`;
const ferretKey = (id: string): string => `ferret:${id}`;

/** Continue for one machine: another machine is another list, so none of this machine's state carries over. */
export function ContinueConversation(props: ContinueConversationProps) {
  return <ContinueConversationBody key={props.daemon} {...props} />;
}

function ContinueConversationBody({
  client,
  onOpenFerret,
  runtimeField,
  ferrets,
  resume,
  now = Date.now,
  debounceMs = SEARCH_DEBOUNCE_MS,
}: ContinueConversationProps) {
  const [source, setSource] = useState<ContinueSource>('all');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [date, setDate] = useState<DateFilter>('any');
  const [results, setResults] = useState<Listing>({ kind: 'reading' });
  const [kept, setKept] = useState<Listing>({ kind: 'reading' });
  const [picking, setPicking] = useState<Picking | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previews, setPreviews] = useState<ReadonlyMap<string, Preview>>(new Map());
  const searchId = useId();
  const runtimeLabelId = useId();
  const runtimeInputId = useId();
  const clock = useRef(now);
  clock.current = now;

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), debounceMs);
    return () => clearTimeout(timer);
  }, [text, debounceMs]);

  useEffect(() => {
    if (source === 'ferretry') return;
    let live = true;
    setResults({ kind: 'reading' });
    const search = conversationsQuery(source, { text: query, date }, clock.current(), CONTINUE_LIMIT);
    void guarded(() => readLinkableConversations(client, search)).then(answer => {
      if (live) setResults(listingResult(answer));
    });
    return () => {
      live = false;
    };
  }, [client, source, query, date]);

  useEffect(() => {
    let live = true;
    void guarded(() => readLinkableConversations(client, keptConversationsQuery(KEPT_LIMIT))).then(answer => {
      if (live) setKept(listingResult(answer));
    });
    return () => {
      live = false;
    };
  }, [client]);

  const toggle = (key: string, conversation: LinkableConversation | undefined): void => {
    setPicking(null);
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (conversation === undefined || previews.has(key)) return;
    setPreviews(current => new Map(current).set(key, { kind: 'reading' }));
    void guarded(() => readConversationPreview(client, conversation.harness, conversation.id)).then(answer => {
      const preview: Preview =
        answer.kind === 'done'
          ? { kind: 'read', preview: answer.value }
          : { kind: 'refused', sentence: answer.sentence };
      setPreviews(current => new Map(current).set(key, preview));
    });
  };

  const resumeFerret = async (key: string, ferretId: string): Promise<void> => {
    if (resume === undefined) return;
    setBusy(key);
    setPicking(null);
    try {
      await resume(ferretId);
      onOpenFerret(ferretId);
    } catch (error) {
      setBusy(null);
      setPicking({
        kind: 'issue',
        key,
        sentence: error instanceof Error && error.message !== '' ? error.message : 'The ferret could not resume.',
      });
    }
  };

  const keep = async (row: LinkableConversation, wrapper: string): Promise<void> => {
    const key = conversationKey(row.harness, row.id);
    setBusy(key);
    setPicking(null);
    const answer = await guarded(() =>
      keepConversations(client, {
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
    const [made] = answer.value.kept;
    if (made !== undefined) {
      onOpenFerret(made.ferret);
      return;
    }
    const [refused] = answer.value.refused;
    setPicking({ kind: 'issue', key, sentence: refused?.reason ?? 'This machine didn’t keep it.' });
  };

  const continueConversation = (row: LinkableConversation): void => {
    const key = conversationKey(row.harness, row.id);
    if (row.keptBy !== undefined) {
      if (keptConversationAction(row, ferrets ?? []) === 'resume') void resumeFerret(key, row.keptBy);
      else onOpenFerret(row.keptBy);
      return;
    }
    // A harness this app has no runtime picker for cannot be continued here.
    if (harnessKeyOf(row.harness) === undefined)
      setPicking({ kind: 'issue', key, sentence: `This app can’t continue a ${row.harness} conversation.` });
    else setPicking({ kind: 'runtime', row, draft: '' });
  };

  const runtimeNote = (row: LinkableConversation, draft: string): ReactNode => {
    const harness = harnessKeyOf(row.harness);
    if (harness === undefined) return null;
    const wrapper = draft.trim();
    return (
      <div className="fy-convo-note flex min-w-0 flex-col gap-1" data-continue-runtimes={row.id}>
        <label id={runtimeLabelId} htmlFor={runtimeInputId} className="m-0 text-cell text-fg">
          Continue on which runtime?
        </label>
        {runtimeField({
          harness,
          value: draft,
          onValueChange: next => setPicking({ kind: 'runtime', row, draft: next }),
          onChosen: () => undefined,
          fallbackId: runtimeInputId,
          labelId: runtimeLabelId,
          fallbackPlaceholder: 'a runtime',
          noAccounts: (
            <p className="m-0 text-cell text-warn" data-continue-no-runtime="">
              {noRuntimeSentence(harness)}
            </p>
          ),
        })}
        <div>
          <Button
            type="button"
            size="sm"
            data-continue-on-runtime={wrapper}
            disabled={wrapper === '' || busy !== null}
            onClick={() => void keep(row, wrapper)}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  };

  const at = now();
  const notes = (key: string): ReactNode => (
    <>
      {picking?.kind === 'runtime' && conversationKey(picking.row.harness, picking.row.id) === key
        ? runtimeNote(picking.row, picking.draft)
        : null}
      {picking?.kind === 'issue' && picking.key === key ? (
        <p role="alert" className="fy-convo-note m-0 text-cell text-warn" data-continue-issue={key}>
          {picking.sentence}
        </p>
      ) : null}
    </>
  );

  const entryRow = (entry: ContinueEntry): ReactNode => {
    if (entry.kind === 'ferret') {
      const { view, ferret } = entry;
      const key = ferretKey(view.id);
      return (
        <ContinueRow
          key={key}
          rowKey={key}
          open={expanded === key}
          disabled={busy !== null}
          onToggle={() => toggle(key, undefined)}
          lines={
            <FerretLines
              ferret={ferret}
              harness={view.harness}
              cwd={view.folder}
              lastActivityAt={ferretActivityAt(view)}
              now={at}
            />
          }
          preview={undefined}
          actionLabel={busy === key ? 'Resuming…' : 'Resume'}
          onAction={() => void resumeFerret(key, view.id)}
          notes={notes(key)}
          data={{ 'data-continue-ferret': view.id }}
        />
      );
    }
    const row = entry.conversation;
    const key = conversationKey(row.harness, row.id);
    const action = row.keptBy === undefined ? 'keep' : keptConversationAction(row, ferrets ?? []);
    return (
      <ContinueRow
        key={key}
        rowKey={key}
        open={expanded === key}
        disabled={busy !== null}
        onToggle={() => toggle(key, row)}
        lines={
          <ConversationLines row={row} now={at} {...(entry.ferret === undefined ? {} : { ferret: entry.ferret })} />
        }
        preview={previews.get(key)}
        actionLabel={
          busy === key
            ? 'Starting…'
            : action === 'keep'
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
  };

  const computerHidden = results.kind === 'read' && !results.computerListed;
  const listed = (() => {
    // Ferretry reads only the kept listing; when it is refused, the stopped ferrets are still listed bare.
    if (source !== 'ferretry' && results.kind !== 'read') return <ListingState listing={results} />;
    if (kept.kind === 'reading' || ferrets === null) return <ListingState listing={{ kind: 'reading' }} />;
    const searched = source !== 'ferretry' && results.kind === 'read' ? results : undefined;
    const entries = continueEntries(
      {
        source,
        searched: searched?.rows ?? [],
        kept: kept.kind === 'read' ? kept.rows : [],
        ferrets: ferrets ?? [],
        search: { text: query, date },
      },
      at,
    );
    if (entries.length === 0)
      return (
        <p className="m-0 text-cell text-muted" data-continue-empty="">
          {source === 'ferretry' && query === '' && date === 'any'
            ? 'No ferret keeps a conversation yet, and none is stopped.'
            : source === 'computer' && query === '' && date === 'any' && computerHidden
              ? 'Nothing to show: Keep in sync is off.'
              : 'No conversation matches.'}
        </p>
      );
    const more = searched !== undefined && source !== 'computer' && searched.matched > searched.rows.length;
    return (
      <>
        <p className="m-0 text-meta text-muted" data-continue-count="">
          {`${entries.length} ${entries.length === 1 ? 'conversation' : 'conversations'}`}
          {more ? ` · newest ${searched.rows.length} of ${searched.matched}` : ''}
        </p>
        <ul className="kt-panel fy-session-group__list fy-convo-list">{entries.map(entryRow)}</ul>
      </>
    );
  })();

  return (
    <div className="flex min-w-0 flex-col gap-3" data-continue-conversation="">
      <SourceChips
        options={CONTINUE_SOURCES}
        value={source}
        onChoose={choice => {
          setSource(choice);
          setExpanded(null);
          setPicking(null);
        }}
      />
      <div className="flex min-w-0 flex-wrap gap-2" data-continue-filters="">
        <label htmlFor={searchId} className="sr-only">
          Search your conversations
        </label>
        <input
          id={searchId}
          type="search"
          className="kt-input min-w-0 flex-[1_1_12rem]"
          placeholder="Name, words or folder"
          autoComplete="off"
          data-continue-search=""
          value={text}
          onChange={event => setText(event.target.value)}
        />
        <div className="min-w-0 flex-[0_0_auto]">
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
      {computerHidden && source !== 'ferretry' ? (
        <p className="m-0 text-meta text-muted" data-continue-computer-hidden="">
          Conversations on this computer are hidden. Turn on Keep in sync in Settings › Machine › Conversations.
        </p>
      ) : null}
      {listed}
    </div>
  );
}

const listingResult = (
  answer:
    | {
        readonly kind: 'done';
        readonly value: {
          readonly conversations: readonly LinkableConversation[];
          readonly matched: number;
          readonly computerListed?: false;
        };
      }
    | { readonly kind: 'refused'; readonly sentence: string },
): Listing =>
  answer.kind === 'done'
    ? {
        kind: 'read',
        rows: answer.value.conversations,
        matched: answer.value.matched,
        computerListed: answer.value.computerListed !== false,
      }
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
    <li className="fy-convo-item" data-open={open ? '' : undefined}>
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
        {open ? (
          <ChevronUp size={16} aria-hidden="true" className="shrink-0 text-faint" />
        ) : (
          <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-faint" />
        )}
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
