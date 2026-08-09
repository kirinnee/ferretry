/**
 * Memoized markdown renderer for assistant prose.
 *
 * Parsing is expensive, so this is wrapped in `memo`: a live append elsewhere in
 * the transcript must not re-parse every assistant block already on screen. That
 * contract is why the resolvers arrive as stable props — an unstable resolver
 * identity defeats the memo and re-parses the whole transcript on every frame
 * (see `agentReferenceIdentityKey`).
 *
 * FENCES ARE HIGHLIGHTED BY THE SHARED REGISTRY, not by `rehype-highlight`. That
 * plugin brings lowlight and its own copy of Highlight.js's common set — a second
 * full parser bundle next to the one `code-block.tsx` already loaded, for a set of
 * languages this app enumerates exactly (`lib/highlight.ts`). A `code` renderer
 * does the same job against the shared registry, so the parsers are downloaded
 * once and only the ones we can actually use. An unknown or absent fence language
 * falls back to react-markdown's own escaped text. Nothing is auto-detected.
 *
 * PROOF, NOT SYNTAX. `remarkReferences` links only what a resolver proved, and
 * every rendered link is re-proved here before it is allowed to act: the reserved
 * envelope must parse, the transform-origin attribute must match, and the resolver
 * must still answer. A model that writes a reference-shaped href into its own
 * prose therefore gets inert text, not a live destination.
 *
 * MULTI-DAEMON. A resolved agent reference carries the `DaemonId` it was proved
 * against and navigates to `/d/:daemon/session/:id` (`daemonSessionPath`), so a
 * reference in one daemon's transcript can never open a same-named session on
 * whichever daemon happens to be in front of the reader. kteam's renderer called
 * `navigate('/session/' + id)` — the single-daemon destination the survey flagged
 * (`pwa-shape.md:115`).
 *
 * NOT PORTED: kteam wrapped external links in `InAppBrowserLink`, part of its
 * in-app browser surface. That surface is not ported, so an external link is an
 * ordinary anchor that opens in a new tab.
 *
 * Ported from kteam's `src/components/Markdown.tsx`.
 */

import type { AttentionId } from '@ferretry/protocol';
import { type MouseEvent, memo, type ReactNode, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type CodeNode, decoratedCodeNodes } from '../lib/code-span-references.ts';
import { FY_RENDER_FENCE_ATTRIBUTE, parseFyRender, remarkFyRenderFences } from '../lib/fy-render.ts';
import { fenceLanguage, highlightToHtml } from '../lib/highlight.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import {
  type AgentReferenceResolver,
  type AttentionReferenceResolver,
  type CodeReference,
  findReferences,
  parseReferenceHref,
  REFERENCE_ORIGIN_ATTRIBUTE,
  type ReferenceResolvers,
  type ResolvedReference,
  type ResolvedSurfaceReference,
  referenceHref,
  referenceIdentity,
  referenceTitle,
  remarkReferences,
  revalidateReference,
  type SkillReferenceResolver,
  type SurfaceReferenceResolver,
  type TaskReferenceResolver,
} from '../lib/references.ts';
import { remarkTableLabels } from '../lib/remark-table-labels.ts';
import { FyRenderBlock } from './fy-render-block.tsx';

/**
 * Resolves authored file candidates to canonical session-relative paths. Injected
 * rather than imported: this component is a renderer, and the filesystem read
 * belongs to the host that already holds the daemon connection and the session cwd.
 */
export type FilePathResolver = (
  candidates: readonly string[],
  signal: AbortSignal,
) => Promise<ReadonlyMap<string, string>>;

const EMPTY_RESOLVED_PATHS: ReadonlyMap<string, string> = new Map();

interface ResolvedCodeReferences {
  readonly key: string;
  readonly paths: ReadonlyMap<string, string>;
}

interface MarkdownAstLinkNode {
  properties?: Readonly<Record<string, unknown>>;
}

interface MarkdownAstChildNode {
  readonly type?: string;
  readonly tagName?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  // `value` is `unknown` rather than `string` because this is a structural read
  // of a foreign AST, and the `typeof` guard that consumes it is a runtime
  // check on a runtime shape — not a restatement of a type we were handed.
  readonly children?: readonly { readonly type?: string; readonly value?: unknown }[];
}

interface MarkdownAstFenceNode {
  readonly children?: readonly MarkdownAstChildNode[];
}

/**
 * The authored body of a fence `remarkFyRenderFences` marked, or null for every
 * other `<pre>`.
 *
 * TRUSTS THE MARK, NOT THE CLASS NAME. `class="language-fy-render"` is also what
 * a fence opened as `fy-render notes` arrives wearing, because hast keeps the
 * language and drops the metadata. The exact-token decision is made in the
 * remark plugin, where both halves are still visible, and this reads its answer.
 *
 * Read off the `<pre>` rather than the `<code>` because the block replaces the
 * whole fence, and `<figure>` inside `<pre>` is not a tree a browser will keep.
 * When this answers null the `<pre>` renders untouched, which is what makes the
 * failure path free: an unparseable `fy-render` fence, an empty one, and a fence
 * in any other language all take the pre-existing highlight-or-escape branch
 * with no code of their own.
 *
 * @internal Exported so the mark has a focused regression of its own.
 */
export function fyRenderFenceBody(node: MarkdownAstFenceNode | null | undefined): string | null {
  const code = node?.children?.[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return null;
  if (code.properties?.[FY_RENDER_FENCE_ATTRIBUTE] !== 'true') return null;
  const body = code.children?.[0];
  if (body?.type !== 'text' || typeof body.value !== 'string') return null;
  // mdast-to-hast terminates a fence body with a newline the author did not type.
  return body.value.replace(/\n$/u, '');
}

/**
 * @internal Exported so the forged-link policy has a focused regression: a link
 * whose origin mark does not match its payload is never re-proved at all.
 */
export function referenceHasTrustedOrigin(
  node: MarkdownAstLinkNode | null | undefined,
  reference: ResolvedReference,
  resolvers: ReferenceResolvers,
): ResolvedReference | null {
  if (node?.properties?.[REFERENCE_ORIGIN_ATTRIBUTE] !== referenceIdentity(reference)) return null;
  return revalidateReference(reference, resolvers);
}

export interface MarkdownProps {
  readonly text: string;
  readonly className?: string;
  /**
   * Opts this surface into rendering `fy-render` fences, and DEFAULTS TO FALSE.
   *
   * This prop is the whole answer to "how does an illustration stay
   * conversation-only": not a documented rule but a defaulted-off capability
   * that a surface has to name deliberately. Every other `<Markdown>` consumer —
   * file previews, reports, and the composer's preview when it lands — gets the
   * inert escaped fence automatically by not passing it, with no code of its own.
   * Exactly one production call site sets it, and a unit test holds it to one.
   */
  readonly enableFyRender?: boolean;
  /** Proves `:callsign` against one daemon's live fleet. Without it, prose. */
  readonly agentReferenceResolver?: AgentReferenceResolver;
  /** Proves `&task` against the daemon's board. Syntax alone never links. */
  readonly taskReferenceResolver?: TaskReferenceResolver;
  /** Proves `!attention` against this session's ledger. */
  readonly attentionReferenceResolver?: AttentionReferenceResolver;
  /** Proves `%terminal:…` against the surfaces THIS session owns. It is also what
   *  makes a tombstone possible: only this resolver can say "closed" rather than
   *  "unknown". */
  readonly surfaceReferenceResolver?: SurfaceReferenceResolver;
  /** Proves `/skill` and `$skill` against this session's own skills catalog. */
  readonly skillReferenceResolver?: SkillReferenceResolver;
  /** Session filesystem context. Without it, code-shaped text stays plain. */
  readonly resolveFilePaths?: FilePathResolver;
  readonly onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  readonly onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  readonly onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
  /** Focuses one proved live surface — the terminal or page the token names.
   *  Without it a proved surface stays inert text, exactly like a task reference
   *  in a surface that cannot open a task board. */
  readonly onSurfaceOpen?: (reference: ResolvedSurfaceReference, opener?: HTMLElement | null) => void;
  readonly onSkillOpen?: (name: string, opener?: HTMLElement | null) => void;
  /** In-app navigation for a proved agent reference. */
  readonly onNavigate?: (to: string) => void;
}

export const Markdown = memo(function Markdown({
  text,
  className,
  enableFyRender = false,
  agentReferenceResolver,
  taskReferenceResolver,
  attentionReferenceResolver,
  surfaceReferenceResolver,
  skillReferenceResolver,
  resolveFilePaths,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  onSurfaceOpen,
  onSkillOpen,
  onNavigate,
}: MarkdownProps) {
  const codeReferenceCandidates = useMemo(
    () => [
      ...new Set(
        findReferences(text).flatMap(match => (match.reference.kind === 'file' ? [match.reference.path] : [])),
      ),
    ],
    [text],
  );
  const resolutionKey = JSON.stringify(codeReferenceCandidates);
  const [resolved, setResolved] = useState<ResolvedCodeReferences | null>(null);

  useEffect(() => {
    if (!resolveFilePaths || !onCodeReferenceOpen || codeReferenceCandidates.length === 0) return undefined;
    const controller = new AbortController();
    void resolveFilePaths(codeReferenceCandidates, controller.signal)
      .then(paths => {
        if (!controller.signal.aborted) setResolved({ key: resolutionKey, paths });
      })
      .catch(() => {
        // Resolution is an enhancement, never a reason prose should fail to
        // render. A missing, offline or older daemon leaves the authored text
        // plain.
        if (!controller.signal.aborted) setResolved({ key: resolutionKey, paths: EMPTY_RESOLVED_PATHS });
      });
    return () => controller.abort();
  }, [codeReferenceCandidates, onCodeReferenceOpen, resolutionKey, resolveFilePaths]);

  // An answer for the previous text must never briefly paint a live link in the
  // next one while its own existence checks are still in flight.
  const resolvedPaths = resolved?.key === resolutionKey ? resolved.paths : EMPTY_RESOLVED_PATHS;
  const canonicalPaths = useMemo(() => new Set(resolvedPaths.values()), [resolvedPaths]);
  const transformResolvers: ReferenceResolvers = {
    agent: agentReferenceResolver,
    file: path => resolvedPaths.get(path) ?? null,
    task: taskReferenceResolver,
    attention: attentionReferenceResolver,
    surface: surfaceReferenceResolver,
    skill: skillReferenceResolver,
  };
  // Re-proving a rendered link asks whether its CANONICAL path is still one we
  // resolved, not whether the authored candidate maps to it again.
  const trustedResolvers: ReferenceResolvers = {
    ...transformResolvers,
    file: path => (canonicalPaths.has(path) ? path : null),
  };

  const openReference = (target: ResolvedReference, opener: HTMLElement | null): void => {
    switch (target.kind) {
      case 'agent':
        onNavigate?.(daemonSessionPath(target.daemonId, target.sessionId));
        break;
      case 'file':
        onCodeReferenceOpen?.(
          {
            path: target.path,
            ...(target.line === undefined ? {} : { line: target.line }),
            ...(target.endLine === undefined ? {} : { endLine: target.endLine }),
          },
          opener,
        );
        break;
      case 'task':
        onTaskOpen?.(target.id, opener);
        break;
      case 'attention':
        onAttentionOpen?.(target.id, opener);
        break;
      case 'surface':
        onSurfaceOpen?.(target, opener);
        break;
      case 'skill':
        onSkillOpen?.(target.name, opener);
        break;
    }
  };

  const hasOpener = (target: ResolvedReference): boolean => {
    switch (target.kind) {
      case 'agent':
        // A proved agent whose destination cannot be reached is still a dead
        // link: the click handler prevents the browser's own navigation, so
        // without `onNavigate` the anchor would swallow the press and do nothing.
        return onNavigate !== undefined;
      case 'file':
        return onCodeReferenceOpen !== undefined;
      case 'task':
        return onTaskOpen !== undefined;
      case 'attention':
        return onAttentionOpen !== undefined;
      case 'surface':
        return onSurfaceOpen !== undefined;
      case 'skill':
        return onSkillOpen !== undefined;
    }
  };

  const destination = (target: ResolvedReference): string =>
    target.kind === 'agent' ? daemonSessionPath(target.daemonId, target.sessionId) : referenceHref(target);

  /**
   * THE one click behaviour, shared by prose links and code decorations. A
   * modifier or non-primary click is the reader asking the browser for a new
   * tab, and is never intercepted.
   */
  const referenceClick =
    (target: ResolvedReference, chain?: (event: MouseEvent<HTMLAnchorElement>) => void) =>
    (event: MouseEvent<HTMLAnchorElement>): void => {
      chain?.(event);
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      openReference(target, event.currentTarget);
    };

  /**
   * Render decorated code back out. Text arrives as strings, so the code's own
   * bytes reach the DOM through React's own escaping; highlighter tokens keep
   * their class and their nesting, which is what preserves the theme colours.
   */
  const renderCodeNodes = (nodes: readonly CodeNode[], path: string): ReactNode[] =>
    nodes.map((node, index) => {
      const key = `${path}.${index}`;
      if (node.kind === 'text') return node.text;
      if (node.kind === 'span')
        return (
          <span className={node.className} key={key}>
            {renderCodeNodes(node.children, key)}
          </span>
        );
      return (
        <a
          data-fy-reference={referenceIdentity(node.reference)}
          href={destination(node.reference)}
          key={key}
          onClick={referenceClick(node.reference)}
          title={referenceTitle(node.reference)}
        >
          {node.text}
        </a>
      );
    });

  return (
    <div className={`md min-w-0 max-w-full ${className ?? ''}`}>
      <ReactMarkdown
        components={{
          a: ({ node, href, onClick, children, ...rest }) => {
            const parsed = parseReferenceHref(href);
            if (parsed === null) {
              return (
                <a href={href} onClick={onClick} rel="noreferrer noopener" target="_blank" {...rest}>
                  {children}
                </a>
              );
            }
            const target = referenceHasTrustedOrigin(node, parsed, trustedResolvers);
            if (!target || !hasOpener(target)) return <>{children}</>;
            return (
              <a
                data-fy-reference={referenceIdentity(target)}
                href={destination(target)}
                onClick={referenceClick(target, onClick)}
                {...rest}
              >
                {children}
              </a>
            );
          },
          // Tables wrap aggressively to fit the pane and may full-bleed past the
          // prose measure (`styles/index.css`: `.md table` / `.md-table-scroll`).
          // The scroller is the last-resort catch for a table that still cannot
          // shrink, so a wide table scrolls INSIDE itself and never the page.
          //
          // On a phone the layout switches cells to `display:block` stacked
          // cards, which strips the implicit ARIA table semantics. The explicit
          // roles here (plus `scope="col"` on headers) preserve the
          // header-to-cell association for a screen reader across that switch; on
          // desktop they are the elements' implicit roles, so they are inert.
          code: ({ node: _node, className: fenceClassName, children, ...rest }) => {
            const language = fenceLanguage(fenceClassName);
            const source = language ? String(children).replace(/\n$/u, '') : '';
            const html = language ? highlightToHtml(source, language) : null;
            // REFERENCES INSIDE CODE. The code text is decorated, never
            // rewritten: `decoratedCodeNodes` answers null unless it can slice
            // this exact source — and for a highlighted fence, unless the
            // highlighter's markup reassembles into it byte for byte. Null keeps
            // the two renderings below exactly as they were.
            //
            // Only a literal string is offered for decoration. `String(children)`
            // is a lossy reading of anything else, and a reference is not worth a
            // corrupted snippet.
            const decoratable = typeof children === 'string' ? (language ? source : children) : null;
            const decorated =
              decoratable === null
                ? null
                : decoratedCodeNodes({
                    code: decoratable,
                    html,
                    resolvers: trustedResolvers,
                    isOpenable: hasOpener,
                  });
            if (decorated !== null)
              return html === null ? (
                <code className={fenceClassName} {...rest}>
                  {renderCodeNodes(decorated, 'code')}
                </code>
              ) : (
                <code className={`hljs language-${language}`}>{renderCodeNodes(decorated, 'code')}</code>
              );
            // No language (inline code, bare fence) or an unknown one: hand it
            // back to react-markdown, which escapes it. Never raw HTML.
            if (html === null) {
              return (
                <code className={fenceClassName} {...rest}>
                  {children}
                </code>
              );
            }
            return (
              // Safe on the same contract `code-block.tsx` relies on:
              // `highlightToHtml` answers with highlight.js markup for a language
              // IT registered — which escapes the source it tokenizes — or null,
              // and the branch above covers every input it refused. Fence text is
              // never forwarded as markup.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted output is the registry's own escaped markup; every refusal is handled above
              <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />
            );
          },
          // THE ONE PLACE AN ILLUSTRATION CAN APPEAR, and it is a replacement
          // rather than an addition: a matched fence renders as the block INSTEAD
          // of the `<pre>`, because `<figure>` inside `<pre>` is not a tree a
          // browser keeps and `white-space: pre` is not a layout an illustration
          // survives. Everything else — the opt-in off, a different info string,
          // an unparseable body — falls through to the ordinary fence below,
          // where `code` still highlights or escapes it exactly as before. There
          // is no partial state: a bad block is indistinguishable from a plain
          // fence, which is the same rule an unknown fence language already has.
          pre: ({ node, children, ...rest }) => {
            const body = enableFyRender ? fyRenderFenceBody(node) : null;
            const parsed = body === null ? null : parseFyRender(body);
            if (parsed?.ok === true) return <FyRenderBlock block={parsed.block} />;
            return <pre {...rest}>{children}</pre>;
          },
          table: ({ node: _node, ...rest }) => (
            <div className="md-table-scroll scroll-thin">
              <table {...rest} />
            </div>
          ),
          // kteam additionally set the explicit ARIA table roles
          // (`role="table"`/`rowgroup`/`row`/`cell`/`columnheader`) so the
          // header-to-cell association survived the phone layout switching cells
          // to `display:block`. Biome rejects every one of them as a redundant
          // role and its errors are hard failures, so they are deliberately not
          // carried over. `scope="col"` is not redundant and is kept: it is the
          // header association a screen reader reads first.
          th: ({ node: _node, ...rest }) => <th scope="col" {...rest} />,
        }}
        // remarkTableLabels stamps each body cell with its column header as
        // `data-label`, which the mobile stacked-card layout prints. It must run
        // after remark-gfm has produced the table nodes.
        // remarkFyRenderFences marks fences whose info string is EXACTLY the
        // token — the one place mdast still holds the metadata hast drops.
        // Marking unconditionally rather than behind `enableFyRender` keeps the
        // mark a statement about the DOCUMENT; whether it is acted on is the
        // surface's decision, made in `pre` below.
        remarkPlugins={[
          remarkGfm,
          remarkTableLabels,
          remarkFyRenderFences,
          [remarkReferences, { resolvers: transformResolvers }],
        ]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
