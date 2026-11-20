/**
 * A SENTENCE WHOSE `quoted` STRETCHES ARE CODE. Words written once, in a string a test can pin, keep their backticks in the
 * string; what a person SEES is the stretch drawn as code, never the backticks themselves. A lone backtick (an odd count)
 * is left as written so no text is ever lost.
 */
import type { ReactNode } from 'react';

/** The pieces of `text`: plain text and, between each pair of backticks, a `<code>` element. */
export function InlineCode({ text }: { readonly text: string }): ReactNode {
  const parts = text.split('`');
  if (parts.length % 2 === 0) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positional
      <code key={index} className="font-mono text-fg">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
