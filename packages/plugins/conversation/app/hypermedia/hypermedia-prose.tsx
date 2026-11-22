import type { ProseProps } from '@ferretry/app';
import { DocumentView, type InlineDef } from 'durian-hypermedia/react/strict';
import { memo, useId, useMemo, useSyncExternalStore } from 'react';
import { DrawableFyRenderBodies } from './fy-render-host.tsx';
import { LITERAL_CODE_INLINES } from './literal-code.tsx';
import { readLook, serverLook, subscribeToLook, variantOf } from './look.ts';
import { HYPERMEDIA_COMPONENT_BLOCKS, HYPERMEDIA_PART_SLOTS, HYPERMEDIA_PARTS } from './parts.tsx';
import { ReferenceChip } from './reference-chip.tsx';
import { ReferenceProofProvider } from './reference-proof.tsx';
import { useDurianReading } from './use-durian-reading.ts';
import { hypermediaUrlPolicy } from './url-policy.ts';
import { withIdPrefix } from './with-id-prefix.ts';
import { REFERENCE_INLINE } from './with-references.ts';

/**
 * AN ASSISTANT MESSAGE, READ AS DURIAN HYPERMEDIA: Markdown plus fenced parts (` ```terminal `, tabs, charts…), with
 * Ferretry's references on top. The whole message goes through ONE parse; our reference grammar then reads its prose
 * (`withReferences`), and every reference is proved at paint through the shell's reference surface (`ReferenceChip`), so
 * a token is a link only where this ferret can prove it and open it.
 *
 *  - NO FRONT MATTER, NO BANNER. A message that starts with `---` is Markdown the reader sees: a banner would look like
 *    the app's own chrome, and a leading YAML block would be eaten.
 *  - ONE ID PER MESSAGE. Heading ids carry a prefix made for this message, so two messages with the same heading never
 *    share a DOM id (and a `#anchor` link in a message reaches its own heading).
 *  - A PART DRAWN ONLY IF WE NAME IT. Only the parts in `HYPERMEDIA_PARTS` (`parts.tsx`) have a component here, each
 *    under our policy (an animation draws, a mermaid diagram goes to our sandbox renderer, `codewalk` is the plain text an
 *    LLM reads for it, and a ```chart is held as code: its formulas are unbounded work, `held-chart.tsx`), so a part we have not reviewed shows its content and runs nothing.
 *  - AUTHOR TEXT STAYS VISIBLE. A `:::llm` text is always shown, collapsed under "LLM-only text" beside the part it
 *    belongs to, and a `:::human` segment draws its body even with `llm=none` (`llm-text.tsx`, decision C7).
 *  - LINKS go through our URL policy (never an image, an app route or a reference envelope) and open through the
 *    shell's one outside link; code carries our colours and references (`slots.tsx`).
 *  - THE PARSE IS NOT ON THIS THREAD (r12 H11). Durian reads the message in a worker (`durian-reader.ts`, `durian-worker.ts`);
 *    a parse that takes longer than its budget is ended and the message is shown as the plain text it is, with a note.
 *    Until the document arrives the plain text is drawn, so a message is readable at once. Over the author's cap a message
 *    is also plain text, never Durian's "too big" error.
 *
 * Streaming: a message grows one parse at a time; `DocumentView` keys its blocks by position and every component below
 * is module-level, so what is already drawn is updated in place, never remounted. The last document stays drawn while the
 * next one is awaited.
 *
 * The theme is the app's own look, always passed (`look.ts`): the mode, because Durian's stylesheet goes dark on the system
 * setting unless told otherwise and our root says `data-mode`, not `data-theme`; and the style's shape and header, which
 * `dh-theme.css` cannot branch on. Colours, type and corners follow the palette and style by CSS alone.
 */

/** The note under a message shown as plain text because it could not be read as hypermedia. */
const PLAIN_NOTE = 'shown as plain text';

/**
 * Our inlines: the chip that draws a proved reference (Durian reads only its `Component`; it never tokenises one), and the
 * code span that keeps its literal bytes (`literal-code.tsx`, which the parser is given too).
 */
const INLINES: readonly InlineDef[] = [
  { name: REFERENCE_INLINE, match: /(?!)/u, Component: ReferenceChip },
  ...LITERAL_CODE_INLINES,
];

/**
 * What Conversation hands the shell as `shell.prose`: this, for a surface that is not the chat's (the agenda). A plain
 * function, because the shell calls it as a view; `copyable` and `demoteHeadings` are Markdown's and a part has its own
 * copy, so they are not read. Headings are the surface's to restyle (`.dh-doc h1…h6`), as the agenda card does.
 */
export function ProvidedProse({ text, className }: ProseProps) {
  return <HypermediaProse text={text} {...(className === undefined ? {} : { className })} />;
}

export interface HypermediaProseProps {
  readonly text: string;
  readonly className?: string;
  /**
   * The text is the tail of a message still streaming in (the live session's last row). A fence closed only by the
   * text's last line is then still open, so a partial body never draws (`settleFences`). Absent or false: a final message.
   */
  readonly arriving?: boolean;
}

export const HypermediaProse = memo(function HypermediaProse({
  text,
  className,
  arriving = false,
}: HypermediaProseProps) {
  const { mode, shape, header } = useSyncExternalStore(subscribeToLook, readLook, serverLook);
  // The message is read in the Durian worker, never on this thread (`durian-reader.ts`): its plain text is drawn until the
  // document arrives, and stays drawn, with a note, when the parse was too slow or failed.
  const reading = useDurianReading(text, arriving);
  // ONE ID PER MESSAGE: the document is kept by text, so its ids carry a prefix made of the text; each message on screen puts its
  // own in place (`useId` is unique per mounted message and stable across its re-renders; keep only what an id may hold).
  const idPrefix = `dh-${useId().replace(/[^\w-]/gu, '')}-`;
  const rich = useMemo(
    () =>
      reading.kind === 'rich'
        ? { drawable: reading.read.drawable, doc: withIdPrefix(reading.read.doc, reading.prefix, idPrefix) }
        : null,
    [reading, idPrefix],
  );
  return (
    <ReferenceProofProvider text={text}>
      <div className={`fy-hm min-w-0 max-w-full ${className ?? ''}`} data-fy-hypermedia="" data-hm-header={header}>
        {rich !== null ? (
          <DrawableFyRenderBodies value={rich.drawable}>
            <DocumentView
              blocks={HYPERMEDIA_COMPONENT_BLOCKS}
              components={HYPERMEDIA_PARTS}
              doc={rich.doc}
              inlines={INLINES}
              slots={HYPERMEDIA_PART_SLOTS}
              theme={mode}
              urlPolicy={hypermediaUrlPolicy}
              variant={variantOf(shape)}
            />
          </DrawableFyRenderBodies>
        ) : (
          <>
            <pre className="fy-hm-plain" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              {text}
            </pre>
            {reading.kind === 'plain' ? (
              <p className="fy-hm-plain-note" data-fy-plain-note={reading.reason} role="status">
                {PLAIN_NOTE}
              </p>
            ) : null}
          </>
        )}
      </div>
    </ReferenceProofProvider>
  );
});
