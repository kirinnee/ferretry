import { Button, ExternalLink } from '@ferretry/app/ui';
import { type ReactNode, useMemo, useState } from 'react';
import { VisibleRuns } from '../diff/visible-text.tsx';
import { type Block, type Inline, parseProse } from './prose-model.ts';

/**
 * GitHub text, drawn inert (E4). It is built only from the tree `parseProse` makes, as React elements: there is no
 * `dangerouslySetInnerHTML`, no `<img>`, no script, no raw tag (React escapes the text), and a link is the app's one `ExternalLink`
 * (a new tab, or wherever the "Open links in" setting says; never a Ferretry reference), and a hidden control character
 * (a bidi override, a zero-width mark) is drawn as a visible chip, never passed on.
 *
 * An image is drawn as "image: <alt>" with a link to where the text lives on GitHub (`sourceUrl`), because opening a
 * stranger's picture address from here would make this app fetch it for them.
 */
function drawInline(nodes: readonly Inline[], sourceUrl: string, key = ''): ReactNode[] {
  return nodes.map((node, index) => {
    const id = `${key}${String(index)}`;
    switch (node.kind) {
      case 'text':
        return <VisibleRuns key={id} text={node.text} />;
      case 'code':
        return (
          <code key={id}>
            <VisibleRuns text={node.text} />
          </code>
        );
      case 'bold':
        return <strong key={id}>{drawInline(node.children, sourceUrl, `${id}.`)}</strong>;
      case 'italic':
        return <em key={id}>{drawInline(node.children, sourceUrl, `${id}.`)}</em>;
      case 'strike':
        return <s key={id}>{drawInline(node.children, sourceUrl, `${id}.`)}</s>;
      case 'link': {
        // The label is the author's; the address is the page's. It is drawn beside the label, in the page, so a tap on a
        // phone (no hover, no tooltip) shows where it goes before it goes there. A label that already is the address says it once.
        const label = node.children.map(child => (child.kind === 'text' ? child.text : '')).join('');
        return (
          <span key={id}>
            <ExternalLink data-gh-link="" href={node.href} title={node.href}>
              {drawInline(node.children, sourceUrl, `${id}.`)}
            </ExternalLink>
            {label === node.href ? null : (
              <>
                {' '}
                <span className="break-all text-meta text-muted" data-gh-dest="">
                  ({node.href})
                </span>
              </>
            )}
          </span>
        );
      }
      default:
        // an image
        return (
          <span data-gh-image="" key={id}>
            <span className="text-muted">
              image: {node.alt === '' ? '(no description)' : <VisibleRuns text={node.alt} />}
            </span>{' '}
            <ExternalLink href={sourceUrl}>Open on GitHub</ExternalLink>
          </span>
        );
    }
  });
}

function drawBlocks(blocks: readonly Block[], sourceUrl: string, key = ''): ReactNode[] {
  return blocks.map((block, index) => {
    const id = `${key}${String(index)}`;
    switch (block.kind) {
      case 'paragraph':
        return (
          <p className="whitespace-pre-wrap" key={id}>
            {drawInline(block.inline, sourceUrl, `${id}.`)}
          </p>
        );
      case 'list': {
        const items = block.items.map((item, at) => (
          <li key={`${id}.${String(at)}`}>{drawInline(item, sourceUrl, `${id}.${String(at)}.`)}</li>
        ));
        return block.ordered ? <ol key={id}>{items}</ol> : <ul key={id}>{items}</ul>;
      }
      case 'quote':
        return (
          <blockquote className="border-l-2 border-border-strong pl-sm text-muted" key={id}>
            {drawBlocks(block.blocks, sourceUrl, `${id}.`)}
          </blockquote>
        );
      case 'code':
        return (
          <pre className="mono overflow-x-auto rounded-control bg-surface-2 p-sm text-meta" key={id}>
            <code>
              <VisibleRuns text={block.text} />
            </code>
          </pre>
        );
      default:
        // a rule
        return <hr key={id} />;
    }
  });
}

/** Characters drawn before a long text asks to be opened: a page of many long texts is not drawn whole. */
export const COLLAPSED_CHARS = 1_000;

/** `text` cut to `limit` characters, never through the middle of a surrogate pair. */
function head(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function SafeProse({ text, sourceUrl }: { readonly text: string; readonly sourceUrl: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSED_CHARS;
  const shown = long && !open ? head(text, COLLAPSED_CHARS) : text;
  const blocks = useMemo(() => parseProse(shown), [shown]);
  return (
    <div className="md fy-seg min-w-0 break-words" data-gh-text="">
      {drawBlocks(blocks, sourceUrl)}
      {long && !open && (
        <p className="m-0" data-gh-collapsed="">
          <Button onClick={() => setOpen(true)} size="sm" type="button">
            Show all {text.length.toLocaleString('en-US')} characters
          </Button>
        </p>
      )}
    </div>
  );
}
