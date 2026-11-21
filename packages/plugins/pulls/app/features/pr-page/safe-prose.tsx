import { ExternalLink } from '@ferretry/app/ui';
import { type ReactNode, useMemo } from 'react';
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
      case 'link':
        return (
          <ExternalLink data-gh-link="" href={node.href} key={id} title={node.href}>
            {drawInline(node.children, sourceUrl, `${id}.`)}
          </ExternalLink>
        );
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

export function SafeProse({ text, sourceUrl }: { readonly text: string; readonly sourceUrl: string }) {
  const blocks = useMemo(() => parseProse(text), [text]);
  return (
    <div className="md fy-seg min-w-0 break-words" data-gh-text="">
      {drawBlocks(blocks, sourceUrl)}
    </div>
  );
}
