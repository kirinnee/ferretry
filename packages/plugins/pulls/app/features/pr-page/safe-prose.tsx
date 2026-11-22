import { Button, ExternalLink } from '@ferretry/app/ui';
import { type ReactNode, useMemo, useState } from 'react';
import { VisibleRuns } from '../diff/visible-text.tsx';
import { type Block, type Inline, parseProse, visibleText } from './prose-model.ts';

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

/**
 * `text` cut to at most `limit` characters, never through the middle of a surrogate pair. The cut can land inside a
 * whitespace-free run (a URL, a `[label](url)`), and a link cut short is a DIFFERENT clickable address, so that run is
 * split off as `run`: it is drawn as plain text, whatever it holds (no guessing where a URL starts), and `body`, the
 * text before it, is read as usual, so a link wholly before the run stays a link.
 */
function head(text: string, limit: number): { readonly body: string; readonly run: string } {
  let cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  // On a boundary already (the next character is whitespace): nothing was cut through.
  if (/\s/u.test(text.charAt(cut.length))) return { body: cut, run: '' };
  const start = cut.search(/\S*$/u);
  return { body: cut.slice(0, start), run: cut.slice(start) };
}

/** A private-use character that is not in `text`: it stands in for the plain-text run while the body is read. */
function stand(text: string): string {
  const used = new Set(text);
  for (let code = 0xe000; code <= 0xf8ff; code += 1) {
    const char = String.fromCharCode(code);
    if (!used.has(char)) return char;
  }
  return ''; // unreachable: a cut text of at most COLLAPSED_CHARS characters cannot hold all 6,400
}

const putInline = (nodes: readonly Inline[], from: string, run: string): readonly Inline[] =>
  nodes.map((node): Inline => {
    switch (node.kind) {
      case 'text':
      case 'code':
        return { ...node, text: node.text.replaceAll(from, run) };
      case 'image':
        return { ...node, alt: node.alt.replaceAll(from, run) };
      default:
        return { ...node, children: putInline(node.children, from, run) };
    }
  });

/** `blocks` with every `from` put back as `run`, as text (pure). */
function putBlocks(blocks: readonly Block[], from: string, run: string): readonly Block[] {
  return blocks.map((block): Block => {
    switch (block.kind) {
      case 'paragraph':
        return { ...block, inline: putInline(block.inline, from, run) };
      case 'list':
        return { ...block, items: block.items.map(item => putInline(item, from, run)) };
      case 'quote':
        return { ...block, blocks: putBlocks(block.blocks, from, run) };
      case 'code':
        return { ...block, text: block.text.replaceAll(from, run) };
      default:
        return block;
    }
  });
}

/** The collapsed head, read: the body as usual, then the cut run as text (the stand-in keeps the run in its place, in its paragraph or list item). */
function collapsed(text: string): readonly Block[] {
  const { body, run } = head(text, COLLAPSED_CHARS);
  if (run === '') return parseProse(body);
  const mark = stand(body);
  return putBlocks(parseProse(`${body}${mark}`), mark, run);
}

export function SafeProse({ text, sourceUrl }: { readonly text: string; readonly sourceUrl: string }) {
  const [open, setOpen] = useState(false);
  const visible = useMemo(() => visibleText(text), [text]);
  const long = visible.length > COLLAPSED_CHARS;
  const blocks = useMemo(() => (long && !open ? collapsed(visible) : parseProse(visible)), [long, open, visible]);
  return (
    <div className="md fy-seg min-w-0 break-words" data-gh-text="">
      {drawBlocks(blocks, sourceUrl)}
      {long && !open && (
        <p className="m-0" data-gh-collapsed="">
          <Button onClick={() => setOpen(true)} size="sm" type="button">
            Show all {visible.length.toLocaleString('en-US')} characters
          </Button>
        </p>
      )}
    </div>
  );
}
