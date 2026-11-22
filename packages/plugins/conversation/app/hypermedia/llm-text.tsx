import type { Block, HumanBlock } from 'durian-hypermedia';
import { Blocks } from 'durian-hypermedia/react/strict';
import type { ComponentType, ReactElement } from 'react';

/**
 * AUTHOR TEXT IS NEVER HIDDEN (decision C7). A `:::llm` block is the text an author wrote for an LLM to read in place of a
 * part, and the previous reader showed it. Durian shows it only when a document asks for its "peek" (and then under every
 * part, with its own wording), so we draw it ourselves: ALWAYS, as one collapsed disclosure named "LLM-only text", under
 * the part it belongs to, from the first rollout. A part Durian draws for us stays drawn; the text is added beside it.
 *
 * A part's `llm` is also what Durian generates for it ("as-is", "data"…); only `llmKind: 'text'` is the author's own.
 */

/** A block that can carry an author's `:::llm` text: every part has `llm` and `llmKind`. */
type WithLlm = Block & { readonly llm: string | null; readonly llmKind: string };

/** The author's own `:::llm` text for a block, or `null` (Durian's generated text is never the author's). */
const attachedText = (block: { readonly llm?: string | null; readonly llmKind?: string }): string | null =>
  block.llmKind === 'text' && block.llm !== null && block.llm !== undefined && block.llm !== '' ? block.llm : null;

export function LlmOnlyText({ text }: { readonly text: string }): ReactElement {
  return (
    <details className="llm-peek" data-fy-llm-only="">
      <summary>LLM-only text</summary>
      <pre className="pane-llm">{text}</pre>
    </details>
  );
}

/**
 * A part, and the `:::llm` text written for it, in the same wrapper for EVERY part: one place decides that author text is
 * shown, so a part added later cannot forget it. Call once per part at module level (the result is a stable component, so
 * a re-render of a message never remounts what the part drew).
 */
export function withLlmText<B extends WithLlm>(Part: ComponentType<{ block: B }>): ComponentType<{ block: B }> {
  function PartWithLlmText({ block }: { readonly block: B }): ReactElement {
    const text = attachedText(block);
    return (
      <>
        <Part block={block} />
        {text === null ? null : <LlmOnlyText text={text} />}
      </>
    );
  }
  PartWithLlmText.displayName = `withLlmText(${Part.displayName ?? Part.name})`;
  return PartWithLlmText;
}

/**
 * A part this build does not draw (`codewalk`: it writes its notes as HTML, which the page's Trusted Types policy would
 * refuse). It is shown as the text an LLM reads for it, as Durian's own fallback does, EXCEPT that an author's `:::llm`
 * text is not poured in as if it were the part: it is the disclosure beside it, like every other part's.
 */
export function UndrawnPart({ block }: { readonly block: WithLlm }): ReactElement {
  const text = attachedText(block);
  const generated = text === null ? block.llm : null;
  return (
    <>
      {generated === null || generated === '' ? null : (
        <pre className="dh-fallback" data-dh-missing={block.type}>
          <code>{generated}</code>
        </pre>
      )}
      {text === null ? null : <LlmOnlyText text={text} />}
    </>
  );
}

/**
 * A `:::human` segment: its body is drawn whatever the LLM is given. `llm=none` means "an LLM needs nothing here", never
 * "a person sees nothing", and Durian's own fallback for a part we do not name would have drawn that empty.
 */
export function HumanSegment({ block }: { readonly block: HumanBlock }): ReactElement {
  const text = attachedText(block);
  return (
    <section className="human" id={block.id ?? undefined}>
      <Blocks blocks={block.body} />
      {text === null ? null : <LlmOnlyText text={text} />}
    </section>
  );
}
