/**
 * Syntax-highlighted code surface for tool inputs and tool results.
 *
 * The language is chosen by the CALLER from the filename extension — never
 * auto-detected, which is slow and wrong on logs. Anything the shared registry
 * declines (`highlightToHtml` answering null) falls back to escaped plain text,
 * so a tool result can never turn into markup inside the page.
 *
 * Highlighting is memoized on (code, lang) so a transcript re-render does not
 * re-tokenize every open block. Colours come from the shared `.hljs` rules in
 * `styles/highlight.css`, which route through the per-theme `--syn-*` tokens.
 */

import { memo, useMemo, useState } from 'react';
import { cn } from '../lib/class-names.ts';
import { escapeHtml, highlightToHtml } from '../lib/highlight.ts';

/** A long body opens as a preview: the reader asked to see the call, not to
 *  scroll a file. */
const PREVIEW_LINES = 16;

export interface CodeBlockProps {
  readonly code: string;
  readonly lang?: string;
  readonly tone?: 'default' | 'err';
}

export const CodeBlock = memo(function CodeBlock({ code, lang, tone = 'default' }: CodeBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = code.split('\n');
  const tooMany = lines.length > PREVIEW_LINES;
  const shown = expanded ? code : lines.slice(0, PREVIEW_LINES).join('\n');

  // An error body is never tokenized: it is not source in a known language, and
  // highlighting output as if it were reads as noise.
  const html = useMemo(
    () => (tone === 'err' ? escapeHtml(shown) : (highlightToHtml(shown, lang) ?? escapeHtml(shown))),
    [shown, lang, tone],
  );

  return (
    <div className="min-w-0 max-w-full">
      <pre
        className={cn(
          'kt-code-block hljs mono m-0 max-h-[380px] min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border px-2.5 py-2 text-[11.75px] leading-[1.5] scroll-thin',
          tone === 'err' ? 'border-err-border !bg-err-bg text-err' : 'border-border-soft',
        )}
      >
        {/* The registry's contract is what makes this safe: `highlightToHtml`
            returns highlight.js markup for a language IT registered — which
            escapes the source it tokenizes — or null, and null is rendered
            through `escapeHtml`. Caller text is never forwarded as markup on
            either path, and both are asserted in code-block.test.tsx. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted output is the registry's own escaped markup; the fallback is escapeHtml */}
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {tooMany ? (
        <button
          className="mt-0.5 px-1 text-[11px] text-accent hover:underline"
          onClick={() => setExpanded(value => !value)}
          type="button"
        >
          {expanded ? 'show less' : `show ${lines.length - PREVIEW_LINES} more lines`}
        </button>
      ) : null}
    </div>
  );
});
