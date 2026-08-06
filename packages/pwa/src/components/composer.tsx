import type { IFyApiClient, SessionView } from '@ferretry/protocol';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readInputModality, useInputModality } from '../hooks/use-input-modality.ts';
import { useKeyboardOpen } from '../hooks/use-keyboard-open.ts';
import {
  type ComposerEnterKeyPreference,
  composerEnterAction,
  composerEnterHint,
  shiftedComposerEnterAction,
} from '../lib/composer-keybinding.ts';
import { initialVimState, type VimState, vimReduce } from '../lib/composer-vim.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionScope } from '../lib/daemon-scope.ts';
import { type DaemonDraftStore, documentDraftStore } from '../lib/drafts.ts';
import { useMdComposePref } from '../lib/md-compose.ts';
import { registerComposerQuoteTarget } from '../lib/quote.ts';
import { findReferences } from '../lib/references.ts';
import { canSubmitComposer } from '../lib/session-screens.ts';
import type { BrowserRecognitionProvider } from '../lib/stt/browser-recognition.ts';
import type { SttSettings } from '../lib/stt/stt-settings.ts';
import { type ComposerSuggestionSwitches, useComposerAutocomplete } from './composer-autocomplete.ts';
import { ComposerAutocompletePopover } from './composer-autocomplete-popover.tsx';
import {
  type ComposerAttentionItem,
  type ComposerSkillsCatalog,
  type ComposerTaskSummary,
  createComposerAutocompleteProviders,
} from './composer-autocomplete-providers.ts';
import { ComposerHighlight, syncComposerHighlightViewport } from './composer-highlight.tsx';
import { ComposerQuota, type ComposerQuotaProps } from './composer-quota.tsx';
import { DictationControl } from './dictation-control.tsx';
import { Markdown, type MarkdownProps } from './markdown.tsx';
import { type ReferenceSurface, useReferenceSurface } from './reference-surface.tsx';

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
  /** One already-read daemon fleet slice, shared with transcript references. */
  readonly autocompleteSessions?: readonly SessionView[];
  /** The session's already-read task summaries, shared with reference proof. */
  readonly autocompleteTasks?: readonly ComposerTaskSummary[];
  /** The session's unresolved Attention items, shared with reference proof. */
  readonly autocompleteAttention?: readonly ComposerAttentionItem[];
  /** The session's already-read skills catalog, shared with reference proof. */
  readonly autocompleteSkills?: ComposerSkillsCatalog;
  /**
   * Resolves once the host's ONE read of these families has settled.
   *
   * Without it there is a race a reader hits on the first message of every
   * session: the page's request is still in flight, the props are still
   * `undefined`, and a menu opened in that window would either invent an empty
   * fact or — for skills — issue the composer's own second request for the very
   * thing already being fetched. With it the menu waits for the host's answer.
   * A failed read still resolves: it leaves the family unproved, which is the
   * honest state, and never a second fetch.
   */
  readonly autocompleteReady?: () => Promise<void> | undefined;
  /** Which suggestion families this reader still wants offered. Absent means all
   *  of them. Suppression is menus only — every reference still parses here. */
  readonly suggestions?: ComposerSuggestionSwitches;
  /** Modal editing over the native textarea. Off is the default and the whole
   *  arbitration below collapses to today's behaviour when it is off. */
  readonly vimMode?: boolean;
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
 * Rendered Markdown belongs beside the editor, never underneath it.
 *
 * Markdown consumes marker bytes and changes wrapping, so it cannot share the
 * textarea's caret-aligned paint layer. This bounded reader uses the exact
 * Markdown/reference pipeline that transcript prose uses while the native
 * textarea remains the only input, selection and IME owner.
 */
export function ComposerMarkdownPreview({
  text,
  className,
  maxHeightPx = PREVIEW_MAX_PX,
  ...markdown
}: MarkdownProps & {
  /** The reader's remaining vertical budget. A phone with its keyboard up has
   *  far less of it than a desktop, and the preview must never be the thing
   *  that pushes the conversation off the screen. */
  readonly maxHeightPx?: number;
}) {
  if (text.trim().length === 0) return null;
  return (
    <section
      aria-label="Rendered Markdown preview"
      className={`mb-2 min-w-0 max-w-full rounded-control border border-border-soft bg-surface-2 px-2 py-1.5 ${className ?? ''}`}
      data-composer-markdown-preview=""
    >
      <span className="mb-1 block text-meta font-semibold uppercase tracking-wide text-faint">Preview</span>
      <div
        className="scroll-thin min-w-0 max-w-full overflow-auto overscroll-contain"
        style={{ maxHeight: `${maxHeightPx}px` }}
      >
        <Markdown className="text-row leading-base text-fg" text={text} {...markdown} />
      </div>
    </section>
  );
}

/**
 * A draft that is nonblank NOW, rendered no faster than a reader can read it.
 *
 * Markdown parsing, proof and reference transformation are the transcript's own
 * pipeline, and running all of it on every keystroke is what makes a phone drop
 * characters. The delay is deliberately one-directional: the text is published
 * late, but a RESET is immediate — `text` is the identity of the draft, so a
 * session change or a successful send empties the preview in the same commit
 * rather than leaving the previous session's words rendered under the new one.
 */
function useDeferredDraft(text: string, delayMs: number, sessionKey: string): string {
  const [deferred, setDeferred] = useState({ key: sessionKey, text });
  const blank = text.trim() === '';
  useEffect(() => {
    if (blank) {
      setDeferred({ key: sessionKey, text: '' });
      return;
    }
    const timer = setTimeout(() => setDeferred({ key: sessionKey, text }), delayMs);
    return () => clearTimeout(timer);
  }, [blank, delayMs, sessionKey, text]);
  // The key is checked on the way OUT, not only in the effect, because a scope
  // change re-renders before any effect runs: without this the new session's
  // composer would paint one frame of the previous session's words.
  return blank || deferred.key !== sessionKey ? '' : deferred.text;
}

/**
 * The compact reference strip — every reference-shaped token in the draft, in
 * the order it was typed, each one rendered through the SHARED renderer.
 *
 * The shared Markdown renderer has no compact mode, so this is the safe reading
 * of "compact inline references": the caret-aligned paint layer is untouched
 * (it is lossless by contract and must stay that way), and the compaction lives
 * beside the editor instead of inside it.
 *
 * Each chip is `<Markdown>` over exactly the token's own bytes, which is why
 * there is no second grammar and no second resolver here: whether a chip is a
 * link or plain text IS the proof gate's answer, decided by the same code that
 * decides it in the transcript. An unproved token therefore reads as prose in
 * the strip too, which is the honest state rather than a broken chip.
 *
 * DUPLICATES ARE KEPT, deliberately. Two `@src/api.ts` tokens are two things a
 * reader may want to remove separately, and collapsing them would make the
 * remove button ambiguous about which bytes it deletes.
 */
function ComposerReferenceStrip({
  draft,
  onRemove,
  surface,
}: {
  readonly draft: string;
  readonly onRemove: (start: number, end: number) => void;
  readonly surface: ReferenceSurface;
}) {
  const references = useMemo(() => findReferences(draft), [draft]);
  if (references.length === 0) return null;
  return (
    <fieldset
      aria-label="References in this message"
      className="m-0 mb-1 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0"
      data-composer-reference-strip=""
    >
      {references.map(reference => (
        <div
          className="inline-flex min-h-[44px] max-w-full items-center gap-1 rounded-badge border border-border-soft bg-surface-2 py-px pl-2 pr-px text-2xs"
          data-composer-reference={reference.raw}
          key={`${reference.start}:${reference.raw}`}
        >
          {/* A div, not a span: the shared renderer emits block content, and a
              paragraph inside an inline element is markup the browser repairs
              by moving it somewhere the reader did not put it. */}
          <div className="mono min-w-0 truncate [&_p]:m-0 [&_p]:inline">
            <Markdown text={reference.raw} {...surface} />
          </div>
          <button
            aria-label={`Remove ${reference.raw} from this message`}
            // A REAL 44px box, not an overflowing pseudo-element. The first
            // version expanded the hit area with `-inset-[11px]`, which reached
            // 11px into the neighbouring chip: two adjacent removals then
            // shared a strip of pixels, and which one a thumb got was decided by
            // paint order rather than by aim. The glyph stays 22px; the box that
            // owns the touch is its own.
            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-badge text-base text-faint hover:bg-surface hover:text-fg"
            onClick={() => onRemove(reference.start, reference.end)}
            title={`Remove ${reference.raw}`}
            type="button"
          >
            ×
          </button>
        </div>
      ))}
    </fieldset>
  );
}

/** Stable empties, so an unsettled family is a getter that answers rather than a
 *  getter that is missing — and never a new array identity per render. */
const EMPTY_SESSIONS: readonly SessionView[] = [];
const EMPTY_TASKS: readonly ComposerTaskSummary[] = [];
const EMPTY_ATTENTION: readonly ComposerAttentionItem[] = [];

/** The composer's own name for a Vim mode, in words rather than in colour. */
const VIM_MODE_LABEL: Record<VimState['mode'], string> = { insert: 'Insert', normal: 'Normal' };

/**
 * Long enough that a phone's autocorrect burst renders once, short enough that a
 * reader who stopped typing to LOOK at the preview is not waiting for it.
 */
const PREVIEW_DEBOUNCE_MS = 200;

/**
 * The preview's own height budget, in the same currency as the textarea's.
 *
 * The keyboard-open phone number is the one that matters: with ~430px of visible
 * viewport, a composer already claiming 140px cannot also spend 144px on a
 * rendering of what it already contains, or the conversation it is about is off
 * the screen entirely.
 */
const PREVIEW_MAX_PX = 144;
const COMPACT_PREVIEW_MAX_PX = 112;
const COMPACT_KEYBOARD_PREVIEW_MAX_PX = 72;

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
  autocompleteSessions,
  autocompleteTasks,
  autocompleteAttention,
  autocompleteSkills,
  autocompleteReady,
  suggestions,
  vimMode = false,
}: ComposerProps) {
  const scope = useMemo(() => daemonSessionScope(daemon, sessionId), [daemon, sessionId]);
  /**
   * The draft is TAGGED with the session it belongs to, and read back through
   * that tag.
   *
   * State cannot be reset from an effect without the render in between: the
   * effect that reloads a draft on a scope change runs AFTER the commit, so a
   * plain `useState` paints one frame of the previous session's words in the
   * new session's textarea. Deriving the value from the tag makes that frame
   * unrepresentable — a mismatched tag reads this scope's own stored draft —
   * and the effect below then settles the state for every render after it.
   */
  const scopeKey = `${scope.daemonId} ${scope.sessionId}`;
  const [draftState, setDraftState] = useState(() => ({ key: scopeKey, text: draftStore.load(scope) }));
  const draft = draftState.key === scopeKey ? draftState.text : draftStore.load(scope);
  const setDraft = useCallback(
    (text: string) => setDraftState({ key: `${scope.daemonId} ${scope.sessionId}`, text }),
    [scope.daemonId, scope.sessionId],
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const hintId = useId();
  // A reader preference, not daemon data: it changes only how this browser
  // paints a textarea, so a daemon switch must not change the editor chrome.
  const highlighted = useMdComposePref() === 'on';
  const references = useReferenceSurface();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Read as three booleans rather than as one object BECAUSE providers are
  // rebuilt from these: a host that passed a fresh literal every render would
  // otherwise abort and re-issue the open list's request on every keystroke.
  // Absent stays "every family offered", exactly as the stored preference does.
  const { mentionSuggestions = true, directReferenceSuggestions = true, skillSuggestions = true } = suggestions ?? {};
  // A host that supplies any of these owns all four families; a host that
  // supplies none is a standalone composer and keeps the daemon-backed defaults.
  const hosted =
    autocompleteSessions !== undefined ||
    autocompleteTasks !== undefined ||
    autocompleteAttention !== undefined ||
    autocompleteSkills !== undefined ||
    autocompleteReady !== undefined;
  const hostRef = useRef({
    sessions: autocompleteSessions,
    tasks: autocompleteTasks,
    attention: autocompleteAttention,
    skills: autocompleteSkills,
    ready: autocompleteReady,
  });
  hostRef.current = {
    sessions: autocompleteSessions,
    tasks: autocompleteTasks,
    attention: autocompleteAttention,
    skills: autocompleteSkills,
    ready: autocompleteReady,
  };
  // Stable by construction, so a warmup never rebuilds the providers it belongs
  // to. A rejected host read resolves rather than propagates: "we could not
  // read it" leaves the family unproved, and unproved is the honest answer.
  const hostWarmup = useCallback(() => hostRef.current.ready?.()?.catch(() => undefined), []);
  const autocompleteProviders = useMemo(
    () =>
      createComposerAutocompleteProviders({
        daemon,
        scope,
        suggestions: { mentionSuggestions, directReferenceSuggestions, skillSuggestions },
        // THE GETTERS ARE UNCONDITIONAL once a host claims these families, and
        // they read the LIVE prop through a ref rather than closing over one
        // render's value. A getter installed only "once the value arrived" is
        // the race: the first menu of every session opens while the page's one
        // read is still in flight, and an absent getter there means an invented
        // empty list — or, for skills, the composer's own second request for
        // exactly what is already being fetched.
        ...(hosted
          ? {
              getSessions: () => hostRef.current.sessions ?? EMPTY_SESSIONS,
              getTasks: () => hostRef.current.tasks ?? EMPTY_TASKS,
              getAttentionItems: () => hostRef.current.attention ?? EMPTY_ATTENTION,
              getSkills: () => hostRef.current.skills,
              waitForTasks: hostWarmup,
              waitForAttentionItems: hostWarmup,
              waitForSkills: hostWarmup,
            }
          : {}),
      }),
    // The host VALUES are deliberately absent from this list: they are read
    // through the ref above, so a settled catalog publishes itself through the
    // providers' own `snapshotKey` instead of rebuilding every provider and
    // aborting an open list mid-request. Only identity and policy rebuild.
    [daemon, directReferenceSuggestions, hostWarmup, hosted, mentionSuggestions, scope, skillSuggestions],
  );
  const autocomplete = useComposerAutocomplete({
    value: draft,
    onValueChange: setDraft,
    inputRef,
    providers: autocompleteProviders,
    disabled: disabled || sending,
  });
  const [vim, setVim] = useState<VimState>(initialVimState);
  // A composition is a STATE, not a key. `isComposing` on the event covers the
  // keystrokes the IME reports, and this covers the window between them, which
  // is where a menu would otherwise open over the candidate list.
  const composing = useRef(false);
  const pendingVimSelection = useRef<{ readonly value: string; readonly start: number; readonly end: number } | null>(
    null,
  );
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
          // A quote or an "Add to chat" delivery is a reader who is about to
          // TYPE. Landing them in normal mode would answer their next letter
          // with a command, so every programmatic draft delivery returns to
          // insert — the same rule dictation follows below.
          setVim(initialVimState);
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
    [scope, setDraft],
  );

  // `scope` already carries the daemon identity, so it changes whenever the daemon does; listing
  // daemon.daemonId as well only re-ran this redundantly.
  useEffect(() => {
    setDraft(draftStore.load(scope));
    setError(null);
    // A mode is a property of an editing session, not of the browser tab: the
    // reader who arrives at another session has not asked for normal mode there.
    setVim(initialVimState);
  }, [draftStore, scope, setDraft]);

  // Turning the preference off must not leave a reader stranded in a mode whose
  // exit key is the one they no longer have.
  useEffect(() => {
    if (!vimMode) setVim(initialVimState);
  }, [vimMode]);

  // The caret half of a Vim outcome, applied after the controlled value that
  // carries it has actually rendered. Setting it before that would place it in
  // the OLD text and the browser would clamp it somewhere else entirely.
  useLayoutEffect(() => {
    const pending = pendingVimSelection.current;
    const input = inputRef.current;
    if (pending === null || input === null || pending.value !== draft || input.value !== draft) return;
    pendingVimSelection.current = null;
    try {
      input.setSelectionRange(pending.start, pending.end);
    } catch {
      // A detached textarea can refuse a selection; the text still landed.
    }
    syncAutocompleteSelection.current({ start: pending.start, end: pending.end });
  }, [draft]);

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
      // The next message starts as text, not as commands.
      setVim(initialVimState);
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
    // BEFORE the text lands, not after: spoken words are inserted at the caret,
    // and a normal-mode caret sits ON a character rather than between two.
    setVim(initialVimState);
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
  }, [setDraft]);

  /** Write a Vim outcome back through the controlled draft, never into the DOM. */
  const applyVim = (outcome: { readonly value: string; readonly selectionStart: number; readonly state: VimState }) => {
    setVim(outcome.state);
    if (outcome.value === draft) {
      // A pure movement: there is no new value to wait for, so the caret can go
      // now — and going now is what keeps `j` responsive.
      const input = inputRef.current;
      try {
        input?.setSelectionRange(outcome.selectionStart, outcome.selectionStart);
      } catch {
        // A detached textarea can refuse a selection.
      }
      syncAutocompleteSelection.current({ start: outcome.selectionStart, end: outcome.selectionStart });
      return;
    }
    pendingVimSelection.current = { value: outcome.value, start: outcome.selectionStart, end: outcome.selectionStart };
    setDraft(outcome.value);
  };

  const previewText = useDeferredDraft(draft, PREVIEW_DEBOUNCE_MS, `${scope.daemonId} ${scope.sessionId}`);
  const previewMaxPx = !compact
    ? PREVIEW_MAX_PX
    : keyboardOpen
      ? COMPACT_KEYBOARD_PREVIEW_MAX_PX
      : COMPACT_PREVIEW_MAX_PX;

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
      {highlighted ? <ComposerMarkdownPreview maxHeightPx={previewMaxPx} text={previewText} {...references} /> : null}
      <ComposerReferenceStrip
        draft={draft}
        onRemove={(start, end) => {
          // Exactly the token's own bytes, and nothing either side of them: the
          // offsets come from the shared parser that found it.
          const next = `${draft.slice(0, start)}${draft.slice(end)}`;
          pendingVimSelection.current = { value: next, start, end: start };
          setDraft(next);
          inputRef.current?.focus();
        }}
        surface={references}
      />
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
          onCompositionEnd={event => {
            composing.current = false;
            const input = event.currentTarget as unknown as HTMLTextAreaElement;
            // Re-read the trigger only now: the bytes are finally the reader's,
            // so a reference the composition ended on is offered immediately
            // rather than after one more keystroke.
            autocomplete.endComposition({ start: input.selectionStart, end: input.selectionEnd });
          }}
          onCompositionStart={() => {
            composing.current = true;
            autocomplete.startComposition();
          }}
          onKeyDown={event => {
            // ARBITRATION ORDER, and every step of it is load-bearing.
            //
            // 0. A composing key belongs to the input method and to nobody else.
            //    It must not accept a candidate, must not send, and must never
            //    reach the Vim engine, which would read a Japanese, Chinese or
            //    Korean composition as commands.
            // 1. A visible, SELECTED completion gets Enter/Tab; an empty,
            //    loading or refused list cannot consume either key, and neither
            //    can a direct-sigil list nobody has chosen a row in.
            // 2. Escape and the arrows belong to the open list first — which is
            //    why the FIRST Escape closes it and stays in insert mode.
            // 3. Vim, when the reader asked for it. A second Escape reaches it
            //    because the list is now closed.
            // 4. The reader's configured send/newline behaviour, last. Enter in
            //    normal mode arrives here unclaimed, so the policy is unchanged.
            if (composing.current || (event.nativeEvent as { isComposing?: boolean }).isComposing) return;
            const completionKey = event.key === 'Enter' || event.key === 'Tab';
            const hasAcceptableCompletion = autocomplete.open && autocomplete.activeIndex >= 0;
            if (completionKey) {
              if (hasAcceptableCompletion && autocomplete.handleKeyDown(event)) return;
            } else if (autocomplete.handleKeyDown(event)) return;
            if (vimMode) {
              const input = event.currentTarget as unknown as HTMLTextAreaElement;
              const outcome = vimReduce(
                vim,
                { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey },
                { value: draft, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd },
              );
              // `handled` is the EVIDENCE for preventDefault, never a request:
              // an unclaimed key keeps its browser and system meaning.
              if (outcome.handled) {
                event.preventDefault();
                applyVim(outcome);
                return;
              }
            }
            if (event.key !== 'Enter') return;
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
        {vimMode ? (
          <>
            {/* One transition, one polite announcement. The word itself is the
                state — a colour alone would say nothing to half the readers who
                need this most, and Escape is not reachable on a phone at all,
                which is why the indicator is also the toggle. */}
            <span aria-atomic="true" aria-live="polite" className="sr-only">
              {`${VIM_MODE_LABEL[vim.mode]} mode`}
            </span>
            <button
              aria-label={`Vim ${VIM_MODE_LABEL[vim.mode]} mode. Switch to ${
                vim.mode === 'insert' ? VIM_MODE_LABEL.normal : VIM_MODE_LABEL.insert
              } mode`}
              className="mono min-h-[44px] min-w-[44px] rounded-control border border-border-soft px-2 text-2xs uppercase tracking-label"
              data-composer-vim-mode={vim.mode}
              disabled={disabled || sending}
              onClick={() => {
                setVim(vim.mode === 'insert' ? { mode: 'normal', operator: null, column: null } : initialVimState);
                inputRef.current?.focus();
              }}
              type="button"
            >
              {VIM_MODE_LABEL[vim.mode]}
            </button>
          </>
        ) : null}
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
