import type { IFyApiClient } from '@ferretry/protocol';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readInputModality, useInputModality } from '../hooks/use-input-modality.ts';
import { useKeyboardOpen } from '../hooks/use-keyboard-open.ts';
import {
  type ComposerEnterKeyPreference,
  composerEnterAction,
  composerEnterHint,
  shiftedComposerEnterAction,
} from '../lib/composer-keybinding.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionScope } from '../lib/daemon-scope.ts';
import { type DaemonDraftStore, documentDraftStore } from '../lib/drafts.ts';
import { useMdComposePref } from '../lib/md-compose.ts';
import { registerComposerQuoteTarget } from '../lib/quote.ts';
import { canSubmitComposer } from '../lib/session-screens.ts';
import type { BrowserRecognitionProvider } from '../lib/stt/browser-recognition.ts';
import type { SttSettings } from '../lib/stt/stt-settings.ts';
import { useComposerAutocomplete } from './composer-autocomplete.ts';
import { ComposerAutocompletePopover } from './composer-autocomplete-popover.tsx';
import { createComposerAutocompleteProviders } from './composer-autocomplete-providers.ts';
import { ComposerHighlight, syncComposerHighlightViewport } from './composer-highlight.tsx';
import { ComposerQuota, type ComposerQuotaProps } from './composer-quota.tsx';
import { DictationControl } from './dictation-control.tsx';

export interface ComposerProps {
  readonly daemon: DaemonConnection;
  readonly sessionId: string;
  readonly api: Pick<IFyApiClient, 'send'> & Partial<Pick<IFyApiClient, 'history'>>;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /** This session's own daemon reading; composer quota is never ambient state. */
  readonly quota?: ComposerQuotaProps['quota'];
  readonly draftStore?: DaemonDraftStore;
  readonly onSent?: () => void;
  /** Phone chrome. The host already knows its presentation; the composer does
   * not re-derive it, it only picks the growth ceiling from it. */
  readonly compact?: boolean;
  /** Browser-local bare Enter behaviour. null uses this device’s default. */
  readonly enterKeyPreference?: ComposerEnterKeyPreference | null;
  /** Browser-local dictation settings. Absence leaves this optional slot empty. */
  readonly dictationSettings?: SttSettings;
  /** Test/visual seam; production feature-detects the ambient browser. */
  readonly dictationRecognition?: BrowserRecognitionProvider;
}

/**
 * AUTO-GROW CEILINGS, ported from kteam `ui/src/components/Composer.tsx`.
 *
 * A composer that does not grow is a composer that hides what you typed: the
 * shipped box was one 44px row with `overflow` on the textarea, so line two of
 * a draft was sliced by the actions row at both viewports (measured 2026-08-04).
 * Growth is capped for the opposite reason — a pasted essay must not swallow
 * the conversation it is about.
 *
 * The phone gets a slightly taller rest ceiling than the desktop because its
 * lines are shorter, and a LOWER one while the keyboard is up: with ~430px of
 * visible viewport, 160px of composer is more than a third of everything the
 * reader can see.
 */
const MAX_TEXTAREA_PX = 148;
const COMPACT_MAX_TEXTAREA_PX = 160;
const COMPACT_KEYBOARD_MAX_TEXTAREA_PX = 140;
/** The floor is the touch target, and it is the same 44px `.fy-composer
 *  textarea` already declares — stated here so the two cannot drift. */
const MIN_TEXTAREA_PX = 44;

/**
 * A single composer surface. Draft persistence is scoped by the supplied paired
 * daemon and session, and its API client is injected by the host for the same
 * reason: no bundled origin, token, or singleton daemon exists here.
 */
export function Composer({
  daemon,
  sessionId,
  api,
  busy = false,
  disabled = false,
  placeholder = 'Message this session',
  quota,
  draftStore = documentDraftStore,
  onSent,
  compact = false,
  enterKeyPreference = null,
  dictationSettings,
  dictationRecognition,
}: ComposerProps) {
  const scope = useMemo(() => daemonSessionScope(daemon, sessionId), [daemon, sessionId]);
  const [draft, setDraft] = useState(() => draftStore.load(scope));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const hintId = useId();
  // A reader preference, not daemon data: it changes only how this browser
  // paints a textarea, so a daemon switch must not change the editor chrome.
  const highlighted = useMdComposePref() === 'on';
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const autocompleteProviders = useMemo(() => createComposerAutocompleteProviders({ daemon, scope }), [daemon, scope]);
  const autocomplete = useComposerAutocomplete({
    value: draft,
    onValueChange: setDraft,
    inputRef,
    providers: autocompleteProviders,
    disabled: disabled || sending,
  });
  const syncHighlight = useCallback((input: HTMLTextAreaElement) => {
    syncComposerHighlightViewport(input, overlayRef.current);
  }, []);
  const keyboardOpen = useKeyboardOpen();
  const inputModality = useInputModality();
  const bareEnterAction = composerEnterAction(enterKeyPreference, inputModality.enterSends);
  const maxTextareaPx = !compact
    ? MAX_TEXTAREA_PX
    : keyboardOpen
      ? COMPACT_KEYBOARD_MAX_TEXTAREA_PX
      : COMPACT_MAX_TEXTAREA_PX;

  // Measured BEFORE paint, so the box never flashes at the wrong height, and
  // reset to `auto` first because `scrollHeight` of an already-tall textarea
  // reports the height it was given rather than the height it needs — without
  // the reset the box can only ever grow.
  //
  // The ceiling is a dependency, not a constant read once: opening the keyboard
  // has to re-run this, or a draft that grew to four lines at rest keeps its
  // 160px through a 430px viewport. `overflowY` is only turned on AT the cap, so
  // a draft that fits never shows a scrollbar it does not need — which is the
  // whole difference between growing and clipping.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `highlighted` is a re-sync trigger
  useLayoutEffect(() => {
    // `highlighted` is in the dependency list although the body never reads it:
    // toggling it mounts or unmounts the paint overlay, and the overlay has to
    // be re-aligned to the textarea's viewport the moment it appears. Dropping
    // it leaves a freshly enabled overlay painting at the wrong offset until the
    // next keystroke.
    const input = inputRef.current;
    if (input === null) return;
    input.style.height = 'auto';
    const next = Math.min(maxTextareaPx, Math.max(MIN_TEXTAREA_PX, input.scrollHeight));
    input.style.height = `${next}px`;
    input.style.overflowY = input.scrollHeight > maxTextareaPx ? 'auto' : 'hidden';
    syncHighlight(input);
  }, [draft, highlighted, maxTextareaPx, syncHighlight]);

  // The draft is read through a ref so registration survives every keystroke:
  // re-registering on each character would churn the quote registry for nothing.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Publish this composer as the quote target for its own (daemon, session).
  // Transcript quoting addresses a scope, never "whatever textarea is visible" —
  // two panes can belong to different daemons.
  useEffect(
    () =>
      registerComposerQuoteTarget({
        ...scope,
        draft: () => draftRef.current,
        replaceDraft: next => {
          setDraft(next);
          const input = inputRef.current;
          if (input === null) return;
          input.focus();
          // A detached or hidden textarea can refuse a selection; the value still
          // landed, so the caret is a nicety rather than part of the contract.
          try {
            input.setSelectionRange(next.length, next.length);
          } catch {
            // Intentionally ignored — see above.
          }
        },
      }),
    [scope],
  );

  // `scope` already carries the daemon identity, so it changes whenever the daemon does; listing
  // daemon.daemonId as well only re-ran this redundantly.
  useEffect(() => {
    setDraft(draftStore.load(scope));
    setError(null);
  }, [draftStore, scope]);

  useEffect(() => {
    const timer = setTimeout(() => draftStore.save(scope, draft), 400);
    return () => clearTimeout(timer);
  }, [draft, draftStore, scope]);

  const submit = async () => {
    if (!canSubmitComposer(draft, disabled, sending) || submitLock.current) return;
    submitLock.current = true;
    setSending(true);
    setError(null);
    try {
      await api.send(sessionId, { message: draft.trim(), now: !busy });
      for (const provider of autocompleteProviders) provider.reset?.();
      setDraft('');
      draftStore.clear(scope);
      onSent?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message could not be sent');
    } finally {
      submitLock.current = false;
      setSending(false);
    }
  };

  const insertNewline = (): void => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}\n${draft.slice(end)}`;
    setDraft(next);
    requestAnimationFrame(() => {
      const current = inputRef.current;
      if (current === null) return;
      current.focus();
      current.setSelectionRange(start + 1, start + 1);
      autocomplete.syncSelection({ start: start + 1, end: start + 1 });
    });
  };

  // The autocomplete controller caches the selection it was last told about, so
  // it is read through a ref here: the dictation callback below must stay stable
  // across renders, and the controller object is rebuilt on every one.
  const syncAutocompleteSelection = useRef(autocomplete.syncSelection);
  syncAutocompleteSelection.current = autocomplete.syncSelection;

  const applyDictation = useCallback((result: { readonly text: string; readonly caret: number }): void => {
    setDraft(result.text);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input === null) return;
      // DELIBERATELY NOT `focus()`, unlike `insertNewline` and `replaceDraft`
      // above: dictation is the one path a phone reader takes to AVOID the
      // on-screen keyboard, and focusing the textarea summons it straight over
      // the words they just spoke. The caret still moves, so typing after a tap
      // continues from the transcript rather than from a stale position.
      try {
        input.setSelectionRange(result.caret, result.caret);
      } catch {
        // The draft still landed; a detached textarea can refuse selection.
      }
      // Told separately BECAUSE there is no focus and therefore no `select`
      // event: without this the controller keeps the caret from before the
      // transcript, and a reference the dictated text ended on stays unoffered
      // until the next keystroke.
      syncAutocompleteSelection.current({ start: result.caret, end: result.caret });
    });
  }, []);

  return (
    <form
      aria-describedby={hintId}
      className="fy-composer"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" htmlFor={`${hintId}-input`}>
        Message
      </label>
      <div className="fy-composer-input-layer" data-highlighted={String(highlighted)}>
        <ComposerHighlight enabled={highlighted} overlayRef={overlayRef} text={draft} />
        <textarea
          disabled={disabled || sending}
          id={`${hintId}-input`}
          onChange={event => {
            const input = event.currentTarget as unknown as HTMLTextAreaElement;
            setDraft(input.value);
            autocomplete.syncSelection({ start: input.selectionStart, end: input.selectionEnd });
            syncHighlight(input);
          }}
          onKeyDown={event => {
            // Arbitration order is deliberate: a visible, selected completion
            // gets Enter/Tab first; an empty, loading or refused list cannot
            // consume either key. Everything else (Escape and arrow navigation)
            // still belongs to the open list before Enter reaches this reader's
            // configured send/newline behaviour.
            const completionKey = event.key === 'Enter' || event.key === 'Tab';
            const hasAcceptableCompletion = autocomplete.open && autocomplete.activeIndex >= 0;
            if (completionKey) {
              if (hasAcceptableCompletion && autocomplete.handleKeyDown(event)) return;
            } else if (autocomplete.handleKeyDown(event)) return;
            if (event.key !== 'Enter' || (event.nativeEvent as { isComposing?: boolean }).isComposing) return;
            const action = composerEnterAction(enterKeyPreference, readInputModality().enterSends);
            const send = event.shiftKey ? shiftedComposerEnterAction(action) === 'send' : action === 'send';
            if (!send) return;
            event.preventDefault();
            void submit();
          }}
          onScroll={event => syncHighlight(event.currentTarget as unknown as HTMLTextAreaElement)}
          onSelect={event => {
            const input = event.currentTarget as unknown as HTMLTextAreaElement;
            autocomplete.syncSelection({ start: input.selectionStart, end: input.selectionEnd });
          }}
          placeholder={placeholder}
          ref={inputRef}
          rows={1}
          value={draft}
          {...autocomplete.textareaAria}
        />
        {/* Anchored to the input layer, opening UPWARD: the composer sits at the
            bottom of the session, so a downward list would land off-screen and
            under the on-screen keyboard. */}
        <ComposerAutocompletePopover surface={autocomplete} />
      </div>
      <div className="fy-composer-actions">
        <p id={hintId}>
          {busy ? 'Queue for the next turn' : composerEnterHint(bareEnterAction, inputModality.touchAffected)}
        </p>
        <ComposerQuota quota={quota} />
        {dictationSettings ? (
          <DictationControl
            {...(typeof api.history === 'function' ? { api: api as Pick<IFyApiClient, 'history'> } : {})}
            composerRef={inputRef}
            daemon={daemon}
            disabled={disabled || sending}
            draft={draft}
            layout={compact ? 'compact' : 'full'}
            onDraftChange={applyDictation}
            {...(dictationRecognition === undefined ? {} : { recognition: dictationRecognition })}
            selectionRef={inputRef}
            sessionId={sessionId}
            settings={dictationSettings}
          />
        ) : null}
        {inputModality.touchAffected && bareEnterAction === 'send' ? (
          <button type="button" onClick={insertNewline} disabled={disabled || sending}>
            New line
          </button>
        ) : null}
        <button disabled={!canSubmitComposer(draft, disabled, sending)} type="submit">
          {sending ? 'Sending…' : busy ? 'Queue' : 'Send'}
        </button>
      </div>
      {error ? (
        <p className="fy-composer-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
