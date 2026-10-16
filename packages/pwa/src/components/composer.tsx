import type { IFyApiClient, SessionView } from '@ferretry/protocol';
import { ArrowUp, Plus, Zap } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readInputModality, useInputModality } from '../hooks/use-input-modality.ts';
import { useKeyboardOpen } from '../hooks/use-keyboard-open.ts';
import { uploadAttachment as uploadSessionAttachment } from '../lib/attachment-upload.ts';
import { continueList, type DraftEdit, insideCodeBlock } from '../lib/composer-editing.ts';
import { useComposerHostWarmup } from '../lib/composer-host-warmup.ts';
import {
  type ComposerEnterKeyPreference,
  composerEnterAction,
  shiftedComposerEnterAction,
} from '../lib/composer-keybinding.ts';
import { initialVimState, normalVimState, type VimState, vimReduce } from '../lib/composer-vim.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionKey, daemonSessionScope } from '../lib/daemon-scope.ts';
import { type DaemonDraftStore, documentDraftStore } from '../lib/drafts.ts';
import { applyFormat, type FormatCommand, formatShortcut } from '../lib/live-markdown.ts';
import { useMdComposePref } from '../lib/md-compose.ts';
import { registerComposerQuoteTarget } from '../lib/quote.ts';
import { findReferences } from '../lib/references.ts';
import type { DaemonFetch } from '../lib/runtime-models.ts';
import { browserFetch } from '../lib/runtime-models.ts';
import { canSubmitComposer } from '../lib/session-screens.ts';
import type { BrowserRecognitionProvider } from '../lib/stt/browser-recognition.ts';
import type { SttSettings } from '../lib/stt/stt-settings.ts';
import { type ComposerAttachmentUploader, useComposerAttachments } from './composer-attachments.ts';
import {
  type ComposerSuggestionSwitches,
  DEFAULT_COMPOSER_SUGGESTIONS,
  type ComposerField,
  type ComposerFieldKeyEvent,
  useComposerAutocomplete,
} from './composer-autocomplete.ts';
import { ComposerAutocompletePopover } from './composer-autocomplete-popover.tsx';
import {
  type ComposerAttentionItem,
  type ComposerSkillsCatalog,
  createComposerAutocompleteProviders,
} from './composer-autocomplete-providers.ts';
import { ComposerQuota, type ComposerQuotaProps } from './composer-quota.tsx';
import { DictationControl } from './dictation-control.tsx';
import { Markdown } from './markdown.tsx';
import { type ReferenceSurface, useReferenceSurface } from './reference-surface.tsx';
import { ComposerFormatToolbar } from './composer-format-toolbar.tsx';
import { LiveMarkdownEditor } from './live-markdown-editor.tsx';
import { PendingAttachmentStrip } from './session-chat-parts.tsx';

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
  /** Browser-local return-key behaviour on a phone or other touch-first device. null = new line. */
  readonly phoneEnterKeyPreference?: ComposerEnterKeyPreference | null;
  /** Browser-local dictation settings. Absence leaves this optional slot empty. */
  readonly dictationSettings?: SttSettings;
  /** Test/visual seam; production feature-detects the ambient browser. */
  readonly dictationRecognition?: BrowserRecognitionProvider;
  /** One already-read daemon fleet slice, shared with transcript references. */
  readonly autocompleteSessions?: readonly SessionView[];
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
  /**
   * The host's authenticated carrier transport for the autocomplete families
   * that must read the daemon themselves (files and terminal surfaces).
   *
   * A session page already owns this route selection. Threading it through
   * keeps an autocomplete request on that same measured carrier instead of
   * silently falling back to the browser's direct network path.
   */
  readonly autocompleteFetcher?: DaemonFetch;
  /** Which suggestion families this reader still wants offered. Absent means all
   *  of them. Suppression is menus only — every reference still parses here. */
  readonly suggestions?: ComposerSuggestionSwitches;
  /** Modal editing over the native textarea. Off is the default and the whole
   *  arbitration below collapses to today's behaviour when it is off. */
  readonly vimMode?: boolean;
  /**
   * Uploads one attached file to this session. Absent means the composer uploads through
   * `autocompleteFetcher` — the host's carrier — to its own daemon and session.
   */
  readonly uploadAttachment?: ComposerAttachmentUploader;
  /** The session's runtime chips (model, effort), drawn at the start of the status line. */
  readonly statusSlot?: ReactNode;
  /** How full the session's context window is, when the harness reported it. */
  readonly contextPercent?: number;
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
/** ONE LINE at rest, the same 22px `.fy-composer textarea` declares — stated here so the two cannot
 *  drift. The touch target is the row around it (36px controls plus its padding, 44px tall), not the
 *  bare line, which is what lets an idle composer be a single compact line. */
const MIN_TEXTAREA_PX = 22;

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

/** The daemon's words for a message that waits behind the running turn rather than arriving now. */
const isQueuedDisposition = (disposition: unknown): boolean =>
  disposition === 'queued' || disposition === 'queued-for-revive';

/** Does a drag or a drop carry files, rather than text or a link? */
const hasFiles = (transfer: Pick<DataTransfer, 'types'> | null): boolean =>
  transfer !== null && Array.from(transfer.types).includes('Files');

/** Stable empties, so an unsettled family is a getter that answers rather than a
 *  getter that is missing — and never a new array identity per render. */
const EMPTY_SESSIONS: readonly SessionView[] = [];
const EMPTY_ATTENTION: readonly ComposerAttentionItem[] = [];

/** The selection half of the field: a textarea has it, and so does the live editor's handle. */
interface ComposerFieldSelection {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
}

/** A key on the field, from the textarea or the live editor: the slice the arbitration reads. */
interface ComposerKeyEvent extends ComposerFieldKeyEvent {
  readonly code?: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly currentTarget?: ComposerFieldSelection;
}

/** How this platform spells the shortcut modifier in a tooltip. */
const shortcutModifier = (): string => (/Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl+');

/** The composer's own name for a Vim mode, in words rather than in colour. */
const VIM_MODE_LABEL: Record<VimState['mode'], string> = { insert: 'Insert', normal: 'Normal' };

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
  phoneEnterKeyPreference = null,
  dictationSettings,
  dictationRecognition,
  autocompleteSessions,
  autocompleteAttention,
  autocompleteSkills,
  autocompleteReady,
  autocompleteFetcher,
  suggestions,
  vimMode = false,
  uploadAttachment,
  statusSlot,
  contextPercent,
}: ComposerProps) {
  const scope = useMemo(() => daemonSessionScope(daemon, sessionId), [daemon, sessionId]);
  const uploader = useMemo<ComposerAttachmentUploader>(
    () =>
      uploadAttachment ?? (file => uploadSessionAttachment(daemon, scope, file, autocompleteFetcher ?? browserFetch)),
    [autocompleteFetcher, daemon, scope, uploadAttachment],
  );
  const attachments = useComposerAttachments(uploader, daemonSessionKey(scope));
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dropping, setDropping] = useState(false);
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
  const scopeKey = daemonSessionKey(scope);
  const [draftState, setDraftState] = useState(() => ({ key: scopeKey, text: draftStore.load(scope) }));
  const draft = draftState.key === scopeKey ? draftState.text : draftStore.load(scope);
  const setDraft = useCallback((text: string) => setDraftState({ key: daemonSessionKey(scope), text }), [scope]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const fieldId = useId();
  // A reader preference, not daemon data: it changes only how this browser
  // edits a draft, so a daemon switch must not change the editor chrome.
  const editorStyle = useMdComposePref();
  /** Markdown (Notion-style) and Rich text both edit through the live editor; Plain is a textarea. */
  const formatting = editorStyle !== 'off';
  const rich = editorStyle === 'rich';
  const references = useReferenceSurface();
  /** The field every editing path reads and writes: the textarea, or the live editor's handle. */
  const inputRef = useRef<(ComposerField & ComposerFieldSelection) | null>(null);
  /** The Plain textarea itself, whose height the composer measures. */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** The editable element, for the dictation shortcut's focus check. */
  const elementRef = useRef<HTMLElement | null>(null);
  const setField = useCallback((field: (ComposerField & ComposerFieldSelection) | null) => {
    inputRef.current = field;
  }, []);
  // Read as four booleans rather than as one object BECAUSE providers are
  // rebuilt from these: a host that passed a fresh literal every render would
  // otherwise abort and re-issue the open list's request on every keystroke.
  // Absent is the shipped default — the `@` ladder — exactly as the stored preference is.
  const { mentionSuggestions, ladderSuggestions, directReferenceSuggestions, skillSuggestions } =
    suggestions ?? DEFAULT_COMPOSER_SUGGESTIONS;
  // A host that supplies any of these owns all four families; a host that
  // supplies none is a standalone composer and keeps the daemon-backed defaults.
  const hosted =
    autocompleteSessions !== undefined ||
    autocompleteAttention !== undefined ||
    autocompleteSkills !== undefined ||
    autocompleteReady !== undefined;
  const hostRef = useRef({
    sessions: autocompleteSessions,
    attention: autocompleteAttention,
    skills: autocompleteSkills,
    ready: autocompleteReady,
  });
  hostRef.current = {
    sessions: autocompleteSessions,
    attention: autocompleteAttention,
    skills: autocompleteSkills,
    ready: autocompleteReady,
  };
  /**
   * THE COMMIT HANDSHAKE, owned by `useComposerHostWarmup`.
   *
   * A host answer is only readable one commit after its promise settles, so the
   * providers below wait for a COMMIT rather than for a microtask. The reason
   * that matters, and the unmount fence that keeps the wait total, are in that
   * module.
   */
  const { warmup: hostWarmup } = useComposerHostWarmup(() => hostRef.current.ready);
  const autocompleteProviders = useMemo(
    () =>
      createComposerAutocompleteProviders({
        daemon,
        scope,
        ...(autocompleteFetcher === undefined ? {} : { fetcher: autocompleteFetcher }),
        suggestions: { mentionSuggestions, ladderSuggestions, directReferenceSuggestions, skillSuggestions },
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
              getAttentionItems: () => hostRef.current.attention ?? EMPTY_ATTENTION,
              getSkills: () => hostRef.current.skills,
              waitForAttentionItems: hostWarmup,
              waitForSkills: hostWarmup,
            }
          : {}),
      }),
    // The host VALUES are deliberately absent from this list: they are read
    // through the ref above, so a settled catalog publishes itself through the
    // providers' own `snapshotKey` instead of rebuilding every provider and
    // aborting an open list mid-request. Only identity and policy rebuild.
    [
      autocompleteFetcher,
      daemon,
      directReferenceSuggestions,
      hostWarmup,
      hosted,
      ladderSuggestions,
      mentionSuggestions,
      scope,
      skillSuggestions,
    ],
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
  const keyboardOpen = useKeyboardOpen();
  const inputModality = useInputModality();
  const bareEnterAction = composerEnterAction(
    inputModality.enterSends ? enterKeyPreference : phoneEnterKeyPreference,
    inputModality.enterSends,
  );
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
  //
  // Only the Plain textarea is measured: the live editor is a block that grows with its own content
  // up to the same ceiling, given as its `maxHeight`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `formatting` is a re-measure trigger -- switching back to Plain mounts a fresh textarea
  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (input === null) return;
    input.style.height = 'auto';
    const next = Math.min(maxTextareaPx, Math.max(MIN_TEXTAREA_PX, input.scrollHeight));
    input.style.height = `${next}px`;
    input.style.overflowY = input.scrollHeight > maxTextareaPx ? 'auto' : 'hidden';
  }, [draft, formatting, maxTextareaPx]);

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

  const attachmentIds = attachments.readyIds;
  // Files alone are a message: the send still carries a sentence, because the route requires one and
  // the agent should be told why a list of paths arrived.
  const canSubmit =
    !attachments.uploading &&
    (canSubmitComposer(draft, disabled, sending) || (attachmentIds.length > 0 && !disabled && !sending));
  /**
   * `interrupt` is the ONLY way a send asks the daemon for `now`, and only the explicit ⌘/Ctrl+⇧+↵
   * reaches it. `now` makes the daemon press Escape on the agent's pane, which stops a turn — so it
   * is never derived from what this page THINKS the agent is doing: a stale idle reading would
   * otherwise interrupt real work. Every ordinary send (Enter, the ↑ button, any send-key mode) is
   * queued behind a running turn instead.
   */
  const submit = async (interrupt = false) => {
    if (!canSubmit || submitLock.current) return;
    submitLock.current = true;
    setSending(true);
    setError(null);
    try {
      const message = draft.trim() || 'See the attached files.';
      const sent = (await api.send(sessionId, {
        message,
        ...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
        now: interrupt,
      })) as { readonly disposition?: unknown } | undefined;
      // Remembered only while it waits in the agent's queue: ↑ in an empty box brings it back.
      lastQueued.current = isQueuedDisposition(sent?.disposition) ? { key: scopeKey, text: message } : null;
      setRecalled(false);
      for (const provider of autocompleteProviders) provider.reset?.();
      attachments.clear();
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

  const applyDictation = useCallback(
    (result: { readonly text: string; readonly caret: number }): void => {
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
    },
    [setDraft],
  );

  /**
   * ↑ IN AN EMPTY BOX BRINGS BACK THE LAST QUEUED MESSAGE — this browser's last send to this session
   * that the daemon reported as queued behind a running turn.
   *
   * The harness already holds the original in its own queue, and no daemon route can take a typed
   * message back out of it, so this is an edit of a COPY: the box says so, and that the original will
   * still arrive unless the turn is interrupted. Recalling never sends and never withdraws anything.
   */
  const lastQueued = useRef<{ readonly key: string; readonly text: string } | null>(null);
  const [recalled, setRecalled] = useState(false);
  const recallQueued = (): boolean => {
    const queued = lastQueued.current;
    if (queued === null || queued.key !== scopeKey || draft !== '') return false;
    setDraft(queued.text);
    setRecalled(true);
    return true;
  };

  /** Does this Enter send? ⌘/Ctrl always does; otherwise this device's send key, reversed by Shift. */
  const sendsOnEnter = (event: {
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
  }) => {
    if (event.metaKey || event.ctrlKey) return true;
    const enterSends = readInputModality().enterSends;
    const action = composerEnterAction(enterSends ? enterKeyPreference : phoneEnterKeyPreference, enterSends);
    return event.shiftKey ? shiftedComposerEnterAction(action) === 'send' : action === 'send';
  };

  /** An editing rule's result, written through the controlled draft with its caret placed after render. */
  const applyEdit = (edit: DraftEdit): void => {
    pendingVimSelection.current = { value: edit.value, start: edit.caret, end: edit.caret };
    setDraft(edit.value);
  };

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

  /** A toolbar or shortcut format, applied to the draft at the field's selection. */
  const format = (command: FormatCommand, field: ComposerFieldSelection | null = inputRef.current): void => {
    const start = field?.selectionStart ?? draft.length;
    const end = field?.selectionEnd ?? start;
    applyEdit(applyFormat(draft, start, end, command));
  };

  /**
   * ONE KEY ARBITRATION for every editor style — the textarea and the live editor hand it the same
   * textarea-shaped event — and every step of its order is load-bearing.
   *
   * 0. A composing key belongs to the input method and to nobody else. It must not accept a
   *    candidate, must not send, and must never reach the Vim engine, which would read a Japanese,
   *    Chinese or Korean composition as commands.
   * 1. A visible, SELECTED completion gets Enter/Tab; an empty, loading or refused list cannot consume
   *    either key, and neither can a direct-sigil list nobody has chosen a row in.
   * 2. Escape and the arrows belong to the open list first — which is why the FIRST Escape closes it
   *    and stays in insert mode.
   * 3. Vim, when the reader asked for it. A second Escape reaches it because the list is now closed,
   *    and in normal mode Enter is a motion — it never sends.
   * 4. The formatting shortcuts, list continuation and the reader's configured send key, last.
   */
  const onFieldKeyDown = (event: ComposerKeyEvent): void => {
    if (composing.current || event.nativeEvent.isComposing) return;
    const completionKey = event.key === 'Enter' || event.key === 'Tab';
    const hasAcceptableCompletion = autocomplete.open && autocomplete.activeIndex >= 0;
    if (completionKey) {
      if (hasAcceptableCompletion && autocomplete.handleKeyDown(event)) return;
    } else if (autocomplete.handleKeyDown(event)) return;
    // A synthetic key event may carry no target; the caret then reads as the end of the draft.
    const field = event.currentTarget;
    const selectionStart = field?.selectionStart ?? draft.length;
    const selectionEnd = field?.selectionEnd ?? selectionStart;
    if (vimMode) {
      const outcome = vimReduce(
        vim,
        { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey },
        { value: draft, selectionStart, selectionEnd },
      );
      // `handled` is the EVIDENCE for preventDefault, never a request: an unclaimed key keeps its
      // browser and system meaning.
      if (outcome.handled) {
        event.preventDefault();
        applyVim(outcome);
        return;
      }
    }
    const modified = event.metaKey || event.ctrlKey;
    if (formatting && modified) {
      const command = formatShortcut(event);
      if (command !== null) {
        event.preventDefault();
        format(command, field ?? null);
        return;
      }
    }
    if (event.key === 'ArrowUp' && !modified && !event.shiftKey && recallQueued()) {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Enter') return;
    // ⌘/Ctrl+Enter sends in every mode, on every device; with Shift it is the one explicit
    // "send now", which interrupts the running turn.
    if (modified) {
      event.preventDefault();
      void submit(event.shiftKey);
      return;
    }
    if (formatting && !event.shiftKey) {
      if (insideCodeBlock(draft, selectionStart)) return;
      const continued = continueList(draft, selectionStart);
      if (continued !== null) {
        event.preventDefault();
        applyEdit(continued);
        return;
      }
    }
    if (!sendsOnEnter(event)) return;
    event.preventDefault();
    void submit();
  };

  /** What the field's editing events share, whichever editor style is drawing it. */
  const fieldEvents = {
    onChange: (event: { readonly currentTarget: ComposerFieldSelection & { readonly value: string } }) => {
      const input = event.currentTarget;
      setDraft(input.value);
      autocomplete.syncSelection({ start: input.selectionStart, end: input.selectionEnd });
    },
    onCompositionEnd: (event: { readonly currentTarget: ComposerFieldSelection }) => {
      composing.current = false;
      const input = event.currentTarget;
      // Re-read the trigger only now: the bytes are finally the reader's, so a reference the
      // composition ended on is offered immediately rather than after one more keystroke.
      autocomplete.endComposition({ start: input.selectionStart, end: input.selectionEnd });
    },
    onCompositionStart: () => {
      composing.current = true;
      autocomplete.startComposition();
    },
    onSelect: (event: { readonly currentTarget: ComposerFieldSelection }) => {
      const input = event.currentTarget;
      autocomplete.syncSelection({ start: input.selectionStart, end: input.selectionEnd });
    },
    onPaste: (event: { readonly clipboardData: DataTransfer | null; preventDefault(): void }) => {
      // A pasted screenshot is an attachment; pasted text stays the editor's to insert.
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      attachments.add(files);
    },
  };

  const modifierLabel = shortcutModifier();
  const sendKeyLabel = bareEnterAction === 'send' ? '↵' : '⇧↵';
  const sendLabel = sending ? 'Sending…' : 'Send';
  const sendTitle = busy
    ? `Send — queued for the agent's next turn (${sendKeyLabel} or ${modifierLabel}↵)`
    : `Send (${sendKeyLabel} or ${modifierLabel}↵)`;
  const interruptTitle = `Interrupt & send — stops the agent's turn and sends now (${modifierLabel}⇧↵)`;
  const fieldDisabled = disabled || sending;

  return (
    <form
      className="fy-composer"
      data-composer-dropping={dropping ? '' : undefined}
      data-composer-style={editorStyle}
      onDragLeave={() => setDropping(false)}
      onDragOver={event => {
        // Only a drag that carries files is ours; dragged text keeps the browser's own behaviour.
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDrop={event => {
        setDropping(false);
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        attachments.add(Array.from(event.dataTransfer.files));
      }}
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" htmlFor={`${fieldId}-input`}>
        Message
      </label>
      {attachments.entries.length === 0 ? null : (
        <PendingAttachmentStrip
          entries={attachments.entries}
          onRemove={attachments.remove}
          onRetry={attachments.retry}
        />
      )}
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
      {rich ? (
        <ComposerFormatToolbar
          disabled={fieldDisabled}
          modifier={modifierLabel}
          onFormat={command => {
            format(command);
            inputRef.current?.focus();
          }}
        />
      ) : null}
      <div className="fy-composer-row">
        <button
          aria-label="Attach an image, audio or a file"
          className="fy-composer-icon"
          data-composer-attach=""
          disabled={fieldDisabled}
          onClick={() => fileInput.current?.click()}
          title="Attach an image, audio or a file — or drop or paste one here"
          type="button"
        >
          <Plus aria-hidden="true" size={18} />
        </button>
        <input
          aria-hidden="true"
          className="hidden"
          multiple
          onChange={event => {
            const input = event.currentTarget as unknown as HTMLInputElement;
            attachments.add(Array.from(input.files ?? []));
            // Cleared so choosing the same file again is still a change.
            input.value = '';
          }}
          ref={fileInput}
          tabIndex={-1}
          type="file"
        />
        <div className="fy-composer-input-layer" data-vim={vimMode ? vim.mode : undefined}>
          {formatting ? (
            <LiveMarkdownEditor
              {...autocomplete.textareaAria}
              {...fieldEvents}
              disabled={fieldDisabled}
              elementRef={elementRef}
              fieldRef={setField}
              id={`${fieldId}-input`}
              markers={rich ? 'hidden' : 'faint'}
              maxHeight={maxTextareaPx}
              onKeyDown={onFieldKeyDown}
              placeholder={placeholder}
              value={draft}
              {...(vimMode ? { vimMode: vim.mode } : {})}
            />
          ) : (
            <textarea
              {...fieldEvents}
              disabled={fieldDisabled}
              id={`${fieldId}-input`}
              onKeyDown={onFieldKeyDown}
              placeholder={placeholder}
              ref={node => {
                textareaRef.current = node;
                elementRef.current = node;
                setField(node);
              }}
              rows={1}
              value={draft}
              {...autocomplete.textareaAria}
            />
          )}
          {/* Anchored to the input layer, opening UPWARD: the composer sits at the
              bottom of the session, so a downward list would land off-screen and
              under the on-screen keyboard. */}
          <ComposerAutocompletePopover surface={autocomplete} />
        </div>
        {dictationSettings ? (
          <DictationControl
            {...(typeof api.history === 'function' ? { api: api as Pick<IFyApiClient, 'history'> } : {})}
            className="fy-composer-icon"
            composerRef={elementRef}
            daemon={daemon}
            disabled={fieldDisabled}
            draft={draft}
            layout="compact"
            onDraftChange={applyDictation}
            {...(dictationRecognition === undefined ? {} : { recognition: dictationRecognition })}
            selectionRef={inputRef}
            sessionId={sessionId}
            settings={dictationSettings}
          />
        ) : null}
        {busy ? (
          <button
            aria-label="Interrupt & send"
            className="fy-composer-interrupt"
            data-composer-interrupt=""
            disabled={!canSubmit}
            onClick={() => void submit(true)}
            title={interruptTitle}
            type="button"
          >
            <Zap aria-hidden="true" size={17} strokeWidth={2.25} />
          </button>
        ) : null}
        <button
          aria-label={sendLabel}
          className="fy-composer-send"
          data-composer-send=""
          disabled={!canSubmit}
          title={sendTitle}
          type="submit"
        >
          <ArrowUp aria-hidden="true" size={18} strokeWidth={2.5} />
        </button>
      </div>
      <div className="fy-composer-actions" data-composer-status="">
        {statusSlot}
        {contextPercent === undefined ? null : (
          <span className="fy-composer-context" title="How full this session's context window is">
            ctx {Math.round(contextPercent)}%
          </span>
        )}
        <ComposerQuota quota={quota} />
        <span className="fy-composer-spacer" />
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
              className="fy-composer-vim"
              data-composer-vim-mode={vim.mode}
              disabled={fieldDisabled}
              onClick={() => {
                setVim(vim.mode === 'insert' ? normalVimState(vim) : { ...vim, mode: 'insert', operator: null });
                inputRef.current?.focus();
              }}
              title={vim.mode === 'insert' ? 'Insert mode — Esc for normal mode' : 'Normal mode — i, a or o to type'}
              type="button"
            >
              {`-- ${VIM_MODE_LABEL[vim.mode].toUpperCase()} --`}
            </button>
          </>
        ) : null}
        {inputModality.touchAffected && bareEnterAction === 'send' ? (
          <button className="fy-composer-chip" type="button" onClick={insertNewline} disabled={fieldDisabled}>
            New line
          </button>
        ) : null}
      </div>
      {recalled && draft !== '' ? (
        <p className="fy-composer-recalled" data-composer-recalled="" role="status">
          Editing a copy of your queued message. The original is still in the agent’s queue and will arrive too unless
          you interrupt the turn.
        </p>
      ) : null}
      {error ? (
        <p className="fy-composer-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
