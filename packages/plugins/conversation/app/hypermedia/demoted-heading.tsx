import type { HeadingSlotProps } from 'durian-markdown/react/strict';
import { createContext, useContext } from 'react';

/**
 * A HEADING A SURFACE DOES NOT WANT AS A HEADING (`demoteHeadings`, r12 R3). The agenda draws a ferret's `## Plan` inside a
 * card whose own title is the heading, so an `h2` there would sit above it in the outline however it was styled down. The
 * shell's Markdown makes it a paragraph holding one bold line (`p[data-demoted-heading] > strong`); so does this, and the
 * surface sets that line at its own size. It keeps the heading's id, so a `[link](#plan)` in the same message still jumps to it.
 *
 * HOW THE FLAG REACHES THE SLOT: Durian's `Heading` slot is one object for every message (module-level, Durian keys its settings
 * on its identity), so the choice rides a context the surface's view sets around the message. Without it the slot draws the
 * heading exactly as Durian does when no slot is set (`h<level>`, the id, the `#` anchor), so the chat is unchanged.
 */
export const DemoteHeadings = createContext(false);

/** The `Heading` slot of every message: a heading as Durian draws it, or the demoted bold line when the surface asked for that. */
export function HypermediaHeading({ level, id, children }: HeadingSlotProps) {
  const demoted = useContext(DemoteHeadings);
  if (demoted)
    return (
      <p data-demoted-heading="" id={id}>
        <strong>{children}</strong>
      </p>
    );
  const Tag = `h${Math.min(6, Math.max(1, level))}` as 'h2';
  return (
    <Tag id={id}>
      {/* biome-ignore lint/a11y/useAnchorContent: Durian's own heading anchor, hidden from assistive tech exactly as Durian draws it (the heading itself is the target). */}
      <a className="h-anchor" href={`#${id}`} aria-hidden="true" tabIndex={-1}>
        #
      </a>
      {children}
    </Tag>
  );
}
