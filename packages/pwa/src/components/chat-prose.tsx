import { Markdown, type MarkdownProps } from './markdown.tsx';
import { useReferenceSurface } from './reference-surface.tsx';

/**
 * THE SINGLE `fy-render` OPT-IN. This is the one call site in the product that passes `enableFyRender`, and
 * that is the whole mechanism keeping inline illustrations to prose the owner's own agents authored: every
 * other `<Markdown>` surface is inert by not naming the capability, so a `fy-render` fence pasted into a
 * file preview, a report or the composer renders as an escaped code fence with no code on those surfaces at
 * all. An assistant's message and an agenda card (written by the owner's ferret, on the owner's daemon)
 * are the two callers; both read references through the same proof-before-link surface.
 * `tests/unit/fy-render-opt-in.test.ts` holds the count at one. See `docs/fy-render.md`.
 */
export function ChatProse({ text, className, copyable }: Pick<MarkdownProps, 'text' | 'className' | 'copyable'>) {
  return <Markdown enableFyRender text={text} className={className} copyable={copyable} {...useReferenceSurface()} />;
}
