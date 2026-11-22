import {
  type CodeNode,
  decoratedCodeNodes,
  highlightToHtml,
  referenceIdentity,
  referenceTitle,
  revalidateReference,
} from '@ferretry/app';
import { ExternalLink } from '@ferretry/app/ui';
import type { CodeSlotProps, InlineCodeSlotProps, LinkSlotProps, Slots } from 'durian-hypermedia/react/strict';
import type { MouseEvent, ReactNode } from 'react';
import { type ReferenceProof, referenceClick, useReferenceProof } from './reference-proof.tsx';

/**
 * THE MARKDOWN ELEMENTS A MESSAGE DRAWS BY OUR OWN RULES, handed to Durian's slots (upstream ask C1 items 1–3): a link
 * opens where every outside link opens ("Open links in"), code carries our colours and the references proved inside it.
 * They are module-level components, never rebuilt, so a re-render of a message never remounts what they drew.
 */

/** A link to a heading of the SAME message scrolls to it; it does not touch the address bar or the app's router. */
function jumpToHeading(event: MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  const id = decodeURIComponent((event.currentTarget.getAttribute('href') ?? '').slice(1));
  const heading = id === '' ? null : event.currentTarget.ownerDocument.getElementById(id);
  if (heading === null) return;
  event.preventDefault();
  heading.scrollIntoView({ block: 'start' });
}

function HypermediaLink({ href, title, external, children }: LinkSlotProps) {
  if (external)
    return (
      <ExternalLink href={href} title={title}>
        {children}
      </ExternalLink>
    );
  // The URL policy lets through only `#anchor` besides the outside web; anything else is text.
  if (!href.startsWith('#')) return <>{children}</>;
  return (
    <a href={href} onClick={jumpToHeading} title={title}>
      {children}
    </a>
  );
}

const ENTITY = /&(?:amp|lt|gt|quot|#x27|#39);/gu;
const ENTITY_TEXT: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};
const TOKEN = /<span class="([^"]*)">|<\/span>|[^<]+/gu;

const textOfNodes = (nodes: readonly CodeNode[]): string =>
  nodes.map(node => (node.kind === 'span' ? textOfNodes(node.children) : node.text)).join('');

/**
 * Highlighter markup read back into nodes (highlight.js emits one shape: nested `<span class>` around escaped text), or
 * `null` when it is anything else or does not add up to `source` byte for byte. The colours reach the DOM as React
 * elements, never as an HTML string, so the page's Trusted Types policy has nothing to approve.
 */
function nodesOfMarkup(html: string, source: string): CodeNode[] | null {
  const root: CodeNode[] = [];
  const open: { readonly className: string; readonly children: CodeNode[] }[] = [];
  let cursor = 0;
  for (const match of html.matchAll(TOKEN)) {
    if (match.index !== cursor) return null;
    cursor = match.index + match[0].length;
    if (match[1] !== undefined) {
      open.push({ className: match[1], children: [] });
      continue;
    }
    if (match[0] === '</span>') {
      const closed = open.pop();
      if (closed === undefined) return null;
      (open.at(-1)?.children ?? root).push({ kind: 'span', className: closed.className, children: closed.children });
      continue;
    }
    (open.at(-1)?.children ?? root).push({
      kind: 'text',
      text: match[0].replace(ENTITY, entity => ENTITY_TEXT[entity] ?? entity),
    });
  }
  if (cursor !== html.length || open.length > 0) return null;
  return textOfNodes(root) === source ? root : null;
}

function CodeNodes({
  nodes,
  proof,
  path,
}: {
  readonly nodes: readonly CodeNode[];
  readonly proof: ReferenceProof | null;
  readonly path: string;
}) {
  return (
    <>
      {nodes.map((node, index): ReactNode => {
        const key = `${path}.${index}`;
        if (node.kind === 'text') return node.text;
        if (node.kind === 'span')
          return (
            <span className={node.className} key={key}>
              <CodeNodes nodes={node.children} path={key} proof={proof} />
            </span>
          );
        if (proof === null) return node.text;
        const target = node.reference;
        return (
          <a
            data-fy-reference={referenceIdentity(target)}
            href={proof.destination(target)}
            key={key}
            onClick={referenceClick(proof, target, t => revalidateReference(t, proof.trusted) !== null)}
            title={referenceTitle(target)}
          >
            {node.text}
          </a>
        );
      })}
    </>
  );
}

/** Code with its proved references decorated, or `null` when there is nothing to decorate (the caller draws it plain). */
function decorated(proof: ReferenceProof | null, code: string, html: string | null): CodeNode[] | null {
  if (proof === null) return null;
  return decoratedCodeNodes({ code, html, resolvers: proof.trusted, isOpenable: proof.hasOpener });
}

function HypermediaCode({ lang, text }: CodeSlotProps) {
  const proof = useReferenceProof();
  const language = lang.toLowerCase();
  const html = highlightToHtml(text, language);
  const nodes = decorated(proof, text, html) ?? (html === null ? null : nodesOfMarkup(html, text));
  return (
    <div className="code-block">
      {lang === '' ? null : <span className="code-lang">{lang}</span>}
      <pre className="ch-pre">
        <code className={html === null ? undefined : `hljs language-${language}`}>
          {nodes === null ? text : <CodeNodes nodes={nodes} path="code" proof={proof} />}
        </code>
      </pre>
    </div>
  );
}

export function HypermediaInlineCode({ text }: InlineCodeSlotProps) {
  const proof = useReferenceProof();
  const nodes = decorated(proof, text, null);
  return <code>{nodes === null ? text : <CodeNodes nodes={nodes} path="inline" proof={proof} />}</code>;
}

/** The slots a message is drawn with. Module-level: Durian keys its settings on this object's identity. */
export const HYPERMEDIA_SLOTS: Slots = {
  Code: HypermediaCode,
  InlineCode: HypermediaInlineCode,
  Link: HypermediaLink,
};
