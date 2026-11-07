/**
 * THE ONE RENDERER OF AN AGENDA SEGMENT: the chat's Markdown (`ChatProse`, so references, `code` and fy-render blocks
 * behave exactly as in a message) over the segment with its lines kept (`segmentMarkdown`), inside `.fy-seg`, the one
 * rule that gives every segment the same spacing, bullets and numbering. A heading the ferret wrote inside a segment
 * (`## Plan`) is drawn as bold body text, never an h1–h6: the card's own labels are the only headings on it. A host passes this as `renderProse`; a
 * segment is never drawn any other way.
 */

import type { ReactNode } from 'react';
import { ChatProse } from '../../shell.ts';
import { segmentMarkdown } from '../../lib/agenda-segment.ts';
import type { ClipboardWriter } from '../../shell.ts';

function AgendaProse({ text, copyable }: { readonly text: string; readonly copyable?: ClipboardWriter }) {
  return (
    <ChatProse
      className="fy-seg"
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
