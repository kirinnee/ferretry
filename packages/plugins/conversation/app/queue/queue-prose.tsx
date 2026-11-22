import { Markdown, useReferenceSurface } from '@ferretry/app';
import { Fragment, useMemo } from 'react';
import { commonMarkFences, linesOf, normalizeText } from '../hypermedia/fence-boundaries.ts';
import { synthesizedFence } from '../hypermedia/fy-render-host.tsx';
import { isClosedFyRender } from '../hypermedia/fy-render-parse.ts';

/**
 * A QUEUED MESSAGE'S WORDS (r12 H7 fix 2). A queued message is drawn the way it was before H7: the shell's `Markdown`
 * over the surface this screen sits in, so a location block is its chip and every plain fence (`terminal` included) is
 * the ordinary `<pre><code>`, on BOTH screens that draw a queue. The ONE thing added to that is the live `fy-render`
 * block, and only where the surface lends a fence door (`ReferenceSurface.fences`, which the per-ferret panel inherits
 * from the chat and the standalone All-queues screen does not have): each closed, exactly-`fy-render` fence at the top
 * level of the message is handed to the door, and a fence the door declines stays the code Markdown draws.
 *
 * NOT `HypermediaProse` on purpose: the full reader also draws Durian's parts (a `terminal` fence, tabs, a chart held as
 * code) and has no location chip, so mounting it here changed what a queued message looks like on both screens. This
 * reads the fences by CommonMark's own boundaries (`fence-boundaries.ts`), the same decision the reader draws by.
 * Only a fence opened at column zero is drawn: one indented, or nested in a list item or a quote, stays code here (it
 * draws in the transcript).
 */

/** A run of the message Markdown draws, or one fence the door may draw. */
type Segment =
  | { readonly kind: 'markdown'; readonly line: number; readonly text: string }
  | { readonly kind: 'fence'; readonly line: number; readonly raw: string; readonly body: string };

/** The message cut at its top-level closed `fy-render` fences; one markdown segment when it holds none. Pure. */
export function queueSegments(text: string): readonly Segment[] {
  const normal = normalizeText(text);
  const lines = linesOf(text);
  const segments: Segment[] = [];
  let from = 0;
  for (const fence of commonMarkFences(normal).filter(isClosedFyRender)) {
    if (fence.lead !== '' || fence.close === null || fence.open < from) continue;
    if (fence.open > from)
      segments.push({ kind: 'markdown', line: from, text: lines.slice(from, fence.open).join('\n') });
    segments.push({
      kind: 'fence',
      line: fence.open,
      raw: lines.slice(fence.open, fence.close + 1).join('\n'),
      body: fence.body,
    });
    from = fence.close + 1;
  }
  if (from < lines.length) segments.push({ kind: 'markdown', line: from, text: lines.slice(from).join('\n') });
  return segments.filter(segment => segment.kind === 'fence' || segment.text.trim() !== '');
}

export function QueueProse({ text }: { readonly text: string }) {
  const { fences, ...markdown } = useReferenceSurface();
  const segments = useMemo(
    () => (fences === undefined ? [{ kind: 'markdown', line: 0, text } as const] : queueSegments(text)),
    [fences, text],
  );
  const onTaskOpen = markdown.onTaskOpen;
  return (
    <>
      {segments.map(segment => {
        if (segment.kind === 'markdown') return <Markdown key={segment.line} text={segment.text} {...markdown} />;
        const drawn = fences?.draw({ node: synthesizedFence(segment.body), onTaskOpen }) ?? null;
        return drawn === null ? (
          <Markdown key={segment.line} text={segment.raw} {...markdown} />
        ) : (
          <Fragment key={segment.line}>{drawn}</Fragment>
        );
      })}
    </>
  );
}
