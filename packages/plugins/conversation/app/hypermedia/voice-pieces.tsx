import { type ComponentType, useMemo } from 'react';
import { splitVoice } from '../../contract/voice-tag.ts';
import { VoiceLine } from './voice-line.tsx';

interface PieceProps {
  readonly text: string;
  readonly className?: string;
  readonly arriving?: boolean;
}

/**
 * A MESSAGE CUT AT ITS SPOKEN LINES. `<voice>…</voice>` (`contract/voice-tag.ts`) divides the message into stretches of prose,
 * each drawn by `Document` (the hypermedia reader), and the lines said aloud, each a `VoiceLine`. A message with no spoken line
 * is ONE `Document`, exactly as before. The pieces keep their offset in the message as their key, so a message growing in place updates what
 * is drawn rather than remounting it; only the last stretch can still be arriving.
 *
 * A line with no closing tag is a speaker line only while it arrives (drawn as it grows, never spoken); a finished message shows
 * the text it was, tag and all, so nothing the agent wrote is hidden.
 */
export function VoicePieces({
  text,
  className,
  arriving = false,
  Document,
}: PieceProps & { readonly Document: ComponentType<PieceProps> }) {
  const pieces = useMemo(() => (text.includes('<voice>') ? splitVoice(text) : null), [text]);
  const own = className === undefined ? {} : { className };
  if (pieces === null || !pieces.some(piece => piece.kind === 'voice' && (arriving || !piece.open))) {
    return <Document arriving={arriving} text={text} {...own} />;
  }
  return (
    <>
      {pieces.map((piece, index) => {
        if (piece.kind === 'voice' && (arriving || !piece.open)) {
          return <VoiceLine key={piece.start} open={piece.open} text={piece.text} />;
        }
        const words = piece.kind === 'voice' ? text.slice(piece.start, piece.end) : piece.text;
        return <Document arriving={arriving && index === pieces.length - 1} key={piece.start} text={words} {...own} />;
      })}
    </>
  );
}
