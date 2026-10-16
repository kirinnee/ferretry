/**
 * THE RICH TEXT EDITOR STYLE — headings at their real size, lists, quotes and marks rendered as you
 * write, and the draft still held and sent as markdown.
 *
 * It is a `contenteditable` document rather than the composer's textarea, because a textarea cannot
 * show one line bigger than another. The document is built from `lib/rich-text.ts`'s block
 * description with `createElement` and text nodes — never from a string of markup — and read back
 * into markdown on every input, so the composer's draft, its persistence and what is sent are the
 * same markdown string every other editor style produces.
 *
 * WHAT IT DOES NOT HAVE, said rather than faked: the reference autocomplete and Vim keys belong to
 * the textarea editors (Markdown and Plain). Typing a reference here still sends it; it is proved and
 * linked in the transcript as usual.
 */

import { type ClipboardEvent, type KeyboardEvent, useLayoutEffect, useRef } from 'react';
import { blockShortcut, inlineSegments, type RichBlock, richBlocks, richNodeToMarkdown } from '../lib/rich-text.ts';

/** Builds one line's inline content into `parent`. */
const appendInline = (parent: HTMLElement, text: string): void => {
  const doc = parent.ownerDocument;
  for (const segment of inlineSegments(text)) {
    if (segment.mark === undefined) {
      parent.appendChild(doc.createTextNode(segment.text));
      continue;
    }
    const mark = doc.createElement(segment.mark);
    mark.textContent = segment.text;
    parent.appendChild(mark);
  }
  if (parent.childNodes.length === 0) parent.appendChild(doc.createElement('br'));
};

/** Replaces the editor's document with the rendering of `markdown`. */
export const renderRichDocument = (root: HTMLElement, markdown: string): void => {
  const doc = root.ownerDocument;
  root.replaceChildren();
  let list: HTMLElement | null = null;
  let listKind: string | null = null;
  const blocks: readonly RichBlock[] = richBlocks(markdown);
  for (const block of blocks) {
    if (block.kind === 'li') {
      if (list === null || listKind !== block.list) {
        list = doc.createElement(block.list === 'ol' ? 'ol' : 'ul');
        if (block.list === 'check') list.setAttribute('data-checklist', '');
        listKind = block.list;
        root.appendChild(list);
      }
      const item = doc.createElement('li');
      if (block.list === 'check') item.setAttribute('data-checked', block.done ? 'true' : 'false');
      appendInline(item, block.text);
      list.appendChild(item);
      continue;
    }
    list = null;
    listKind = null;
    if (block.kind === 'hr') {
      root.appendChild(doc.createElement('hr'));
      continue;
    }
    if (block.kind === 'code') {
      const pre = doc.createElement('pre');
      pre.textContent = block.lines.join('\n');
      root.appendChild(pre);
      continue;
    }
    const element = doc.createElement(
      block.kind === 'h' ? `h${block.level}` : block.kind === 'quote' ? 'blockquote' : 'p',
    );
    appendInline(element, block.text);
    root.appendChild(element);
  }
};

/** Notion's input rule: a paragraph that now begins with `# `, `- `, `1. ` or `> ` becomes that block. */
export const applyBlockShortcut = (root: HTMLElement): boolean => {
  for (const child of Array.from(root.children)) {
    if (child.tagName !== 'P' && child.tagName !== 'DIV') continue;
    const shortcut = blockShortcut(child.textContent ?? '');
    if (shortcut === null) continue;
    const doc = root.ownerDocument;
    const inner = doc.createElement(shortcut.tag === 'ul' || shortcut.tag === 'ol' ? 'li' : shortcut.tag);
    inner.textContent = shortcut.rest;
    if (shortcut.rest === '') inner.appendChild(doc.createElement('br'));
    let replacement: HTMLElement = inner;
    if (shortcut.tag === 'ul' || shortcut.tag === 'ol') {
      replacement = doc.createElement(shortcut.tag);
      replacement.appendChild(inner);
    }
    child.replaceWith(replacement);
    // The caret goes to the end of the new block, where the reader was typing.
    const selection = doc.defaultView?.getSelection();
    if (selection) {
      const range = doc.createRange();
      range.selectNodeContents(inner);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }
  return false;
};

/** `document.execCommand` where the browser still has it; a no-op where it does not. */
const exec = (doc: Document, command: string, value?: string): void => {
  const run = (doc as { execCommand?: (command: string, ui: boolean, value?: string) => boolean }).execCommand;
  if (typeof run === 'function') run.call(doc, command, false, value);
};

export interface RichTextEditorProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (markdown: string) => void;
  /** The composer's own Enter policy: answers true when this key press should send the message. */
  readonly sendsOnEnter: (event: {
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
  }) => boolean;
  /** `true` only for ⌘/Ctrl+⇧+↵, the explicit "send now" that interrupts the running turn. */
  readonly onSubmit: (interrupt: boolean) => void;
  readonly onPasteFiles: (files: readonly File[]) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly describedBy?: string;
}

export function RichTextEditor({
  id,
  value,
  onChange,
  sendsOnEnter,
  onSubmit,
  onPasteFiles,
  disabled = false,
  placeholder,
  describedBy,
}: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  /** The markdown this editor last produced, so its own echo never re-renders under the caret. */
  const emitted = useRef<string | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null || value === emitted.current) return;
    renderRichDocument(root, value);
    emitted.current = value;
  }, [value]);

  const publish = (): void => {
    const root = ref.current;
    if (root === null) return;
    applyBlockShortcut(root);
    const markdown = richNodeToMarkdown(root);
    emitted.current = markdown;
    onChange(markdown);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const doc = event.currentTarget.ownerDocument;
    const modified = event.metaKey || event.ctrlKey;
    if (modified && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'b' || key === 'i') {
        event.preventDefault();
        exec(doc, key === 'b' ? 'bold' : 'italic');
        publish();
        return;
      }
    }
    if (event.key !== 'Enter') return;
    // Inside a list or a code block Enter belongs to the document: a new item, a new code line.
    const at = doc.getSelection()?.anchorNode ?? null;
    const element = at === null ? null : at.nodeType === 1 ? (at as Element) : at.parentElement;
    if (!modified && element?.closest('li, pre') && !event.shiftKey) return;
    if (!sendsOnEnter(event)) return;
    event.preventDefault();
    onSubmit(modified && event.shiftKey);
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const files = Array.from(event.clipboardData?.files ?? []);
    event.preventDefault();
    if (files.length > 0) {
      onPasteFiles(files);
      return;
    }
    // Pasted text arrives as text — never as somebody else's markup.
    exec(event.currentTarget.ownerDocument, 'insertText', event.clipboardData?.getData('text/plain') ?? '');
    publish();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a contenteditable document is the only element that can show a heading bigger than its neighbours while you edit it
    <div
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      aria-label="Message"
      aria-multiline="true"
      className="fy-rich-editor"
      contentEditable={!disabled}
      data-placeholder={placeholder}
      data-rich-editor=""
      id={id}
      onInput={publish}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      ref={ref}
      role="textbox"
      suppressContentEditableWarning
      tabIndex={0}
    />
  );
}
