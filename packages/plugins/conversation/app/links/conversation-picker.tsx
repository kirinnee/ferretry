/**
 * "Keep conversations": the Claude Code or Codex conversations already on this machine, each of which can be KEPT as a
 * ferret — a ferret that reads the harness's own file (a link), so Chat shows the same history. Nothing is ticked to
 * start with, a kept ferret stays stopped unless "Start now" is on, and at most ten start at once.
 *
 * Drawn on the Conversations screen (`screens.links`); today Settings › Runtimes and the onboarding step showed it.
 */

import { PanelSlot, statusLabel, useSlotHasPanels } from '@ferretry/app';
import { MOVE_ACCOUNT_SLOT, type MoveAccountSlotProps } from '@ferretry/core-ferrets/contract';
import { Button, cn } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { CONVERSATION_LAUNCH_MAX, type KeepResult, type LinkableConversation } from '../../contract/index.ts';

import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { ConversationLines } from './conversation-card.tsx';
import {
  keepRequest,
  DATE_FILTERS,
  type DateFilter,
  EMPTY_FILTER,
  EMPTY_SELECTION,
  foundLine,
  keepButtonLabel,
  type PickerFilter,
  type PickerSelection,
  RECENT_LIMIT,
  START_LIMIT_HINT,
  selectLastDays,
  toggleKeep,
  toggleStart,
  visibleConversations,
} from './conversation-picker-model.ts';
import { keepConversations, readLinkableConversations } from './conversations-api.ts';
import { guarded, LinkNote } from './link-ui.tsx';
import { HARNESS_NAMES, type HarnessKey } from './link-words.ts';

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
  readonly options: readonly {
    readonly id: T;
    readonly label: string;
    readonly title?: string;
    /** Shown but not choosable. */
    readonly disabled?: boolean;
  }[];
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
          disabled={option.disabled}
          data-segment={option.id}
          onClick={() => onChoose(option.id)}
          className={cn(
            'h-control-sm min-w-0 whitespace-nowrap rounded-control px-2 text-ui font-medium transition-colors',
            fit ? 'flex-auto' : 'flex-1',
            option.id === value ? 'bg-surface text-fg shadow-control' : 'text-muted hover:text-fg',
            option.disabled === true && 'cursor-not-allowed opacity-60 hover:text-muted',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The runtime field. Runtimes is not a need of Conversation, so the picker does not read the machine's runtimes: it
 * mounts the slot Ferrets offers for "which runtime of this harness?" (`ferrets.move-account`), where Runtimes
 * contributes its picker. Neither half imports the other; where no panel is placed the field is a typed runtime name.
 */
export type RuntimeField = (props: MoveAccountSlotProps) => ReactNode;

function RuntimeSlot({ daemon, field }: { readonly daemon: string; readonly field: MoveAccountSlotProps }) {
  const placed = useSlotHasPanels(MOVE_ACCOUNT_SLOT);
  if (placed) return <PanelSlot daemon={daemon} slot={MOVE_ACCOUNT_SLOT} props={{ ...field }} />;
  return (
    <input
      id={field.fallbackId}
      type="text"
      className="kt-input w-full font-mono"
      autoComplete="off"
      spellCheck={false}
      placeholder={field.fallbackPlaceholder}
      data-runtime-typed=""
      value={field.value}
      onChange={event => field.onValueChange(event.target.value)}
    />
  );
}

export const runtimeSlotField =
  (daemon: string): RuntimeField =>
  props => <RuntimeSlot daemon={daemon} field={props} />;

/** What the runtime field shows when the machine has no runtime of this harness. */
export const noRuntimeSentence = (harness: HarnessKey): string =>
  `No ${HARNESS_NAMES[harness]} runtime on this machine yet. Add one in Settings › Runtimes, then try again.`;

export interface ConversationPickerProps {
  readonly client: Pick<PluginClient, 'call'>;
  readonly harness: HarnessKey;
  /** The runtime picker: `runtimeSlotField(daemon)` on a screen, a stand-in in tests. */
  readonly runtimeField: RuntimeField;
  /** A runtime already chosen for these ferrets (its wrapper): no runtime picker is shown. */
  readonly runtime?: string;
  /** Supplied in tests. */
  readonly now?: () => number;
}

type Listing =
  | { readonly kind: 'reading' }
  | { readonly kind: 'refused'; readonly sentence: string }
  | { readonly kind: 'read'; readonly rows: readonly LinkableConversation[] };

export function ConversationPicker({
  client,
  harness,
  runtimeField,
  runtime,
  now = Date.now,
}: ConversationPickerProps) {
  const [listing, setListing] = useState<Listing>({ kind: 'reading' });
  const [filter, setFilter] = useState<PickerFilter>(EMPTY_FILTER);
  const [selection, setSelection] = useState<PickerSelection>(EMPTY_SELECTION);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeepResult | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const searchId = useId();
  const runtimeLabelId = useId();
  const runtimeInputId = useId();
  const name = HARNESS_NAMES[harness];

  const load = useCallback(async (): Promise<void> => {
    const answer = await guarded(() => readLinkableConversations(client, { harness, limit: PICKER_READ_LIMIT }));
    setListing(
      answer.kind === 'done'
        ? { kind: 'read', rows: answer.value.conversations }
        : { kind: 'refused', sentence: answer.sentence },
    );
  }, [client, harness]);

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
      <LinkNote live tone="warn" name="conversations-refused" title="Couldn’t read your conversations">
        <span>{listing.sentence}</span>
        <div className="mt-2">
          <Button type="button" size="sm" data-conversations-retry="" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </LinkNote>
    );
  if (listing.rows.length === 0)
    return (
      <LinkNote name="conversations-empty">
        <span>No {name} conversations on this machine.</span>
      </LinkNote>
    );

  const at = now();
  const rows = listing.rows;
  const visible = visibleConversations(rows, filter, at);
  const chosenRuntime = runtime ?? (draft.trim() === '' ? null : draft.trim());
  const count = selection.keep.length;
  const startFull = selection.start.length >= CONVERSATION_LAUNCH_MAX;
  const set = (patch: Partial<PickerFilter>): void => setFilter(current => ({ ...current, ...patch }));

  const keep = (row: LinkableConversation, on: boolean): void => setSelection(current => toggleKeep(current, row, on));
  // The switch is disabled past the launch limit and shown only on a kept row, so a refusal never reaches here.
  const start = (id: string, on: boolean): void => {
    const next = toggleStart(selection, id, on);
    if (next.kind === 'ok') setSelection(next.selection);
  };

  const send = async (wrapper: string): Promise<void> => {
    setBusy(true);
    setIssue(null);
    const answer = await guarded(() => keepConversations(client, keepRequest(harness, wrapper, selection)));
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
      {result === null ? null : <KeepSummary result={result} />}
      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor={searchId} className="sr-only">
          Search conversations
        </label>
        <input
          id={searchId}
          type="search"
          className="kt-input w-full"
          placeholder="Search names, messages and folders"
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
        {runtime !== undefined ? null : (
          <div className="flex min-w-0 flex-col gap-1" data-conversations-runtime="">
            <label id={runtimeLabelId} htmlFor={runtimeInputId} className="text-cell font-semibold text-fg">
              Runtime
            </label>
            {runtimeField({
              harness,
              value: draft,
              onValueChange: setDraft,
              onChosen: () => undefined,
              fallbackId: runtimeInputId,
              labelId: runtimeLabelId,
              fallbackPlaceholder: `a ${name} runtime`,
              noAccounts: (
                <p className="m-0 text-cell text-warn" data-conversations-no-runtime="">
                  {noRuntimeSentence(harness)}
                </p>
              ),
            })}
          </div>
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
  readonly row: LinkableConversation;
  readonly now: number;
  readonly kept: boolean;
  readonly starting: boolean;
  readonly startFull: boolean;
  readonly onKeep: (on: boolean) => void;
  readonly onStart: (on: boolean) => void;
}) {
  const alreadyKept = row.keptBy !== undefined;
  const id = useId();
  return (
    <li
      className="fy-convo-item fy-convo-pick"
      data-selected={kept ? '' : undefined}
      data-conversation-row={row.id}
      data-conversation-kept={row.keptBy}
    >
      <label htmlFor={id} className="fy-convo-main cursor-pointer">
        <ConversationLines
          row={row}
          now={now}
          {...(row.keptBy === undefined ? {} : { ferret: { id: row.keptBy, name: row.keptBy } })}
        />
      </label>
      <div className="fy-convo-controls">
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
          disabled={alreadyKept}
          data-conversation-keep={row.id}
          onChange={event => onKeep(event.target.checked)}
        />
      </div>
    </li>
  );
}

/** What the keep did: the ferrets it made, and each conversation it refused with why. */
function KeepSummary({ result }: { readonly result: KeepResult }) {
  return (
    <LinkNote
      live
      tone={result.refused.length === 0 ? 'ok' : 'warn'}
      name="conversations-result"
      title={`Kept ${result.kept.length} as ${result.kept.length === 1 ? 'a ferret' : 'ferrets'}`}
    >
      {result.kept.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-conversations-kept="">
          {result.kept.map(item => (
            <li key={item.id} className="[overflow-wrap:anywhere]">
              <span className="font-mono text-fg">{item.name}</span> · {statusLabel(item.state)}
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
    </LinkNote>
  );
}

const HARNESS_CHOICES: readonly { readonly id: HarnessKey; readonly label: string }[] = [
  { id: 'claude-code', label: HARNESS_NAMES['claude-code'] },
  { id: 'codex', label: HARNESS_NAMES.codex },
];

/** Keep conversations (today's Settings › Runtimes › Import conversations): which harness's conversations, and the picker. */
export function KeepConversations({ client, runtimeField, now }: Omit<ConversationPickerProps, 'harness' | 'runtime'>) {
  const [harness, setHarness] = useState<HarnessKey>('claude-code');
  return (
    <section className="flex min-w-0 flex-col gap-4" data-keep-conversations="">
      <div>
        <h3 className="m-0 text-title font-semibold text-fg">Keep conversations</h3>
        <p className="m-0 mt-1 text-cell leading-base text-muted">
          Keep earlier conversations as ferrets. Each one resumes the same history; nothing is copied.
        </p>
      </div>
      <Segmented<HarnessKey>
        label="CLI"
        name="harness"
        options={HARNESS_CHOICES}
        value={harness}
        onChoose={setHarness}
      />
      <ConversationPicker
        key={harness}
        client={client}
        harness={harness}
        runtimeField={runtimeField}
        {...(now === undefined ? {} : { now })}
      />
    </section>
  );
}
