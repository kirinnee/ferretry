/**
 * THE LIVE MARKDOWN EDITOR — the composer's formatting editor, for both the Markdown (Notion-style)
 * and the Rich text editor styles.
 *
 * WHY THIS EXISTS. The Markdown style used to be a `<textarea>` with a colour-only paint layer behind
 * it. A textarea cannot show one line bigger or bolder than another, and the paint layer was forbidden
 * to change a glyph's width (it would have walked away from the native caret), so `# Title` and
 * `**bold**` could only ever change colour. This editor is a `contenteditable` document instead, so a
 * heading really is bigger and bold really is bold.
 *
 * THE SOURCE IS THE DOCUMENT. Every character the reader typed — markers included — is a text node
 * here, and `lib/live-markdown.ts` only decides how each one is painted. So:
 *
 *   - what is sent is exactly the markdown that was typed, in both styles;
 *   - a caret offset is an offset into the draft, which is what lets Vim, the reference autocomplete,
 *     list continuation and ⌘B work here exactly as they do on a textarea;
 *   - the two styles differ only in paint: Markdown keeps the markers faintly visible, Rich text hides
 *     them on every line but the one being edited (and draws bullets and boxes in both).
 *
 * IT LOOKS LIKE A TEXTAREA TO ITS HOST. Its events carry a `currentTarget` with `value`,
 * `selectionStart`, `selectionEnd`, `setSelectionRange` and `focus` — the same slice of a textarea the
 * composer already reads — so the composer's key arbitration (completion, Vim, the send key) is one
 * code path for every editor style.
 *
 * EDITING. Typing, deleting, pasting and line breaks are applied as edits to the source (from
 * `beforeinput`), and the document is re-rendered from the result with the caret restored by offset.
 * An input-method composition is the exception: the platform owns it until `compositionend`, the text
 * is read back from the document, and only then is it re-rendered. Because re-rendering replaces the
 * nodes the browser's own undo stack points at, this editor keeps its own (⌘Z / ⌘⇧Z).
 */

import { type ClipboardEvent, type KeyboardEvent, type RefObject, useLayoutEffect, useMemo, useRef } from 'react';
import { toggleWrap } from '../lib/composer-editing.ts';
import { type LiveLine, parseLiveMarkdown, removeBlockMarker } from '../lib/live-markdown.ts';

/** The slice of a textarea the composer reads, which this editor provides too. */
export interface LiveFieldHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
  contains(node: Node | null): boolean;
  /**
   * Ends a composition in progress (a send was pressed under it), reading the word being composed into
   * the draft. Answers whether that changed the draft, i.e. whether the host must wait for it.
   */
  endComposition(): boolean;
}

interface LiveFieldEvent {
  readonly currentTarget: LiveFieldHandle;
}

export interface LiveKeyEvent extends LiveFieldEvent {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean };
  preventDefault(): void;
}

/** `faint`: the Markdown style, every marker visible but quiet. `hidden`: Rich text, markers off the caret's line hidden. */
export type LiveMarkers = 'faint' | 'hidden';

const ELEMENT = 1;

/** Builds one line of the document. `reveal` shows a hidden-style line's markers (the caret is on it). */
const renderLine = (doc: Document, line: LiveLine, markers: LiveMarkers, reveal: boolean): HTMLElement => {
  const element = doc.createElement('div');
  element.setAttribute('data-line', '');
  element.setAttribute('data-block', line.kind);
  const hide = markers === 'hidden' && !reveal;
  if (line.indent !== '') element.appendChild(doc.createTextNode(line.indent));
  if (line.marker !== '') {
    const marker = doc.createElement('span');
    marker.setAttribute('data-md-marker', line.kind);
    if (line.kind === 'check') marker.setAttribute('data-checked', String(line.checked));
    // Bullets and boxes are drawn as glyphs in both styles; heading and quote markers are text.
    if (hide && (line.kind === 'quote' || line.kind.startsWith('h'))) marker.setAttribute('data-md-hidden', '');
    marker.textContent = line.marker;
    element.appendChild(marker);
  }
  for (const run of line.runs) {
    const syntax = run.mark || line.kind === 'fence' || line.kind === 'hr';
    if (run.style === null && !syntax) {
      element.appendChild(doc.createTextNode(run.text));
      continue;
    }
    const span = doc.createElement('span');
    if (run.style !== null) span.setAttribute('data-md', run.style);
    if (syntax) span.setAttribute('data-md-mark', '');
    if (run.mark && hide) span.setAttribute('data-md-hidden', '');
    span.textContent = run.text;
    element.appendChild(span);
  }
  if (line.text === '') element.appendChild(doc.createElement('br'));
  return element;
};

/** Which line an offset falls on. */
const lineAt = (lines: readonly LiveLine[], offset: number): number => {
  let index = 0;
  for (const [candidate, line] of lines.entries()) if (line.start <= offset) index = candidate;
  return index;
};

/**
 * Replaces the editor's document with the rendering of `value`. `caret` is the offset the reader is
 * at, or `null` when the editor does not have focus — in the hidden style that is what reveals one
 * line's markers.
 */
export const renderLiveDocument = (
  root: HTMLElement,
  value: string,
  options: { readonly markers: LiveMarkers; readonly caret: number | null },
): void => {
  const doc = root.ownerDocument;
  const lines = parseLiveMarkdown(value);
  const revealed = options.caret === null ? -1 : lineAt(lines, options.caret);
  root.replaceChildren(
    ...lines.map((line, index) =>
      renderLine(doc, line, options.markers, options.markers === 'faint' || index === revealed),
    ),
  );
  if (value === '') root.setAttribute('data-empty', '');
  else root.removeAttribute('data-empty');
};

/** One node's text as source: no zero-width fillers, and a non-breaking space is a space. */
const sourceText = (node: Node): string => (node.textContent ?? '').replace(/\u200b/gu, '').replace(/\u00a0/gu, ' ');

/** A block element: one line of the document. Anything else is inline content of the line it sits on. */
const isLine = (node: Node): boolean =>
  node.nodeType === ELEMENT && /^(?:DIV|P|LI|H\d|PRE|BLOCKQUOTE)$/u.test((node as Element).tagName);

/**
 * The document back as the draft. Each block child is a line; text the browser put straight into the
 * root (it can, mid-composition, in an emptied editor) joins the line it sits on, and a stray `<br>`
 * there ends it.
 */
export const readLiveDocument = (root: HTMLElement): string => {
  const lines: string[] = [];
  let open = false;
  for (const child of Array.from(root.childNodes)) {
    if (isLine(child)) {
      lines.push(sourceText(child));
      open = false;
    } else if ((child as Element).tagName === 'BR') {
      if (!open) lines.push('');
      open = false;
    } else if (open) lines[lines.length - 1] += sourceText(child);
    else {
      lines.push(sourceText(child));
      open = true;
    }
  }
  return lines.join('\n');
};

/** The top-level line a node sits in, or `null` when the node is outside the editor. */
const lineOf = (root: HTMLElement, node: Node): Node | null => {
  let at: Node | null = node;
  while (at !== null && at.parentNode !== root) at = at.parentNode;
  return at;
};

/** The source offset of a DOM position inside the editor. */
export const liveOffset = (root: HTMLElement, node: Node, offset: number): number => {
  const children = Array.from(root.childNodes);
  const starts: number[] = [];
  let total = 0;
  for (const child of children) {
    starts.push(total);
    total += sourceText(child).length + 1;
  }
  const end = Math.max(total - 1, 0);
  if (node === root) return offset >= children.length ? end : (starts[offset] as number);
  const line = lineOf(root, node);
  if (line === null) return end;
  const range = root.ownerDocument.createRange();
  range.setStart(line, 0);
  range.setEnd(node, offset);
  return (starts[children.indexOf(line as ChildNode)] as number) + range.toString().replace(/\u200b/gu, '').length;
};

/** True for text the reader cannot see: a hidden marker, where a placed caret would vanish. */
const isHidden = (node: Node): boolean => (node.parentElement?.closest('[data-md-hidden]') ?? null) !== null;

/** The DOM position of a source offset; at a boundary, the end of visible text wins over hidden text. */
export const livePosition = (root: HTMLElement, offset: number): { readonly node: Node; readonly offset: number } => {
  let remaining = Math.max(offset, 0);
  const lines = Array.from(root.childNodes);
  let index = 0;
  while (index < lines.length - 1 && remaining > sourceText(lines[index] as Node).length) {
    remaining -= sourceText(lines[index] as Node).length + 1;
    index += 1;
  }
  const line = lines[index];
  if (line === undefined) return { node: root, offset: 0 };
  const walker = root.ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
    const size = (text.textContent ?? '').length;
    if (remaining < size || (remaining === size && !isHidden(text))) return { node: text, offset: remaining };
    remaining -= size;
    last = text;
  }
  return last === null ? { node: line, offset: 0 } : { node: last, offset: (last.textContent ?? '').length };
};

/** The editor's document selection as source offsets, or `null` when the selection is elsewhere. */
const selectionIn = (root: HTMLElement): { readonly start: number; readonly end: number } | null => {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = liveOffset(root, range.startContainer, range.startOffset);
  const end = liveOffset(root, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
};

/** Places the document selection at source offsets. */
const select = (root: HTMLElement, start: number, end: number): void => {
  const selection = root.ownerDocument.getSelection();
  if (selection === null) return;
  const from = livePosition(root, start);
  const to = start === end ? from : livePosition(root, end);
  const range = root.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
};

/** The previous code-point boundary, so a fallback Backspace never splits a surrogate pair. */
const backOne = (value: string, index: number): number => {
  if (index <= 0) return 0;
  const code = value.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && index >= 2 ? index - 2 : index - 1;
};

const forwardOne = (value: string, index: number): number => {
  if (index >= value.length) return value.length;
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff ? index + 2 : index + 1;
};

/** What a native format command wraps the selection in; the rest are refused. */
const FORMAT_MARKERS: Readonly<Record<string, string>> = {
  formatBold: '**',
  formatItalic: '*',
  formatStrikeThrough: '~~',
};

interface Snapshot {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** How far back ⌘Z goes. */
const UNDO_LIMIT = 200;

export interface LiveMarkdownEditorProps {
  readonly id: string;
  readonly value: string;
  readonly markers: LiveMarkers;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly maxHeight?: number;
  /** Receives the textarea-shaped handle once mounted, and `null` on unmount. */
  readonly fieldRef: (handle: LiveFieldHandle | null) => void;
  /** Receives the editable element itself, for hosts that need a real node (focus checks). */
  readonly elementRef?: RefObject<HTMLElement | null>;
  readonly onChange: (event: LiveFieldEvent) => void;
  readonly onKeyDown?: (event: LiveKeyEvent) => void;
  readonly onSelect?: (event: LiveFieldEvent) => void;
  readonly onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onCompositionStart?: () => void;
  readonly onCompositionEnd?: (event: LiveFieldEvent) => void;
  /** `normal` while Vim is in normal mode, so the caret can say so. */
  readonly vimMode?: 'insert' | 'normal';
  readonly 'aria-autocomplete'?: 'list';
  readonly 'aria-controls'?: string;
  readonly 'aria-expanded'?: boolean;
  readonly 'aria-activedescendant'?: string;
  readonly 'aria-haspopup'?: 'listbox';
}

export function LiveMarkdownEditor({
  id,
  value,
  markers,
  placeholder,
  disabled = false,
  maxHeight,
  fieldRef,
  elementRef,
  onChange,
  onKeyDown,
  onSelect,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  vimMode,
  ...aria
}: LiveMarkdownEditorProps) {
  const root = useRef<HTMLDivElement | null>(null);
  /** The draft the document currently shows; `null` before the first render. */
  const rendered = useRef<string | null>(null);
  /** The caret when the document has no selection of its own (unfocused, or not yet painted). */
  const caret = useRef({ start: value.length, end: value.length });
  const composing = useRef(false);
  /** Every text this composition has handed the host: a render that lags behind it is an echo, not a change. */
  const reported = useRef(new Set<string>());
  /**
   * The host replaced the words under a composition (a send, another device): the rest of that composition
   * was typed into words that are gone, so it is painted over, never read back. A new composition ends it.
   */
  const interrupted = useRef(false);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  /** The last edit kind recorded, so a run of typed characters undoes as one step. */
  const lastKind = useRef<string | null>(null);
  // Read through refs by the native listeners, which are installed once.
  const latest = useRef({ markers, disabled, onChange, onSelect, onCompositionStart, onCompositionEnd });
  latest.current = { markers, disabled, onChange, onSelect, onCompositionStart, onCompositionEnd };

  const focused = (): boolean => root.current !== null && root.current.ownerDocument.activeElement === root.current;

  const currentSelection = (): { readonly start: number; readonly end: number } =>
    (root.current !== null && focused() ? selectionIn(root.current) : null) ?? caret.current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the handle reads every fact through refs, so it is built once
  const handle = useMemo<LiveFieldHandle>(
    () => ({
      get value() {
        return rendered.current ?? '';
      },
      get selectionStart() {
        return currentSelection().start;
      },
      get selectionEnd() {
        return currentSelection().end;
      },
      setSelectionRange(start: number, end: number) {
        const length = (rendered.current ?? '').length;
        caret.current = { start: Math.min(Math.max(start, 0), length), end: Math.min(Math.max(end, 0), length) };
        if (!focused()) return;
        paint(rendered.current ?? '', caret.current);
      },
      focus() {
        const element = root.current;
        if (element === null) return;
        element.focus({ preventScroll: true });
        paint(rendered.current ?? '', caret.current);
      },
      contains(node: Node | null) {
        return root.current?.contains(node) ?? false;
      },
      endComposition() {
        const element = root.current;
        if (!composing.current || element === null) return false;
        // The word being composed is the person's: it is read now and goes with the send. Whatever the
        // keyboard does with the rest of this composition comes after the press, and is not read back.
        composing.current = false;
        interrupted.current = true;
        reported.current.clear();
        const text = readLiveDocument(element);
        const changed = text !== rendered.current;
        rendered.current = text;
        if (changed) latest.current.onChange({ currentTarget: handle });
        latest.current.onCompositionEnd?.({ currentTarget: handle });
        return changed;
      },
    }),
    [],
  );

  /** Renders `next` and, when the editor has focus, puts the selection back at `at`. */
  function paint(next: string, at: { readonly start: number; readonly end: number }): void {
    const element = root.current;
    rendered.current = next;
    caret.current = at;
    if (element === null) return;
    const scroll = element.scrollTop;
    const hasFocus = focused();
    renderLiveDocument(element, next, { markers: latest.current.markers, caret: hasFocus ? at.start : null });
    element.scrollTop = scroll;
    if (!hasFocus) return;
    select(element, at.start, at.end);
    // Keep the caret in view when the document is taller than its box. A collapsed range in an empty
    // line measures as nothing, which is the one case left where it is.
    const box = element.ownerDocument.getSelection()?.getRangeAt(0).getBoundingClientRect?.();
    const frame = element.getBoundingClientRect();
    if (box !== undefined && box.height > 0) {
      if (box.bottom > frame.bottom) element.scrollTop += box.bottom - frame.bottom;
      else if (box.top < frame.top) element.scrollTop -= frame.top - box.top;
    }
  }

  /** Records the document before an edit, so ⌘Z can return to it. Consecutive typing is one step. */
  const record = (kind: string, before: Snapshot): void => {
    future.current = [];
    if (kind === 'type' && lastKind.current === 'type') return;
    lastKind.current = kind;
    past.current = [...past.current, before].slice(-UNDO_LIMIT);
  };

  /** Applies an edit to the source, repaints, and tells the host. */
  const edit = (kind: string, next: string, at: number): void => {
    const before = { value: rendered.current ?? '', ...currentSelection() };
    record(kind, before);
    paint(next, { start: at, end: at });
    latest.current.onChange({ currentTarget: handle });
  };

  const replace = (kind: string, start: number, end: number, text: string): void => {
    const source = rendered.current ?? '';
    edit(kind, source.slice(0, start) + text + source.slice(end), start + text.length);
  };

  const travel = (from: { current: Snapshot[] }, to: { current: Snapshot[] }): void => {
    const target = from.current.at(-1);
    if (target === undefined) return;
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, { value: rendered.current ?? '', ...currentSelection() }];
    lastKind.current = null;
    paint(target.value, { start: target.start, end: target.end });
    latest.current.onChange({ currentTarget: handle });
  };
  const undo = (): void => travel(past, future);
  const redo = (): void => travel(future, past);

  // The host's value is the truth: a change it made (Vim, a completion, a send, a quote, another
  // device's edit) is painted here, and remembered so ⌘Z can step back over it too.
  //
  // EVEN MID-COMPOSITION. A phone keyboard composes the word being typed (Android always, iOS for its
  // predictions), and Send does not end that. Left unpainted, a send's clear — or another device's
  // edit — never reached the screen: the box kept showing the sent words, and the composition's next
  // input read them back as typing, republishing a sent message to every device. So the host wins
  // there too, and what is left of that composition is never read back (`interrupted`). Only the
  // host's ECHO of what the composition already reported is left alone, so typing is never disturbed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `paint` and `record` read refs only
  useLayoutEffect(() => {
    if (value === rendered.current) return;
    const under = composing.current;
    if (under) {
      if (reported.current.has(value)) return;
      composing.current = false;
      interrupted.current = true;
      reported.current.clear();
    }
    if (rendered.current !== null) record('external', { value: rendered.current, ...caret.current });
    const at = Math.min(caret.current.start, value.length);
    paint(value, rendered.current === null ? { start: value.length, end: value.length } : { start: at, end: at });
    // Told once the words are painted, so what the host reads is what it now holds.
    if (under) latest.current.onCompositionEnd?.({ currentTarget: handle });
  }, [value]);

  // The style switch repaints in place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `paint` reads refs only
  useLayoutEffect(() => {
    if (rendered.current !== null) paint(rendered.current, currentSelection());
  }, [markers]);

  useLayoutEffect(() => {
    fieldRef(handle);
    return () => fieldRef(null);
  }, [fieldRef, handle]);

  // Native listeners: `beforeinput` and `selectionchange` have no React equivalent worth trusting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: every fact is read through refs
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    const doc = element.ownerDocument;

    const onBeforeInput = (event: Event): void => {
      const input = event as InputEvent;
      if (latest.current.disabled) {
        input.preventDefault();
        return;
      }
      const type = input.inputType;
      // A composition belongs to the input method until it ends.
      if (composing.current || type === 'insertCompositionText') return;
      const selection = currentSelection();
      const source = rendered.current ?? '';
      const target = input.getTargetRanges?.()[0];
      const range =
        target === undefined
          ? selection
          : {
              start: liveOffset(element, target.startContainer, target.startOffset),
              end: liveOffset(element, target.endContainer, target.endOffset),
            };
      if (type === 'insertText' || type === 'insertReplacementText' || type === 'insertFromDrop') {
        input.preventDefault();
        const text = input.data ?? input.dataTransfer?.getData('text/plain') ?? '';
        // Typing goes where the caret is; a spelling fix or a drop names its own range.
        const at = type === 'insertText' ? selection : range;
        replace(type === 'insertText' && !/\s/u.test(text) ? 'type' : type, at.start, at.end, text);
        return;
      }
      if (type === 'insertParagraph' || type === 'insertLineBreak') {
        input.preventDefault();
        replace('break', selection.start, selection.end, '\n');
        return;
      }
      if (type.startsWith('delete')) {
        input.preventDefault();
        if (type === 'deleteContentBackward' && selection.start === selection.end) {
          const unmarked = removeBlockMarker(source, selection.start);
          if (unmarked !== null) {
            edit('delete', unmarked.value, unmarked.caret);
            return;
          }
        }
        let { start, end } = range;
        if (start === end && selection.start === selection.end) {
          if (type.includes('Backward')) start = backOne(source, start);
          else end = forwardOne(source, end);
        } else if (start === end) ({ start, end } = selection);
        if (start !== end) replace('delete', start, end, '');
        return;
      }
      if (type === 'historyUndo' || type === 'historyRedo') {
        input.preventDefault();
        if (type === 'historyUndo') undo();
        else redo();
        return;
      }
      if (type.startsWith('format')) {
        input.preventDefault();
        const marker = FORMAT_MARKERS[type];
        if (marker === undefined) return;
        const wrapped = toggleWrap(source, selection.start, selection.end, marker);
        edit('format', wrapped.value, wrapped.caret);
      }
      // Anything else is left to the platform; the `input` listener reads its result back.
    };

    const onInput = (event: Event): void => {
      // The rest of a composition the host replaced the words under: painted over, never read back.
      if (interrupted.current && (event as InputEvent).isComposing === true) {
        paint(rendered.current ?? '', caret.current);
        return;
      }
      const text = readLiveDocument(element);
      if (composing.current) {
        // Mid-composition the draft follows the document, but the document is not repainted.
        rendered.current = text;
        caret.current = selectionIn(element) ?? caret.current;
        reported.current.add(text);
        latest.current.onChange({ currentTarget: handle });
        return;
      }
      if (text === rendered.current) return;
      const at = selectionIn(element) ?? caret.current;
      record('native', { value: rendered.current ?? '', ...caret.current });
      paint(text, at);
      latest.current.onChange({ currentTarget: handle });
    };

    const onCompositionStartNative = (): void => {
      composing.current = true;
      interrupted.current = false;
      reported.current.clear();
      record('compose', { value: rendered.current ?? '', ...currentSelection() });
      latest.current.onCompositionStart?.();
    };

    const onCompositionEndNative = (): void => {
      // Already ended for the host (`interrupted`): the document is put back to what the host holds.
      if (interrupted.current) {
        interrupted.current = false;
        paint(rendered.current ?? '', caret.current);
        return;
      }
      composing.current = false;
      reported.current.clear();
      const text = readLiveDocument(element);
      const at = selectionIn(element) ?? caret.current;
      const changed = text !== rendered.current;
      paint(text, at);
      if (changed) latest.current.onChange({ currentTarget: handle });
      latest.current.onCompositionEnd?.({ currentTarget: handle });
    };

    let revealedLine = -1;
    const onSelectionChange = (): void => {
      if (!focused() || composing.current) return;
      const selection = selectionIn(element);
      if (selection === null) return;
      caret.current = selection;
      if (latest.current.markers === 'hidden' && selection.start === selection.end) {
        const line = lineAt(parseLiveMarkdown(rendered.current ?? ''), selection.start);
        if (line !== revealedLine) {
          revealedLine = line;
          paint(rendered.current ?? '', selection);
        }
      }
      latest.current.onSelect?.({ currentTarget: handle });
    };

    // Leaving the editor hides the last revealed line's markers again.
    const onBlur = (): void => {
      revealedLine = -1;
      if (latest.current.markers === 'hidden') paint(rendered.current ?? '', caret.current);
    };

    element.addEventListener('beforeinput', onBeforeInput);
    element.addEventListener('input', onInput);
    element.addEventListener('compositionstart', onCompositionStartNative);
    element.addEventListener('compositionend', onCompositionEndNative);
    element.addEventListener('blur', onBlur);
    doc.addEventListener('selectionchange', onSelectionChange);
    return () => {
      element.removeEventListener('beforeinput', onBeforeInput);
      element.removeEventListener('input', onInput);
      element.removeEventListener('compositionstart', onCompositionStartNative);
      element.removeEventListener('compositionend', onCompositionEndNative);
      element.removeEventListener('blur', onBlur);
      doc.removeEventListener('selectionchange', onSelectionChange);
    };
  }, []);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    let prevented = false;
    const isComposing = composing.current || event.nativeEvent.isComposing;
    onKeyDown?.({
      key: event.key,
      code: event.code,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      nativeEvent: { isComposing },
      currentTarget: handle,
      preventDefault: () => {
        prevented = true;
        event.preventDefault();
      },
    });
    if (prevented || isComposing) return;
    const modified = event.metaKey || event.ctrlKey;
    // The host did not send on this Enter, so it is a new line — always a plain `\n` in the source.
    if (event.key === 'Enter' && !modified && !event.altKey) {
      event.preventDefault();
      const selection = currentSelection();
      replace('break', selection.start, selection.end, '\n');
      return;
    }
    const key = event.key.toLowerCase();
    if (modified && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault();
      if (key === 'y' || event.shiftKey) redo();
      else undo();
    }
  };

  const paste = (event: ClipboardEvent<HTMLDivElement>): void => {
    onPaste?.(event);
    if (event.defaultPrevented) return;
    // Pasted text arrives as text — never as somebody else's markup.
    event.preventDefault();
    const selection = currentSelection();
    replace('paste', selection.start, selection.end, event.clipboardData?.getData('text/plain') ?? '');
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a contenteditable document is the only element that can show a heading bigger than its neighbours while you edit it
    <div
      {...aria}
      aria-disabled={disabled || undefined}
      aria-label="Message"
      aria-multiline="true"
      className="fy-live-editor"
      contentEditable={!disabled}
      data-live-editor=""
      data-markers={markers}
      data-placeholder={placeholder}
      data-vim={vimMode}
      id={id}
      onKeyDown={keyDown}
      onPaste={paste}
      ref={node => {
        root.current = node;
        if (elementRef !== undefined) elementRef.current = node;
      }}
      role="textbox"
      spellCheck
      style={maxHeight === undefined ? undefined : { maxHeight }}
      suppressContentEditableWarning
      tabIndex={0}
    />
  );
}
