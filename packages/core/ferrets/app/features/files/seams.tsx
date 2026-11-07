/**
 * What the file viewer uses that another owner's facility will provide, kept as the smallest local stand-in each (never
 * a copy of the facility) until it lands in `@ferretry/app`. Every one is a SAFER subset: without the facility the
 * viewer shows the file's text as the daemon answered it, never more.
 *
 * GAP(app: syntax highlighter): `highlightToHtml` and `langFromPath` (today's `lib/highlight.ts`, `lib/tool-extract.ts`)
 * are the Conversation transcript's shared highlighter; until it is exported a file shows as plain text.
 * GAP(app: Markdown): `Markdown` (today's `components/markdown.tsx`, Conversation C1) is not exported yet; a Markdown file
 * shows its source text.
 * GAP(app: ExternalLink): today's `features/browser/external-link.tsx` (the "Open links in" setting) is not exported yet;
 * a preview's Open is a plain new-tab anchor.
 */
import type { AnchorHTMLAttributes } from 'react';

/** Highlighted markup for `content`, or `null` for "draw it as escaped plain text". */
export const highlightToHtml = (_content: string, _lang: string | undefined): string | null => null;

/** The highlighter language for a path, or `undefined` for plain text. */
export const langFromPath = (_path?: string): string | undefined => undefined;

/** A Markdown file's body. Text only: React escapes it, and nothing here interprets the daemon's answer. */
export const Markdown = ({ text }: { readonly text: string }) => <pre className="kt-fs-pre">{text}</pre>;

/** An outward link: a real anchor that opens a new tab and hands the opened page nothing of this one. */
export const ExternalLink = (props: AnchorHTMLAttributes<HTMLAnchorElement>) => (
  <a {...props} target="_blank" rel="noopener noreferrer" />
);
