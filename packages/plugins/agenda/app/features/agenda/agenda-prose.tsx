/**
 * THE ONE RENDERER OF AN AGENDA SEGMENT: the way a ferret's text is drawn everywhere — Durian hypermedia, so a segment
 * may hold a ` ```terminal ` part and a reference — through the shell's one `ProseView` (Conversation provides it; the
 * shell's Markdown draws the segment until it loads), over the segment with its lines kept (`segmentMarkdown`), inside
 * `.fy-seg`, the one rule that gives every segment the same spacing, bullets and numbering. A heading the ferret wrote
 * inside a segment (`## Plan`) is drawn as bold body text, never an h1–h6: the card's own labels are the only headings
 * on it. This inbox has no reference surface of its own, so a reference reads as the plain text it is. A host passes
 * this as `renderProse`; a segment is never drawn any other way.
 */

import type { ReactNode } from 'react';
import { ProseView } from '../../shell.ts';
import { segmentMarkdown } from '../../lib/agenda-segment.ts';
import type { ClipboardWriter } from '../../shell.ts';

function AgendaProse({ text, copyable }: { readonly text: string; readonly copyable?: ClipboardWriter }) {
  return (
    <ProseView
      className="md fy-seg"
      demoteHeadings
      text={segmentMarkdown(text)}
      {...(copyable === undefined ? {} : { copyable })}
    />
  );
}

/** `renderProse` for the agenda's hosts: a segment's text, drawn the one way. */
export const agendaProse =
  (copyable?: ClipboardWriter) =>
  (text: string): ReactNode => <AgendaProse text={text} {...(copyable === undefined ? {} : { copyable })} />;

export const defaultAgendaProse = agendaProse();
