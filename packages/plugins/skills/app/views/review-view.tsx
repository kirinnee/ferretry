/**
 * Text with its hidden-character markers drawn to stand out (today's `catalog-review-view.tsx`, the part a skill file
 * shown in full uses). The daemon wrote the markers; this only lays them out, and never removes one.
 */
import { revealHidden } from '@ferretry/app/ui';
import { splitMarkers } from '../lib/review-model.ts';

/** Text with each hidden character written out as its marker, and each marker drawn to stand out. */
export function MarkedText({ text }: { readonly text: string }) {
  return (
    <>
      {splitMarkers(revealHidden(text)).map((segment, index) =>
        segment.marker ? (
          <mark
            // The position is the identity: segments never reorder.
            // biome-ignore lint/suspicious/noArrayIndexKey: segments of one string
            key={index}
            className="rounded-control border border-err-border bg-err-bg px-1 font-semibold text-err"
            data-hidden-marker=""
          >
            {segment.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one string
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
