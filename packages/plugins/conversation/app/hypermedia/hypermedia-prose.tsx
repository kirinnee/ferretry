import type { ProseProps } from '@ferretry/app';
import { DocumentView, type InlineDef } from 'durian-hypermedia/react/strict';
import { memo, useId, useMemo, useSyncExternalStore } from 'react';
import { exceedsMessageCap } from './limits.ts';
import { HumanSegment, TerminalWithLlmText } from './llm-text.tsx';
import { LITERAL_CODE_INLINES } from './literal-code.tsx';
import { parseMessage } from './parse-message.ts';
import { ReferenceChip } from './reference-chip.tsx';
import { ReferenceProofProvider } from './reference-proof.tsx';
import { HYPERMEDIA_SLOTS } from './slots.tsx';
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
 *  - A PART DRAWN ONLY IF WE NAME IT. Only the parts in {@link PARTS} have a component here; any other part is drawn as
 *    the plain text an LLM reads for it, so a part we have not reviewed shows its content and runs nothing.
 *  - AUTHOR TEXT STAYS VISIBLE. A `:::llm` text is always shown, collapsed under "LLM-only text" beside the part it
 *    belongs to, and a `:::human` segment draws its body even with `llm=none` (`llm-text.tsx`, decision C7).
 *  - LINKS go through our URL policy (never an image, an app route or a reference envelope) and open through the
 *    shell's one outside link; code carries our colours and references (`slots.tsx`).
 *  - OVER THE CAP a message is shown as the text it is, never as Durian's error ({@link exceedsMessageCap}).
 *
 * Streaming: a message grows one parse at a time; `DocumentView` keys its blocks by position and every component below
 * is module-level, so what is already drawn is updated in place, never remounted.
 *
 * The theme is the app's own mode, always passed: Durian's stylesheet goes dark on the system setting unless told
 * otherwise, and our root says `data-mode`, not `data-theme`.
 */

/**
 * The parts this build draws. Wider sets come with their own review (r12 H4); an absent part is shown as LLM text, which
 * includes an author's `:::llm` text, so none is lost.
 */
const PARTS = { terminal: TerminalWithLlmText, human: HumanSegment } as const;

/**
 * Our inlines: the chip that draws a proved reference (Durian reads only its `Component`; it never tokenises one), and the
 * code span that keeps its literal bytes (`literal-code.tsx`, which the parser is given too).
 */
const INLINES: readonly InlineDef[] = [
  { name: REFERENCE_INLINE, match: /(?!)/u, Component: ReferenceChip },
  ...LITERAL_CODE_INLINES,
];

const subscribeToMode = (notify: () => void): (() => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  return () => observer.disconnect();
};
const readMode = (): 'light' | 'dark' => (document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light');
const SERVER_MODE = (): 'light' | 'dark' => 'light';

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
}

export const HypermediaProse = memo(function HypermediaProse({ text, className }: HypermediaProseProps) {
  const mode = useSyncExternalStore(subscribeToMode, readMode, SERVER_MODE);
  // `useId` is unique per mounted message and stable across its re-renders; keep only what an id may hold.
  const idPrefix = `dh-${useId().replace(/[^\w-]/gu, '')}-`;
  const doc = useMemo(() => (exceedsMessageCap(text) ? null : parseMessage(text, idPrefix)), [text, idPrefix]);
  return (
    <ReferenceProofProvider text={text}>
      <div className={`fy-hm min-w-0 max-w-full ${className ?? ''}`} data-fy-hypermedia="">
        {doc === null ? (
          <pre className="fy-hm-plain" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {text}
          </pre>
        ) : (
          <DocumentView
            components={PARTS}
            doc={doc}
            inlines={INLINES}
            slots={HYPERMEDIA_SLOTS}
            theme={mode}
            urlPolicy={hypermediaUrlPolicy}
          />
        )}
      </div>
    </ReferenceProofProvider>
  );
});
