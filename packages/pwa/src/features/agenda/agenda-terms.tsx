/**
 * THE JARGON OF AN AGENDA CARD, explained where it is read. Each term the item spells out (`terms`) is drawn with a
 * dotted underline the first time a text on the card uses it — in the premise, the context and the options — and a
 * tap (or Enter, it is focusable) shows what it means right under it. The card's folding Terms list holds them all.
 *
 * The mark is made in the Markdown itself, as a link to `#fy-term-<n>`, so the text keeps its bold, code and
 * references and is drawn by the chat's one renderer; `TermLayer` takes the click before the link does, so a term
 * never navigates. Code spans and existing links are never marked.
 */

import type { AgendaTerm } from '@ferretry/protocol';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';

const TERM_HREF = '#fy-term-';
/** The tip's width, as the stylesheet draws it (`.fy-term-tip`). */
const TIP_WIDTH = 240;

/** Code spans, links and bare URLs: text a term is never marked inside. */
const PROTECTED = /(`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>|https?:\/\/\S+)/u;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const termPattern = (term: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(${escapeRegex(term.trim())}(?:e?s)?)(?![\\p{L}\\p{N}_])`, 'iu');

/**
 * `text` with the first use of each term marked as a `#fy-term-<n>` link (n: the term's place in `terms`). A term
 * already marked by an earlier text on the card (`seen`) is not marked again; `seen` is updated.
 */
export const markTerms = (text: string, terms: readonly AgendaTerm[], seen: Set<number> = new Set()): string => {
  if (terms.length === 0) return text;
  const chunks = text.split(new RegExp(PROTECTED.source, 'gu'));
  return chunks
    .map((chunk, at) => {
      if (at % 2 === 1) return chunk;
      let out = chunk;
      terms.forEach((entry, index) => {
        if (seen.has(index) || entry.term.trim() === '') return;
        const pattern = termPattern(entry.term);
        const found = pattern.exec(out);
        if (found === null) return;
        // Never inside a mark this pass already made (a term that contains another).
        const before = out.slice(0, found.index);
        if ((before.match(/\[/gu)?.length ?? 0) > (before.match(/\]/gu)?.length ?? 0)) return;
        seen.add(index);
        out = `${before}[${found[1] ?? ''}](${TERM_HREF}${String(index)})${out.slice(found.index + found[0].length)}`;
      });
      return out;
    })
    .join('');
};

interface OpenTerm {
  readonly index: number;
  readonly left: number;
  readonly top: number;
}

const termIndex = (target: EventTarget | null): { readonly index: number; readonly element: HTMLElement } | null => {
  if (!(target instanceof Element)) return null;
  const link = target.closest(`a[href^="${TERM_HREF}"]`);
  if (!(link instanceof HTMLElement)) return null;
  const index = Number(link.getAttribute('href')?.slice(TERM_HREF.length));
  return Number.isInteger(index) ? { index, element: link } : null;
};

/** The card's term layer: takes a term's tap, shows its meaning under it, and closes on Esc or a tap elsewhere. */
export function TermLayer({
  terms,
  renderProse,
  children,
}: {
  readonly terms: readonly AgendaTerm[];
  readonly renderProse: (text: string) => ReactNode;
  readonly children: ReactNode;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<OpenTerm | null>(null);

  useEffect(() => {
    if (open === null) return;
    const close = (event: Event): void => {
      if (termIndex(event.target) === null) setOpen(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const onClickCapture = (event: MouseEvent<HTMLDivElement>): void => {
    const hit = termIndex(event.target);
    if (hit === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (open?.index === hit.index) {
      setOpen(null);
      return;
    }
    const box = root.current?.getBoundingClientRect();
    const at = hit.element.getBoundingClientRect();
    // Under the term, kept inside the card: a tip near the right edge moves left rather than run off it.
    const room = (box?.width ?? TIP_WIDTH) - TIP_WIDTH;
    setOpen({
      index: hit.index,
      left: Math.min(at.left - (box?.left ?? 0), room),
      top: at.bottom - (box?.top ?? 0),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open !== null) {
      event.stopPropagation();
      setOpen(null);
    }
  };

  const term = open === null ? undefined : terms[open.index];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the terms inside are links, which take the keys themselves
    <div className="fy-terms-layer" onClickCapture={onClickCapture} onKeyDown={onKeyDown} ref={root}>
      {children}
      {open === null || term === undefined ? null : (
        <div
          className="fy-term-tip"
          data-agenda-term-tip={term.term}
          role="status"
          style={{ left: `${String(Math.max(0, open.left))}px`, top: `${String(open.top + 4)}px` }}
        >
          <strong>{term.term}</strong> {renderProse(term.meaning)}
        </div>
      )}
    </div>
  );
}
