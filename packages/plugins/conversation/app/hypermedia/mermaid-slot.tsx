import { type MarkdownAstFenceNode, useReferenceSurface } from '@ferretry/app';
import type { MermaidSlotProps } from 'durian-hypermedia/react/strict';
import { type ReactNode, useMemo, useState } from 'react';
import { FY_RENDER_FENCE_ATTRIBUTE } from '../render/fy-render.ts';

/**
 * A ```mermaid PART, DRAWN BY OUR RENDERER. Durian's own mermaid part would run a 3.4 MB library on author text inside the
 * app's origin and write its result through an HTML sink, which the page's Trusted Types policy exists to refuse. Its
 * `strict` entry draws nothing itself: each diagram step goes to the host's `Mermaid` slot, and this is that slot.
 *
 * It hands the step to the SAME door a ` ```fy-render ` mermaid block goes through (the surface's `fences.draw`), as the
 * block `type: mermaid` would have made: the source is data in an opaque-origin sandbox frame, and what comes back is
 * admitted as text and shown as an `<img src="data:image/svg+xml…">`, the one measured sink. So there is ONE mermaid path
 * in the app, with its size cap, its watchdog, its palette and its fallback, and nothing here parses or draws a diagram.
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

export function HypermediaMermaid({ src, title, active }: MermaidSlotProps): ReactNode {
  const { fences, onTaskOpen } = useReferenceSurface();
  // Durian mounts EVERY step of a stepped diagram at once (so the stage keeps the tallest step's height). A step is a
  // sandbox frame and a library fetch, so one is started when its step is first shown, and kept after (no redraw on return).
  const [shown, setShown] = useState(active);
  if (active && !shown) setShown(true);
  const drawn = useMemo(() => {
    if (!shown) return null;
    const alt = oneLine(title) === '' ? 'Mermaid diagram' : oneLine(title);
    // A source line that is exactly the boundary would end the headers early: the existing reader splits on the first one,
    // and the headers here are ours, so the boundary is the one we write.
    const body = ['type: mermaid', `alt: ${alt}`, '---', src].join('\n');
    return fences?.draw({ node: synthesizedFence(body), onTaskOpen }) ?? null;
  }, [fences, onTaskOpen, shown, src, title]);
  if (!shown) return <span className="fy-hm-mermaid-later" />;
  return (
    drawn ?? (
      <pre className="fy-hm-mermaid-source">
        <code>{src}</code>
      </pre>
    )
  );
}
