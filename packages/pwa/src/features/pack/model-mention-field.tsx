/**
 * A MODELS GUIDE FIELD THAT KNOWS MODEL NAMES: as somebody types, a word naming a model the fleet
 * knows is marked — in the accent when a runtime here runs it, muted when it is listed but nowhere on
 * this machine — and a word that LOOKS like a model nobody lists is red and underlined. A list of every
 * model across every provider opens under the field to complete the word.
 *
 * Native editing is kept: the field is a real `<textarea>` (or `<input>`) whose own glyphs are
 * transparent, over a mirror that draws the same text, wrapped the same way, with the marks coloured.
 * The mirror is `aria-hidden`; what a screen reader gets instead is the field itself as a combobox, the
 * listbox it controls, and the line under it naming every model the text mentions — which is also
 * where a pointer finds "not on this machine", since nothing under the field can be hovered.
 */

import {
  applyModelSuggestion,
  type MentionSegment,
  type ModelVocabulary,
  mentionedModels,
  mentionQueryAt,
  modelKey,
  modelMentions,
  type PackFleetModel,
  suggestionsAreSettled,
  suggestModels,
} from '@ferretry/protocol';
import { type KeyboardEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';

export const NOT_HERE = 'not on this machine';
const UNKNOWN = 'no catalog lists this model';

const TIER_WORDS: Readonly<Record<PackFleetModel['tier'], string>> = {
  best: 'Best',
  balanced: 'Balanced',
  fast: 'Fast',
};

/** The colour a mark gets in the mirror. Text runs inherit the field's own colour. */
const MARK_CLASS: Readonly<Record<MentionSegment['kind'], string>> = {
  text: '',
  known: 'rounded-sm bg-accent-soft text-accent',
  absent: 'rounded-sm bg-surface-3 text-muted underline decoration-dotted decoration-from-font underline-offset-2',
  unknown: 'bg-transparent text-err underline decoration-wavy decoration-err underline-offset-2',
};

export type CompletionKey =
  | { readonly type: 'ignore' }
  | { readonly type: 'move'; readonly index: number }
  | { readonly type: 'accept'; readonly index: number }
  | { readonly type: 'close' };

/**
 * What a key does while suggestions may be open. In a multi-line field Enter is a new line until the
 * reader has moved into the list; Tab always takes the highlighted suggestion.
 */
export function completionKey(
  key: string,
  state: {
    readonly open: boolean;
    readonly count: number;
    readonly active: number;
    readonly moved: boolean;
    readonly multiline: boolean;
  },
): CompletionKey {
  if (!state.open || state.count === 0) return { type: 'ignore' };
  if (key === 'Escape') return { type: 'close' };
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const step = key === 'ArrowDown' ? 1 : -1;
    return { type: 'move', index: (state.active + step + state.count) % state.count };
  }
  if (key === 'Tab') return { type: 'accept', index: state.active };
  if (key === 'Enter' && (!state.multiline || state.moved)) return { type: 'accept', index: state.active };
  return { type: 'ignore' };
}

export interface ModelMentionFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly vocabulary: ModelVocabulary;
  /** A multi-line field marks the names in its text; a single-line one is a model picker. */
  readonly multiline?: boolean;
  /** Called when a suggestion is taken, with the model it names. */
  readonly onPick?: (model: PackFleetModel) => void;
  readonly maxLength?: number;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Field-level problem, shown under it and announced through `aria-describedby`. */
  readonly problem?: string | null;
  /** More text that describes the field, drawn by the caller (a character counter): its element id. */
  readonly describedBy?: string;
}

export function ModelMentionField({
  id,
  label,
  value,
  onChange,
  vocabulary,
  multiline = true,
  onPick,
  maxLength,
  rows = 3,
  placeholder,
  disabled = false,
  problem = null,
  describedBy: extraDescription,
}: ModelMentionFieldProps) {
  const listboxId = `${id}-models`;
  const hintId = `${id}-mentions`;
  const problemId = `${useId()}-problem`;
  const fieldRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [moved, setMoved] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const segments = useMemo(() => modelMentions(value, vocabulary), [value, vocabulary]);
  const mentions = useMemo(() => mentionedModels(segments), [segments]);
  const query = caret === null ? null : mentionQueryAt(value, caret);
  const suggestions = useMemo(
    () => (query === null ? [] : suggestModels(vocabulary.models, query.query)),
    [query, vocabulary.models],
  );
  const word = query === null ? '' : value.slice(query.start, query.end);
  const open =
    !disabled &&
    query !== null &&
    suggestions.length > 0 &&
    !suggestionsAreSettled(suggestions, word) &&
    dismissed !== `${query.start}:${word}`;
  const bounded = open ? Math.min(active, suggestions.length - 1) : -1;

  // A taken suggestion moves the caret to just after the name, once the new text is in the field.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    const next = pendingCaret.current;
    if (field === null || next === null || field.value !== value) return;
    pendingCaret.current = null;
    field.setSelectionRange(next, next);
    setCaret(next);
  }, [value]);

  // The field grows with its text, so it never scrolls inside itself and the mirror never drifts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the re-measure trigger
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!multiline || field === null || field.scrollHeight === 0) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
  }, [multiline, value]);

  const accept = (index: number): void => {
    const model = suggestions[index];
    if (model === undefined || query === null) return;
    const next = applyModelSuggestion(value, query, model);
    pendingCaret.current = next.caret;
    setActive(0);
    setMoved(false);
    onChange(next.text);
    onPick?.(model);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const action = completionKey(event.key, {
      open,
      count: suggestions.length,
      active: bounded,
      moved,
      multiline,
    });
    if (action.type === 'ignore') return;
    event.preventDefault();
    if (action.type === 'close') setDismissed(query === null ? null : `${query.start}:${word}`);
    else if (action.type === 'move') {
      setActive(action.index);
      setMoved(true);
    } else accept(action.index);
  };

  const sync = (field: HTMLTextAreaElement | HTMLInputElement): void => setCaret(field.selectionStart);
  const describedBy = [
    mentions.length > 0 ? hintId : null,
    problem === null ? null : problemId,
    extraDescription ?? null,
  ]
    .filter(part => part !== null)
    .join(' ');
  const shared = {
    id,
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': open,
    'aria-controls': listboxId,
    'aria-activedescendant': open ? `${listboxId}-${bounded}` : undefined,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    'aria-invalid': problem === null ? undefined : true,
    autoComplete: 'off',
    // The browser's own red squiggle under a model id would read as the unknown-model mark.
    spellCheck: false,
    disabled,
    maxLength,
    placeholder,
    value,
    onChange: (event: { readonly currentTarget: HTMLTextAreaElement | HTMLInputElement }) => {
      setActive(0);
      setMoved(false);
      setDismissed(null);
      onChange(event.currentTarget.value);
      sync(event.currentTarget);
    },
    onSelect: (event: { readonly currentTarget: HTMLTextAreaElement | HTMLInputElement }) => sync(event.currentTarget),
    onFocus: (event: { readonly currentTarget: HTMLTextAreaElement | HTMLInputElement }) => sync(event.currentTarget),
    onBlur: () => setCaret(null),
    onKeyDown,
  } as const;

  return (
    <div className="flex min-w-0 flex-col gap-1" data-model-field={id}>
      <label htmlFor={id} className="text-meta font-semibold text-fg-soft">
        {label}
      </label>
      <div className="relative min-w-0">
        {multiline ? (
          <>
            <div
              ref={mirrorRef}
              aria-hidden="true"
              data-model-mirror=""
              className="kt-input pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words !text-fg"
            >
              {segments.map(segment =>
                segment.kind === 'text' ? (
                  <span key={segment.start}>{segment.text}</span>
                ) : (
                  <mark key={segment.start} data-model-mark={segment.kind} className={MARK_CLASS[segment.kind]}>
                    {segment.text}
                  </mark>
                ),
              )}
              {/* A trailing line break needs a glyph after it, or the mirror is one line short. */}
              {'​'}
            </div>
            <textarea
              ref={fieldRef}
              rows={rows}
              {...shared}
              onScroll={event => {
                if (mirrorRef.current !== null) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
              }}
              className="kt-input relative block resize-none overflow-hidden !bg-transparent !text-transparent caret-[var(--fg)] selection:bg-accent-soft"
            />
          </>
        ) : (
          <input ref={fieldRef} type="text" {...shared} className="kt-input mono min-h-[44px] w-full" />
        )}
        {open ? (
          <div
            id={listboxId}
            role="listbox"
            aria-label={`Models for ${label}`}
            data-model-suggestions=""
            className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-[264px] overflow-y-auto overscroll-contain rounded-panel border border-border-strong bg-surface shadow-popover"
          >
            {suggestions.map((model, index) => (
              <SuggestionRow
                key={modelKey(model)}
                id={`${listboxId}-${index}`}
                model={model}
                active={index === bounded}
                onAccept={() => accept(index)}
              />
            ))}
          </div>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {open ? `${suggestions.length} model suggestions` : ''}
        </span>
      </div>
      {multiline && mentions.length > 0 ? <MentionLine id={hintId} mentions={mentions} /> : null}
      {problem === null ? null : (
        <p id={problemId} className="m-0 text-meta text-err">
          {problem}
        </p>
      )}
    </div>
  );
}

function SuggestionRow({
  id,
  model,
  active,
  onAccept,
}: {
  readonly id: string;
  readonly model: PackFleetModel;
  readonly active: boolean;
  readonly onAccept: () => void;
}) {
  const here = model.runtimes.length > 0;
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      data-model-option={model.id}
      className={cn(
        'flex min-h-[44px] cursor-pointer select-none items-center gap-2 border-l-heavy border-l-transparent px-control-x py-1 hover:bg-surface-2',
        active && 'border-l-accent bg-accent-soft',
      )}
      // Before the field loses focus, so the press lands on the option and not on a closed list.
      onPointerDown={event => event.preventDefault()}
      onPointerUp={onAccept}
    >
      <span className="min-w-0 flex-1 leading-tight">
        <span className={cn('block truncate text-ui font-medium', here ? 'text-fg' : 'text-muted')}>{model.label}</span>
        <span className="mono block truncate text-meta text-muted">
          {model.id} · {model.providerLabel}
          {here ? '' : ` · ${NOT_HERE}`}
        </span>
      </span>
      <span className="shrink-0 rounded-badge border border-border-soft px-badge-x text-2xs text-faint">
        {TIER_WORDS[model.tier]}
      </span>
    </div>
  );
}

/** Every model the text names, once each — the accessible (and hoverable) half of the marks. */
function MentionLine({ id, mentions }: { readonly id: string; readonly mentions: readonly MentionSegment[] }) {
  return (
    <p id={id} className="m-0 flex flex-wrap items-center gap-1 text-meta text-muted" data-model-mentions="">
      <span>Models named:</span>
      {mentions.map(mention => {
        const title =
          mention.kind === 'unknown'
            ? UNKNOWN
            : mention.kind === 'absent'
              ? NOT_HERE
              : `runs here on ${mention.model?.runtimes.join(', ')}`;
        return (
          <span
            key={`${mention.kind}:${mention.start}`}
            title={title}
            data-model-mention={mention.kind}
            className={cn('rounded-badge px-badge-x', MARK_CLASS[mention.kind])}
          >
            {mention.model?.label ?? mention.text}
            <span className={mention.kind === 'known' ? 'sr-only' : undefined}> ({title})</span>
          </span>
        );
      })}
    </p>
  );
}
