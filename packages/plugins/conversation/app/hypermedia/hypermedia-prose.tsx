import type { ProseProps } from '@ferretry/app';
import { DocumentView, type HeadingSlotProps, type InlineDef, type Slots } from 'durian-hypermedia/react/strict';
import { memo, useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { animationEngineReady, loadAnimationEngine, onAnimationEngine } from './animation-engine.ts';
import { holdsAnimation } from './held-fences.tsx';
import { DrawableFyRenderBodies } from './fy-render-host.tsx';
import { exceedsMessageCap } from './limits.ts';
import { LITERAL_CODE_INLINES } from './literal-code.tsx';
import { readLook, serverLook, subscribeToLook, variantOf } from './look.ts';
import { readMessage } from './parse-message.ts';
import { HYPERMEDIA_COMPONENT_BLOCKS, HYPERMEDIA_PART_SLOTS, HYPERMEDIA_PARTS } from './parts.tsx';
import { ReferenceChip } from './reference-chip.tsx';
import { ReferenceProofProvider } from './reference-proof.tsx';
import { hypermediaUrlPolicy } from './url-policy.ts';
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
 *  - OVER THE CAP a message is shown as the text it is, never as Durian's error ({@link exceedsMessageCap}).
 *
 * Streaming: a message grows one parse at a time; `DocumentView` keys its blocks by position and every component below
 * is module-level, so what is already drawn is updated in place, never remounted.
 *
 * The theme is the app's own look, always passed (`look.ts`): the mode, because Durian's stylesheet goes dark on the system
 * setting unless told otherwise and our root says `data-mode`, not `data-theme`; and the style's shape and header, which
 * `dh-theme.css` cannot branch on. Colours, type and corners follow the palette and style by CSS alone.
 */

/**
 * Our inlines: the chip that draws a proved reference (Durian reads only its `Component`; it never tokenises one), and the
 * code span that keeps its literal bytes (`literal-code.tsx`, which the parser is given too).
 */
const INLINES: readonly InlineDef[] = [
  { name: REFERENCE_INLINE, match: /(?!)/u, Component: ReferenceChip },
  ...LITERAL_CODE_INLINES,
];

/**
 * A heading a surface does not want AS a heading (`demoteHeadings`): the agenda draws a ferret's `## Plan` inside a card
 * whose own title is the heading, so an `h2` there would sit above it in the outline however it was styled down (R3). It is
 * what the shell's Markdown makes of it too: a paragraph holding one bold line (`p[data-demoted-heading] > strong`), which the
 * surface sets at its own size. It keeps the heading's id, so a `[link](#plan)` in the same message still jumps to it.
 */
function DemotedHeading({ id, children }: HeadingSlotProps) {
  return (
    <p data-demoted-heading="" id={id}>
      <strong>{children}</strong>
    </p>
  );
}

/** The message's slots when its headings are demoted. Module-level, like every slot object (Durian keys its settings on the identity). */
const DEMOTED_HEADING_SLOTS: Slots = { ...HYPERMEDIA_PART_SLOTS, Heading: DemotedHeading };

/**
 * What Conversation hands the shell as `shell.prose`: this, for a surface that is not the chat's (the agenda). A plain
 * function, because the shell calls it as a view; `copyable` is Markdown's and a part has its own copy, so it is not read.
 * `demoteHeadings` is read: the surface's headings are its own (see {@link DemotedHeading}); without it a heading is a
 * heading, for the surface to restyle (`.dh-doc h1…h6`).
 */
export function ProvidedProse({ text, className, demoteHeadings }: ProseProps) {
  return (
    <HypermediaProse
      text={text}
      {...(className === undefined ? {} : { className })}
      {...(demoteHeadings === true ? { demoteHeadings: true } : {})}
    />
  );
}

export interface HypermediaProseProps {
  readonly text: string;
  readonly className?: string;
  /**
   * The text is the tail of a message still streaming in (the live session's last row). A fence closed only by the
   * text's last line is then still open, so a partial body never draws (`settleFences`). Absent or false: a final message.
   */
  readonly arriving?: boolean;
  /** Draw every heading as a bold line, not a heading element ({@link DemotedHeading}). Absent or false: headings are headings. */
  readonly demoteHeadings?: boolean;
}

export const HypermediaProse = memo(function HypermediaProse({
  text,
  className,
  arriving = false,
  demoteHeadings = false,
}: HypermediaProseProps) {
  const { mode, shape, header } = useSyncExternalStore(subscribeToLook, readLook, serverLook);
  // `useId` is unique per mounted message and stable across its re-renders; keep only what an id may hold.
  const idPrefix = `dh-${useId().replace(/[^\w-]/gu, '')}-`;
  // The 2D animation engine is a lazy chunk: asked for only by a message that holds an animation, and the message is read again
  // (animation drawn, not shown as code) when it arrives.
  const engine = useSyncExternalStore(onAnimationEngine, animationEngineReady, () => false);
  const wantsEngine = !engine && holdsAnimation(text);
  useEffect(() => {
    if (wantsEngine) loadAnimationEngine().catch(() => undefined);
  }, [wantsEngine]);
  const read = useMemo(
    () => (exceedsMessageCap(text) ? null : readMessage(text, idPrefix, arriving, engine)),
    [text, idPrefix, arriving, engine],
  );
  return (
    <ReferenceProofProvider text={text}>
      <div className={`fy-hm min-w-0 max-w-full ${className ?? ''}`} data-fy-hypermedia="" data-hm-header={header}>
        {read === null ? (
          <pre className="fy-hm-plain" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {text}
          </pre>
        ) : (
          <DrawableFyRenderBodies value={read.drawable}>
            <DocumentView
              blocks={HYPERMEDIA_COMPONENT_BLOCKS}
              components={HYPERMEDIA_PARTS}
              doc={read.doc}
              inlines={INLINES}
              slots={demoteHeadings ? DEMOTED_HEADING_SLOTS : HYPERMEDIA_PART_SLOTS}
              theme={mode}
              urlPolicy={hypermediaUrlPolicy}
              variant={variantOf(shape)}
            />
          </DrawableFyRenderBodies>
        )}
      </div>
    </ReferenceProofProvider>
  );
});
