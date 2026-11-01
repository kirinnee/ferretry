/**
 * THE ONE RENDERER OF AN AGENDA SEGMENT: the chat's Markdown (`ChatProse`, so references, `code` and fy-render blocks
 * behave exactly as in a message) over the segment with its lines kept (`segmentMarkdown`), inside `.fy-seg`, the one
 * rule that gives every segment the same spacing, bullets and numbering. A host passes this as `renderProse`; a
 * segment is never drawn any other way.
 */

import type { ReactNode } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { segmentMarkdown } from '../../lib/agenda-segment.ts';
import type { ClipboardWriter } from '../onboarding/copy-button.tsx';

function AgendaProse({ text, copyable }: { readonly text: string; readonly copyable?: ClipboardWriter }) {
  return (
    <ChatProse className="fy-seg" text={segmentMarkdown(text)} {...(copyable === undefined ? {} : { copyable })} />
  );
}

/** `renderProse` for the agenda's hosts: a segment's text, drawn the one way. */
export const agendaProse =
  (copyable?: ClipboardWriter) =>
  (text: string): ReactNode => <AgendaProse text={text} {...(copyable === undefined ? {} : { copyable })} />;

export const defaultAgendaProse = agendaProse();
