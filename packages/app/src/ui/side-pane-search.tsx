/**
 * The common compact search field for side-pane surfaces. Ported from kteam
 * `ui/src/components/SidePaneSearch.tsx`.
 *
 * Local draft state keeps typing responsive while parent-owned filtering is
 * deliberately debounced. Clear and blur flush immediately, so a pane never
 * stays filtered after the control has visibly been cleared or left.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FocusEventHandler, KeyboardEventHandler, RefObject } from 'react';
import { Search, X } from 'lucide-react';

/** Enough feedback to feel immediate without re-filtering a large pane per key. */
export const SIDE_PANE_SEARCH_DEBOUNCE_MS = 160;

export interface SidePaneSearchProps {
  /** Parent-owned query; this component never turns filtering state into local state. */
  readonly value: string;
  /** Receives a debounced value, except clear and blur which commit immediately. */
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly debounceMs?: number;
  readonly clearLabel?: string;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  readonly onFocus?: FocusEventHandler<HTMLInputElement>;
  readonly onBlur?: FocusEventHandler<HTMLInputElement>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}

export function SidePaneSearch({
  value,
  onChange,
  ariaLabel,
  placeholder,
  id,
  disabled = false,
  debounceMs = SIDE_PANE_SEARCH_DEBOUNCE_MS,
  clearLabel = 'Clear search',
  inputRef,
  onFocus,
  onBlur,
  onKeyDown,
}: SidePaneSearchProps) {
  const generatedId = useId();
  const inputId = id ?? `side-pane-search-${generatedId.replace(/:/g, '')}`;
  const [draft, setDraft] = useState(value);
  const submitted = useRef(value);

  // An external reset (for example, changing session) is authoritative even
  // while this field is focused. A locally submitted value is already visible
  // in the draft, so it does not need another state write.
  useEffect(() => {
    if (value === submitted.current) return;
    submitted.current = value;
    setDraft(value);
  }, [value]);

  const submit = useCallback(
    (next: string) => {
      submitted.current = next;
      onChange(next);
    },
    [onChange],
  );

  useEffect(() => {
    if (draft === submitted.current || disabled) return;
    const timer = setTimeout(() => submit(draft), debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, disabled, draft, submit]);

  const flush = useCallback(() => {
    if (draft !== submitted.current) submit(draft);
  }, [draft, submit]);

  return (
    <div data-side-pane-search="" data-debounce-ms={debounceMs} className="relative flex min-w-0 items-center">
      <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 shrink-0 text-faint" />
      <input
        id={inputId}
        ref={inputRef}
        // `text` avoids a browser-specific clear button competing with this
        // component's one clear action.
        type="text"
        value={draft}
        onChange={event => setDraft(event.currentTarget.value)}
        onFocus={onFocus}
        onBlur={event => {
          flush();
          onBlur?.(event);
        }}
        onKeyDown={onKeyDown}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="kt-input min-h-[44px] min-w-0 w-full !pl-9 !pr-10"
      />
      {draft && !disabled && (
        <button
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          // 36px inside a 44px field: the field itself already meets the touch
          // target, and a full-size button would crowd the text it clears.
          className="kt-btn absolute right-1 min-h-[36px] min-w-[36px] shrink-0 justify-center p-0"
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            setDraft('');
            submit('');
            inputRef?.current?.focus();
          }}
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
