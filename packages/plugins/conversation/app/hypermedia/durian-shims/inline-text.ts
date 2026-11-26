import type { MdInline } from 'durian-markdown';

/**
 * DURIAN'S `inlineText`, WITHOUT THE PARSER THAT SITS NEXT TO IT (U1 of the DurianMarkdown swap, Durian 0.7.0).
 *
 * The page's renderer (`react/markdown.tsx`) imports ONE function from `src/markdown.ts`, `inlineText` (a heading's or a cell's
 * text), and that module also holds the Markdown reader, which imports every part of Durian's folders (their parsers, KaTeX, the
 * expression engine): the whole parser in the first load (+400 KB gzip measured), for a function of one line. The parser runs in the
 * worker (`durian-worker.ts`), which the page never imports. `vite-durian.ts` resolves that one import, and only that one, to this
 * module; `tests/unit/app/hypermedia/durian-shims.test.ts` holds it equal to the installed function on every kind of inline node.
 */
export const inlineText = (c: readonly MdInline[]): string =>
  c
    .map(x =>
      x.t === 'ref'
        ? x.text
        : x.t === 'reference'
          ? (x.label ?? x.name)
          : 'v' in x
            ? x.v
            : 'c' in x
              ? inlineText(x.c)
              : x.t === 'kbd'
                ? x.label
                : x.t === 'mouse'
                  ? `${x.act} ${x.target}`.trim()
                  : x.t === 'img'
                    ? x.alt
                    : '',
    )
    .join('');
