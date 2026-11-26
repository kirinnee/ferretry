import { type MarkdownAstFenceNode, useReferenceSurface } from '@ferretry/app';
import type { BlockDef, HostBlock } from 'durian-markdown';
import { type ComponentType, type ReactNode, useMemo } from 'react';
import { FY_RENDER_FENCE_ATTRIBUTE } from '../render/fy-render.ts';
import { type HeldFenceData, MERMAID_BLOCK_NAME } from './held-fence-parse.ts';
import { authorTextBeside, LlmOnlyText } from './llm-text.tsx';

/**
 * A ```mermaid FENCE, DRAWN BY OUR RENDERER, AS A HOST BLOCK NAMED `mermaid`. Durian 0.7.0 removed its mermaid part (a mermaid fence is
 * plain code there), so the name is free and the block is ours: `held-fence-parse.ts` carries the fence's source as data and
 * this draws it. It keeps a diagram written for Durian 0.6.2 drawing in an old message (decision D2: read-only, not taught, to
 * be reviewed in three months); nothing teaches it.
 *
 * It hands the source to the SAME door a ` ```fy-render ` mermaid block goes through (the surface's `fences.draw`), as the
 * block `type: mermaid` would have made: the source is data in an opaque-origin sandbox frame, and what comes back is
 * admitted as text and shown as an `<img src="data:image/svg+xml…">`, the one measured sink. So there is ONE mermaid path
 * in the app, with its size cap, its watchdog, its palette and its fallback, and nothing here parses or draws a diagram.
 * Durian 0.6.2 stepped a diagram by its `%% @step` lines; the whole diagram is drawn at once now (a step line is a comment to mermaid).
 *
 * A surface that lent no fences (a reader outside a ferret), a step the door refuses (over the 20,000 character cap) or a
 * source that is not one line of title: the step's SOURCE is shown as code, which is what Durian does with no slot.
 */

/** A header value is one line: no newline may let a title add a header or end the headers. */
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** The fence node the existing reader makes for a body (the one shape the surface's fences accept). */
function synthesizedFence(body: string): MarkdownAstFenceNode {
  return {
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { [FY_RENDER_FENCE_ATTRIBUTE]: 'true' },
        // mdast-to-hast ends a fence body with a newline the author did not type; the reader strips it again.
        children: [{ type: 'text', value: `${body}\n` }],
      },
    ],
  };
}

/** The diagram, or its source as code when the surface lent no door or the door refused it. */
function MermaidDiagram({ src, title }: { readonly src: string; readonly title: string }): ReactNode {
  const { fences, onTaskOpen } = useReferenceSurface();
  const drawn = useMemo(() => {
    const alt = oneLine(title) === '' ? 'Mermaid diagram' : oneLine(title);
    // A source line that is exactly the boundary would end the headers early: the existing reader splits on the first one,
    // and the headers here are ours, so the boundary is the one we write.
    const body = ['type: mermaid', `alt: ${alt}`, '---', src].join('\n');
    return fences?.draw({ node: synthesizedFence(body), onTaskOpen }) ?? null;
  }, [fences, onTaskOpen, src, title]);
  return (
    drawn ?? (
      <pre className="fy-hm-mermaid-source">
        <code>{src}</code>
      </pre>
    )
  );
}

/** One `mermaid` fence, drawn, and then the `:::llm` text the author wrote after it (decision C7: author text is never hidden). */
function MermaidPart({ block, data }: { readonly block: HostBlock; readonly data: HeldFenceData }): ReactNode {
  const text = authorTextBeside(block, data.generated);
  return (
    <>
      <div className="dh-mermaid" data-fy-mermaid="">
        <MermaidDiagram src={data.body} title={block.attrs.title ?? ''} />
      </div>
      {text === null ? null : <LlmOnlyText text={text} />}
    </>
  );
}

/** The renderer half of the `mermaid` host block: module-level and never rebuilt (Durian keys its settings on the array's identity). */
export const MERMAID_COMPONENT_BLOCK: BlockDef<
  HeldFenceData,
  ComponentType<{ block: HostBlock; data: HeldFenceData }>
> = { name: MERMAID_BLOCK_NAME, Component: MermaidPart };
