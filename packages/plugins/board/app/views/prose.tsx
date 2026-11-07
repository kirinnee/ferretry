/**
 * A card's text as the card detail draws it: paragraphs, bullet and numbered lists, `code`, **bold**, links, and a
 * `&F12` card reference as a link to that card. This is the small renderer the Board needs of its own; the chat's full
 * Markdown (fy-render blocks, every reference kind) belongs to Conversation and the shell.
 */

import type { ReactNode } from 'react';
import { boardCardPath } from '../lib/paths.ts';

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|(?<![\w&])&[BFIC][1-9][0-9]{0,8}(?!\w))/gu;
const BULLET = /^\s*(?:[-*•])\s+(.*)$/u;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u;

/** A function that draws a text: what a section takes so a host can draw it another way. */
export type ProseRenderer = (text: string) => ReactNode;

const inline = (text: string): ReactNode[] =>
  text.split(INLINE).map((part, index) => {
    if (part === '') return null;
    // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one line keep their order
    const key = index;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(part);
    if (link?.[1] !== undefined && link[2] !== undefined && /^(https?:\/\/|#|\/)/u.test(link[2]))
      return (
        <a href={link[2]} key={key} rel="noreferrer" target={link[2].startsWith('http') ? '_blank' : undefined}>
          {link[1]}
        </a>
      );
    if (/^&[BFIC][1-9][0-9]{0,8}$/u.test(part))
      return (
        <a data-card-reference={part.slice(1).toUpperCase()} href={boardCardPath(undefined, part.slice(1).toUpperCase())} key={key}>
          {part}
        </a>
      );
    return part;
  });

/** The text, drawn: blank lines separate paragraphs; a run of bullet or numbered lines is a list. */
export const cardProse: ProseRenderer = text => {
  const blocks: ReactNode[] = [];
  let list: { readonly ordered: boolean; readonly items: string[] } | null = null;
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0)
      blocks.push(<p key={`p${String(blocks.length)}`}>{inline(paragraph.join(' '))}</p>);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list === null) return;
    const items = list.items.map((item, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: list items keep their order
      <li key={index}>{inline(item)}</li>
    ));
    blocks.push(list.ordered ? <ol key={`l${String(blocks.length)}`}>{items}</ol> : <ul key={`l${String(blocks.length)}`}>{items}</ul>);
    list = null;
  };
  for (const line of text.split(/\r?\n/u)) {
    const bullet = BULLET.exec(line)?.[1];
    const numbered = NUMBERED.exec(line)?.[1];
    const item = bullet ?? numbered;
    if (item !== undefined) {
      flushParagraph();
      const ordered = bullet === undefined;
      if (list !== null && list.ordered !== ordered) flushList();
      list = list ?? { ordered, items: [] };
      list.items.push(item);
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return <div className="md fy-seg">{blocks}</div>;
};

/** Text in point form: a bullet list when it is written as bullets, a paragraph otherwise. */
export function PointForm({ text, className = '', renderProse = cardProse }: { readonly text: string; readonly className?: string; readonly renderProse?: ProseRenderer }) {
  return <div className={`${className} min-w-0 break-words`.trim()}>{renderProse(text)}</div>;
}
