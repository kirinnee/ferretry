/**
 * Lossless markdown colouring for the native composer textarea.
 *
 * Ported from kteam's `src/components/ComposerHighlight.tsx`. The textarea
 * remains the only input. This component paints the same text in an
 * aria-hidden, pointer-inert layer behind it; it never focuses the input, reads
 * or writes its selection, or participates in layout. Markdown markers stay
 * visible because this is syntax highlighting, not WYSIWYG rendering.
 *
 * The metric contract the two layers share lives in `session-screens.css`
 * (`.fy-composer-input-layer`): a colour span may change paint only, so
 * typography stays inherited and bold/italic syntax cannot change glyph widths
 * and walk the painted text away from the native caret.
 */

import type { RefObject } from 'react';
import { useMemo } from 'react';
import { type MdToken, type MdTokenType, tokenizeMarkdown } from '../lib/composer-markdown.ts';
import { findReferences } from '../lib/references.ts';

const REFERENCE_ELIGIBLE = new Set<MdTokenType>(['text', 'bold', 'italic', 'boldItalic', 'heading']);

/**
 * Split eligible Markdown paint tokens with the same parser the rest of the
 * product reads references with. The concatenated bytes stay identical, which
 * is what preserves the caret metrics.
 */
export function highlightReferenceTokens(tokens: readonly MdToken[]): MdToken[] {
  return tokens.flatMap(token => {
    if (!REFERENCE_ELIGIBLE.has(token.type)) return [token];
    const matches = findReferences(token.text);
    if (matches.length === 0) return [token];
    const output: MdToken[] = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) output.push({ type: token.type, text: token.text.slice(cursor, match.start) });
      output.push({ type: 'reference', text: match.raw });
      cursor = match.end;
    }
    if (cursor < token.text.length) output.push({ type: token.type, text: token.text.slice(cursor) });
    return output;
  });
}

type ScrollPort = Pick<HTMLElement, 'scrollTop' | 'scrollLeft'> & {
  style: Pick<CSSStyleDeclaration, 'overflowX' | 'overflowY'>;
};

/**
 * Mirror BOTH axes and the textarea's vertical-overflow mode. Matching the
 * latter matters on browsers with non-overlay scrollbars: otherwise the input
 * wraps against a narrower content box than the highlight layer once capped.
 */
export function syncComposerHighlightViewport(input: ScrollPort, overlay: ScrollPort | null): void {
  if (!overlay) return;
  overlay.style.overflowX = input.style.overflowX || 'auto';
  overlay.style.overflowY = input.style.overflowY || 'hidden';
  overlay.scrollTop = input.scrollTop;
  overlay.scrollLeft = input.scrollLeft;
}

export interface ComposerHighlightProps {
  readonly text: string;
  readonly overlayRef: RefObject<HTMLDivElement | null>;
  readonly enabled?: boolean;
}

export function ComposerHighlight({ text, overlayRef, enabled = true }: ComposerHighlightProps) {
  // The element is ALWAYS mounted so enabling the setting cannot shift the
  // sibling textarea's reconciliation slot and remount the real input.
  const paintedText = enabled ? text : '';
  const tokens = useMemo(() => highlightReferenceTokens(tokenizeMarkdown(paintedText)), [paintedText]);
  let offset = 0;

  return (
    <div aria-hidden="true" className="fy-composer-highlight" hidden={!enabled} ref={overlayRef}>
      {tokens.map(token => {
        const start = offset;
        offset += token.text.length;
        return (
          <span data-md-token={token.type} key={`${start}:${token.type}`}>
            {token.text}
          </span>
        );
      })}
      {/* A textarea gives a trailing newline its own caret row. A pre-wrap block
          needs a zero-width occupant to expose that same row; it paints nothing
          and exists only in this aria-hidden mirror. */}
      {paintedText.endsWith('\n') && <span data-composer-trailing-line="">{'\u200b'}</span>}
    </div>
  );
}
