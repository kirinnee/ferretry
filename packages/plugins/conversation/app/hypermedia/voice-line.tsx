import { Volume2 } from 'lucide-react';

/**
 * ONE SPOKEN LINE OF A REPLY (`<voice>words</voice>`, `contract/voice-tag.ts`): drawn as a speaker line — a speaker mark, the
 * words, on an accent tint — so a reader can tell at a glance which words were SAID and which were only written. The words
 * are text, never HTML or Markdown. `open` is a line whose closing tag has not arrived: drawn as it grows, marked so, and
 * never spoken (the voice says closed lines only).
 */
export function VoiceLine({ text, open }: { readonly text: string; readonly open: boolean }) {
  return (
    <p className="fy-voice-line" data-fy-voice-line={open ? 'open' : 'closed'}>
      <Volume2 aria-hidden="true" className="fy-voice-line__mark" size={16} />
      <span className="sr-only">Spoken: </span>
      <span className="fy-voice-line__words">{text}</span>
    </p>
  );
}
