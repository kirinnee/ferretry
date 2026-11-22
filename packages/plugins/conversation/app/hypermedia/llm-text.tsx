import type { HumanBlock, TerminalBlock } from 'durian-hypermedia';
import { Blocks, TerminalPart } from 'durian-hypermedia/react/strict';
import type { ReactElement } from 'react';

/**
 * AUTHOR TEXT IS NEVER HIDDEN (decision C7). A `:::llm` block is the text an author wrote for an LLM to read in place of a
 * part, and the previous reader showed it. Durian shows it only when a document asks for its "peek" (and then under every
 * part, with its own wording), so we draw it ourselves: ALWAYS, as one collapsed disclosure named "LLM-only text", under
 * the part it belongs to, from the first rollout. A part Durian draws for us stays drawn; the text is added beside it.
 *
 * A part's `llm` is also what Durian generates for it ("as-is", "data"…); only `llmKind: 'text'` is the author's own.
 */

const attachedText = (block: { readonly llm: string | null; readonly llmKind: string }): string | null =>
  block.llmKind === 'text' && block.llm !== null && block.llm !== '' ? block.llm : null;

function LlmOnlyText({ text }: { readonly text: string }): ReactElement {
  return (
    <details className="llm-peek" data-fy-llm-only="">
      <summary>LLM-only text</summary>
      <pre className="pane-llm">{text}</pre>
    </details>
  );
}

/** A terminal, and the `:::llm` text written for it. */
export function TerminalWithLlmText({ block }: { readonly block: TerminalBlock }): ReactElement {
  const text = attachedText(block);
  return (
    <>
      <TerminalPart block={block} />
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
