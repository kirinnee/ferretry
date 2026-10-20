/**
 * "Import conversations": the Claude Code or Codex conversations already on this machine, each of which
 * can be KEPT as a ferret — a Ferretry session that resumes the CLI's own file, so Chat shows the same
 * history. Nothing is ticked to start with, a kept ferret stays stopped unless "Start now" is on, and at
 * most ten start at once.
 *
 * Shown by the onboarding step for a CLI once it has a runtime, and by Settings › Runtimes.
 */

import type { ConversationAdoptResult, FleetRuntimeView, Harness, ImportableConversation } from '@ferretry/protocol';
import { CONVERSATION_LAUNCH_MAX } from '@ferretry/protocol';
import { ChevronLeft } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { relativeTime, sessionStatusLabel } from '../../../lib/session-screens.ts';
import { Button } from '../../../shell/primitives.tsx';
import { HARNESS_SHORT } from '../credentials/credentials-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { useSetupAccess } from '../setup/setup-access.ts';
import { SetupNote } from '../setup/setup-ui.tsx';
import { SETUP_HARNESS_NAMES } from '../setup/setup-words.ts';
import {
  adoptRequest,
  conversationHeadline,
  DATE_FILTERS,
  type DateFilter,
  EMPTY_FILTER,
  EMPTY_SELECTION,
  folderLabel,
  foundLine,
  keepButtonLabel,
  type PickerFilter,
  type PickerSelection,
  RECENT_LIMIT,
  runtimeChoice,
  START_LIMIT_HINT,
  selectLastDays,
  toggleKeep,
  toggleStart,
  visibleConversations,
} from './conversation-picker-model.ts';
import { adoptConversations, readImportableConversations } from './conversations-api.ts';

/** The most rows one listing read asks for; the picker filters them here. */
const PICKER_READ_LIMIT = 5_000;

/** A row of pressed/unpressed buttons: one choice of a few, like the session Mode. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChoose,
  name,
  fit = false,
}: {
  readonly label: string;
  readonly options: readonly { readonly id: T; readonly label: string; readonly title?: string }[];
  readonly value: T;
  readonly onChoose: (value: T) => void;
  readonly name: string;
  /** Segments take the width their words need instead of sharing the row equally. */
  readonly fit?: boolean;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-segmented={name}
      className="flex min-w-0 gap-1 rounded-control border border-border bg-surface-2 p-0.5"
    >
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          title={option.title}
          data-segment={option.id}
          onClick={() => onChoose(option.id)}
          className={cn(
            'h-control-sm min-w-0 whitespace-nowrap rounded-control px-2 text-ui font-medium transition-colors',
            fit ? 'flex-auto' : 'flex-1',
            option.id === value ? 'bg-surface text-fg shadow-control' : 'text-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A conversation in at most three short lines, shared by the picker and Continue. First: its NAME (the
 * CLI's title, or the ferret's own when `title` is given) and how long ago it last moved. Second: the
 * first thing the owner said, or the conversation's name under a ferret's. A conversation that was never
 * named is headed by its first message instead and, when it moved on since, shows the latest thing the
 * owner said so two rows that began alike still read apart. Third, faint: its folder (the last two
 * segments, which give way first), the CLI, the turns and the model.
 */
export function ConversationLines({
  row,
  now,
  title,
}: {
  readonly row: ImportableConversation;
  readonly now: number;
  /** Heads the row in place of the conversation's name: the ferret's name, on a row that is a ferret. */
  readonly title?: string;
}) {
  const turns = `${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}`;
  const { headline, secondary, named } = conversationHeadline(row, title);
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-sm">
        <span
          className={cn('min-w-0 flex-1 truncate text-row', named ? 'font-medium text-fg' : 'text-fg')}
          title={headline}
          data-conversation-name={named ? '' : undefined}
        >
          {headline}
        </span>
        <span className="mono shrink-0 text-meta text-faint" data-conversation-age="">
          {relativeTime(row.lastActivityAt, now)}
        </span>
      </span>
      {secondary === undefined ? null : (
        <span className="min-w-0 truncate text-meta text-muted" title={secondary} data-conversation-first="">
          {secondary}
        </span>
      )}
      {named || row.latest === undefined ? null : (
        <span className="min-w-0 truncate text-meta text-muted" title={row.latest} data-conversation-latest="">
          <span className="sr-only">Latest: </span>
          {row.latest}
        </span>
      )}
      <span className="flex min-w-0 items-baseline gap-1 overflow-hidden text-meta text-faint">
        <span className="max-w-[45%] shrink-0 truncate font-mono" title={row.project}>
          {folderLabel(row.project)}
        </span>
        <span className="shrink-0 whitespace-nowrap">
          · {HARNESS_SHORT[row.harness]} · {turns}
        </span>
        {row.model === undefined ? null : <span className="min-w-0 truncate">· {row.model}</span>}
      </span>
    </>
  );
}

export interface ConversationPickerProps {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly harness: Harness;
  /** The machine's runtimes; the picker offers the ones that drive `harness`. */
  readonly runtimes: readonly FleetRuntimeView[];
  /** A runtime already chosen for these ferrets (its wrapper): no runtime picker is shown. */
  readonly runtime?: string;
  /** Supplied in tests. */
  readonly now?: () => number;
}

type Listing =
  | { readonly kind: 'reading' }
  | { readonly kind: 'refused'; readonly sentence: string }
  | { readonly kind: 'read'; readonly rows: readonly ImportableConversation[] };

export function ConversationPicker({
  connection,
  createClient,
  harness,
  runtimes,
  runtime,
  now = Date.now,
}: ConversationPickerProps) {
  const access = useSetupAccess({ connection, createClient });
  const { read, act } = access;
  const [listing, setListing] = useState<Listing>({ kind: 'reading' });
  const [filter, setFilter] = useState<PickerFilter>(EMPTY_FILTER);
  const [selection, setSelection] = useState<PickerSelection>(EMPTY_SELECTION);
  const choice = runtimeChoice(runtimes, harness);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConversationAdoptResult | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const searchId = useId();
  const name = SETUP_HARNESS_NAMES[harness];

  const load = useCallback(async (): Promise<void> => {
    const answer = await read(client => readImportableConversations(client, { harness, limit: PICKER_READ_LIMIT }));
    setListing(
      answer.kind === 'done'
        ? { kind: 'read', rows: answer.value.conversations }
        : { kind: 'refused', sentence: answer.sentence },
    );
  }, [read, harness]);

  useEffect(() => {
    void load();
  }, [load]);

  if (listing.kind === 'reading')
    return (
      <p role="status" className="m-0 text-cell text-muted" data-conversations-reading="">
        Looking for {name} conversations…
      </p>
    );
  if (listing.kind === 'refused')
    return (
      <SetupNote live tone="warn" name="conversations-refused" title="Couldn’t read your conversations">
        <span>{listing.sentence}</span>
        <div className="mt-2">
          <Button type="button" size="sm" data-conversations-retry="" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </SetupNote>
    );
  if (listing.rows.length === 0)
    return (
      <SetupNote name="conversations-empty">
        <span>No {name} conversations on this machine.</span>
      </SetupNote>
    );

  const at = now();
  const rows = listing.rows;
  const visible = visibleConversations(rows, filter, at);
  const chosenRuntime = runtime ?? picked ?? (choice.kind === 'one' ? choice.runtime.wrapper : undefined) ?? null;
  const count = selection.keep.length;
  const startFull = selection.start.length >= CONVERSATION_LAUNCH_MAX;
  const set = (patch: Partial<PickerFilter>): void => setFilter(current => ({ ...current, ...patch }));

  const keep = (row: ImportableConversation, on: boolean): void =>
    setSelection(current => toggleKeep(current, row, on));
  // The switch is disabled past the launch limit and shown only on a kept row, so a refusal never reaches here.
  const start = (id: string, on: boolean): void => {
    const next = toggleStart(selection, id, on);
    if (next.kind === 'ok') setSelection(next.selection);
  };

  const send = async (wrapper: string): Promise<void> => {
    setBusy(true);
    setIssue(null);
    const answer = await act(client => adoptConversations(client, adoptRequest(harness, wrapper, selection)));
    setBusy(false);
    if (answer.kind === 'refused') {
      setIssue(answer.sentence);
      return;
    }
    setResult(answer.value);
    setSelection(EMPTY_SELECTION);
    await load();
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-conversation-picker={harness}>
      <p className="m-0 text-row font-semibold text-fg" data-conversations-found="">
        {foundLine(rows)}
      </p>
      {result === null ? null : <AdoptSummary result={result} />}
      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor={searchId} className="sr-only">
          Search conversations
        </label>
        <input
          id={searchId}
          type="search"
          className="kt-input w-full"
          placeholder="Search messages and folders"
          autoComplete="off"
          data-conversations-search=""
          value={filter.text}
          onChange={event => set({ text: event.target.value })}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="w-40 min-w-0">
            <Segmented<DateFilter>
              fit
              label="Last active"
              name="date"
              options={DATE_FILTERS}
              value={filter.date}
              onChoose={date => set({ date })}
            />
          </div>
          <Button
            type="button"
            size="sm"
            data-conversations-last-week=""
            onClick={() => setSelection(current => selectLastDays(rows, current, at, 7))}
          >
            Select last 7 days
          </Button>
          {visible.hidden === 0 && !filter.showAll ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-conversations-show-all=""
              onClick={() => set({ showAll: !filter.showAll })}
            >
              {filter.showAll ? `Show recent ${RECENT_LIMIT}` : 'Show all'}
            </Button>
          )}
        </div>
      </div>

      {visible.rows.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-conversations-no-match="">
          No conversation matches.
        </p>
      ) : (
        <ul className="kt-panel fy-session-group__list fy-convo-list" data-conversation-list="">
          {visible.rows.map(row => (
            <ConversationRow
              key={row.id}
              row={row}
              now={at}
              kept={selection.keep.includes(row.id)}
              starting={selection.start.includes(row.id)}
              startFull={startFull}
              onKeep={on => keep(row, on)}
              onStart={on => start(row.id, on)}
            />
          ))}
        </ul>
      )}

      <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
        {runtime !== undefined || choice.kind !== 'several' ? null : (
          <Segmented<string>
            label="Runtime"
            name="runtime"
            options={choice.runtimes.map(item => ({ id: item.wrapper, label: item.name }))}
            value={chosenRuntime ?? ''}
            onChoose={setPicked}
          />
        )}
        {runtime !== undefined || choice.kind !== 'none' ? null : (
          <p className="m-0 text-cell text-warn" data-conversations-no-runtime="">
            {choice.sentence}
          </p>
        )}
        <p className="m-0 text-meta text-muted">{START_LIMIT_HINT}</p>
        {issue === null ? null : (
          <p role="alert" className="m-0 text-cell text-warn" data-conversations-issue="">
            {issue}
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="primary"
            data-conversations-keep=""
            disabled={busy || count === 0 || chosenRuntime === null}
            onClick={() => void send(chosenRuntime as string)}
          >
            {busy ? 'Keeping…' : keepButtonLabel(count)}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConversationRow({
  row,
  now,
  kept,
  starting,
  startFull,
  onKeep,
  onStart,
}: {
  readonly row: ImportableConversation;
  readonly now: number;
  readonly kept: boolean;
  readonly starting: boolean;
  readonly startFull: boolean;
  readonly onKeep: (on: boolean) => void;
  readonly onStart: (on: boolean) => void;
}) {
  const adopted = row.adoptedBy !== undefined;
  const id = useId();
  return (
    <li
      className={cn('fy-convo-item fy-convo-pick', kept && 'bg-accent-soft', adopted && 'opacity-70')}
      data-conversation-row={row.id}
    >
      <label htmlFor={id} className="fy-convo-main cursor-pointer">
        <ConversationLines row={row} now={now} />
      </label>
      <div className="fy-convo-controls">
        {adopted ? (
          <span className="[overflow-wrap:anywhere] text-meta text-muted" data-conversation-adopted={row.adoptedBy}>
            Kept as <span className="font-mono">{row.adoptedBy}</span>
          </span>
        ) : null}
        {kept ? (
          <button
            type="button"
            role="switch"
            aria-checked={starting}
            disabled={!starting && startFull}
            data-conversation-start={row.id}
            onClick={() => onStart(!starting)}
            className={cn(
              'flex min-h-control items-center gap-2 rounded-control border px-2 py-1 text-left',
              starting ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2',
              !starting && startFull ? 'cursor-not-allowed opacity-70' : 'hover:border-accent',
            )}
          >
            <span className={cn('text-meta font-semibold', starting ? 'text-accent' : 'text-fg')}>Start now</span>
            <span
              aria-hidden="true"
              className={cn(
                'relative h-5 w-9 shrink-0 rounded-full border',
                starting ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
              )}
            >
              <span
                className={cn(
                  'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg',
                  starting ? 'right-0.5' : 'left-0.5',
                )}
              />
            </span>
          </button>
        ) : null}
        <input
          id={id}
          type="checkbox"
          className="shrink-0"
          title="Keep as a ferret"
          checked={kept}
          disabled={adopted}
          data-conversation-keep={row.id}
          onChange={event => onKeep(event.target.checked)}
        />
      </div>
    </li>
  );
}

/** What the adoption did: the ferrets it made, and each conversation it refused with why. */
function AdoptSummary({ result }: { readonly result: ConversationAdoptResult }) {
  return (
    <SetupNote
      live
      tone={result.refused.length === 0 ? 'ok' : 'warn'}
      name="conversations-result"
      title={`Kept ${result.adopted.length} as ${result.adopted.length === 1 ? 'a ferret' : 'ferrets'}`}
    >
      {result.adopted.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-conversations-adopted="">
          {result.adopted.map(item => (
            <li key={item.id} className="[overflow-wrap:anywhere]">
              <span className="font-mono text-fg">{item.name}</span> · {sessionStatusLabel(item.status)}
            </li>
          ))}
        </ul>
      )}
      {result.refused.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-conversations-refused="">
          {result.refused.map(item => (
            <li key={item.id} className="[overflow-wrap:anywhere]">
              <span className="font-mono">{item.id}</span>: {item.reason}
            </li>
          ))}
        </ul>
      )}
    </SetupNote>
  );
}

const HARNESS_CHOICES: readonly { readonly id: Harness; readonly label: string }[] = [
  { id: 'claude', label: SETUP_HARNESS_NAMES.claude },
  { id: 'codex', label: SETUP_HARNESS_NAMES.codex },
];

/** Settings › Runtimes › Import conversations: which CLI's conversations, the picker, and a way back. */
export function ImportConversations({
  connection,
  createClient,
  runtimes,
  onBack,
  now,
}: Omit<ConversationPickerProps, 'harness' | 'runtime'> & { readonly onBack: () => void }) {
  const [harness, setHarness] = useState<Harness>('claude');
  return (
    <section className="flex min-w-0 flex-col gap-4" data-import-conversations="">
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="kt-btn--flush-start"
          data-page-back=""
          onClick={onBack}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Runtimes
        </Button>
        <h3 className="m-0 mt-2 text-title font-semibold text-fg">Import conversations</h3>
        <p className="m-0 mt-1 text-cell leading-base text-muted">
          Keep earlier conversations as ferrets. Each one resumes the same history; nothing is copied.
        </p>
      </div>
      <Segmented<Harness> label="CLI" name="harness" options={HARNESS_CHOICES} value={harness} onChoose={setHarness} />
      <ConversationPicker
        key={harness}
        connection={connection}
        createClient={createClient}
        harness={harness}
        runtimes={runtimes}
        {...(now === undefined ? {} : { now })}
      />
    </section>
  );
}
