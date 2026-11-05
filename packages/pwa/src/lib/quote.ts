/**
 * Quote a transcript selection into the composer.
 *
 * The reader highlights transcript text and picks "Quote"; the selection is
 * wrapped as a markdown blockquote and dropped into the composer as the start of
 * a reply. Two halves, deliberately split:
 *
 *   PURE      — toBlockquote / composeQuotedDraft turn selected text into the
 *               exact new draft string, asserted with plain data.
 *   DELIVERY  — a registry of mounted composers, keyed by `(daemonId,
 *               sessionId)`, that the quote action asks for the pane it came
 *               from.
 *
 * WHY A REGISTRY RATHER THAN kteam's DOM WRITE. kteam's original found the one
 * `textarea[aria-label="Message"]` not inside an `aria-hidden` ancestor, then
 * drove React's value tracker through the prototype value setter and dispatched a
 * synthetic `input` event — because the draft lived in the page component, which
 * that feature did not own. In Ferretry the composer owns its own draft state
 * (`Composer`, `src/components/composer.tsx`), so it can publish a first-class
 * insert instead: no DOM scraping, no synthetic events, no dependence on an
 * `aria-label` string as a selector.
 *
 * WHY THE SCOPE IS EXPLICIT. kteam had exactly one live composer and could guess
 * "the foreground one" from `aria-hidden`. Here, retained background panes keep
 * their composers mounted, and two panes can belong to DIFFERENT daemons — so a
 * guess could deliver a quote into another daemon's session. Every target
 * registers under its full `(daemonId, sessionId)` scope and the quote is
 * delivered to that scope only, defaulting to the declared foreground pane.
 *
 * THE SELECTION IS READ BY THE CALLER, BEFORE THIS RUNS. Focusing the composer
 * collapses a live selection, so the caller captures the text at the moment the
 * menu opens and passes it in — nothing here reads the selection itself.
 */

import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import { getForegroundPinScope } from './pin-bridge.ts';

/**
 * Wrap text as a markdown blockquote: every line (including blank ones, so the
 * quote reads as one block) gets a `> ` prefix. Trailing whitespace on the whole
 * selection is trimmed first; interior blank lines are preserved. Returns '' for
 * empty/whitespace-only input, so a caller can cheaply skip a no-op.
 */
export const toBlockquote = (text: string): string => {
  const trimmed = text.replace(/\s+$/u, '');
  if (trimmed.trim().length === 0) return '';
  return trimmed
    .split('\n')
    .map(line => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
};

/**
 * The new composer value after quoting `selection` into an existing `draft`.
 *
 * A blockquote followed by a blank line, so the reader's reply starts on a fresh
 * line below it. When the composer already holds a draft, the quote is appended
 * after a blank-line separator rather than clobbering it — quoting is additive.
 * Returns the draft unchanged when the selection is empty.
 */
export const composeQuotedDraft = (draft: string, selection: string): string => {
  const quote = toBlockquote(selection);
  if (!quote) return draft;
  const block = `${quote}\n\n`;
  if (draft.trim().length === 0) return block;
  // Keep the existing draft, ensure a blank-line gap, then the quote block.
  return `${draft.replace(/\s*$/u, '')}\n\n${block}`;
};

/**
 * A file the session already stores, named so a composer can attach it again WITHOUT uploading it.
 * Only what a chip needs: the id is what a send names, the rest is what the chip says.
 */
export interface ExistingAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly size?: number;
}

/**
 * What a composer did with an existing attachment.
 *
 *   `added`    the chip is there now.
 *   `present`  it already was one; nothing changed.
 *   `refused`  this composer takes no files, or is at its limit — the caller still has the token to write.
 */
export type ExistingAttachmentOutcome = 'added' | 'present' | 'refused';

/** A mounted composer, addressable by the daemon and session it belongs to. */
export interface ComposerQuoteTarget extends DaemonSessionScope {
  /** The draft the composer currently holds. */
  readonly draft: () => string;
  /** Replace the draft, then focus and put the caret at the end of it. */
  readonly replaceDraft: (next: string) => void;
  /**
   * Put text into the draft AT THE CARET (or over the selection), with a space on either side where the
   * neighbouring words need one, then focus the composer with the caret after it. The path "Add to chat"
   * of a person's own typing would take, rather than an append.
   */
  readonly insertAtCaret?: (text: string) => void;
  /** Attach a file the session already stores, by its id: no upload. */
  readonly attachExisting?: (file: ExistingAttachment) => ExistingAttachmentOutcome;
  /**
   * Whether the draft can be written to right now. A composer that is mounted but disabled or sending is still
   * a target (a quote reads its draft), yet a reference must not edit it. Absent means always writable. When it
   * changes the composer calls `announceComposerTargetChange`, so a control that depends on it re-reads.
   */
  readonly writable?: () => boolean;
}

const targets = new Map<string, ComposerQuoteTarget>();
const listeners = new Set<() => void>();
let generation = 0;

const changed = (): void => {
  generation += 1;
  for (const listener of [...listeners]) listener();
};

/** Tells subscribers that a mounted composer's availability changed without it mounting or unmounting. */
export const announceComposerTargetChange = changed;

/** Whether a target can take a reference now: it can insert at the caret, and its draft is writable. */
export const composerTargetOpen = (target: ComposerQuoteTarget | null): boolean =>
  target !== null && target.insertAtCaret !== undefined && (target.writable?.() ?? true);

/** Tells a reader when a composer mounts or unmounts, for a control that is only live while one is open. */
export const subscribeComposerTargets = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A number that changes whenever the set of mounted composers does; the snapshot of the subscription above. */
export const composerTargetsGeneration = (): number => generation;

/**
 * Publishes a mounted composer as the quote target for its own scope. The
 * returned disposer removes only this registration, so a composer unmounting
 * after its replacement registered cannot orphan the live one.
 */
export const registerComposerQuoteTarget = (target: ComposerQuoteTarget): (() => void) => {
  const key = daemonSessionKey(target);
  targets.set(key, target);
  changed();
  return () => {
    if (targets.get(key) !== target) return;
    targets.delete(key);
    changed();
  };
};

export const composerQuoteTarget = (scope: DaemonSessionScope): ComposerQuoteTarget | null =>
  targets.get(daemonSessionKey(scope)) ?? null;

/** The honest result of asking a composer to take a quoted selection. */
export type QuoteOutcome = 'quoted' | 'empty' | 'no-composer';

/**
 * Quotes a captured selection into one session's composer.
 *
 * `empty` covers both a whitespace-only selection and a draft the quote would not
 * change; `no-composer` means no composer is mounted for that scope (the reader
 * is on another tab, a structured question replaced the composer, or the pane is
 * read-only). The default scope is the declared foreground pane — the same source
 * of truth pin capture uses — so a quote never lands in a background daemon's
 * session.
 */
export const quoteSelectionIntoComposer = (
  selection: string,
  scope: DaemonSessionScope | null = getForegroundPinScope(),
): QuoteOutcome => {
  if (scope === null) return 'no-composer';
  const target = composerQuoteTarget(scope);
  if (target === null) return 'no-composer';
  const next = composeQuotedDraft(target.draft(), selection);
  if (next === target.draft()) return 'empty';
  target.replaceDraft(next);
  return 'quoted';
};
