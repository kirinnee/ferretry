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
 * against and navigates to that daemon's chat screen (`useScreenHref`), so a
 * reference in one daemon's transcript can never open a same-named session on
 * whichever daemon happens to be in front of the reader. kteam's renderer called
 * `navigate('/session/' + id)` — the single-daemon destination.
 *
 * EXTERNAL LINKS are `ExternalLink` (`features/browser/external-link.tsx`), the
 * same anchor every other outside link in the app is, so Settings › Appearance ›
 * "Open links in" decides where a tap goes: the reader's browser (the default)
 * or Ferretry's side panel. kteam wrapped them in `InAppBrowserLink` for the same
 * surface, with no choice.
 *
 * THE ELEMENT RENDERERS ARE MODULE CONSTANTS. react-markdown draws each element
 * with the component named for its tag, and React keeps an element only while its
 * TYPE is the same function. Renderers written inline were new functions on every
 * render, so any re-render of a message — a rebuilt reference surface, a resolved
 * file path — unmounted and remounted every link, table and `fy-render` block in
 * it: a running interactive page was thrown away and started again, and a table's
 * open full-screen sheet closed. The renderers below are defined once; what they
 * need from THIS message reaches them through `MarkdownRenderingContext`.
 *
 * Ported from kteam's `src/components/Markdown.tsx`.
 */

import {
  type ComponentProps,
  createContext,
  type MouseEvent,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown';

type PluggableList = NonNullable<Options['remarkPlugins']>;
import remarkGfm from 'remark-gfm';
import { type CodeNode, decoratedCodeNodes } from '../references/code-spans.ts';
import {
  type AgendaId,
  type AgendaReferenceResolver,
  type AgentReferenceResolver,
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
} from '../references/grammar.ts';
import { useScreenHref } from '../router/screen-href.ts';
import { trustedHighlight } from '../security/trusted-types.ts';
import { LOCATION_FENCE_LANGUAGE, parseLocationBlock } from '../shared/location-share.ts';
import { LocationChip } from '../shared/location-chip.tsx';
import { type ClipboardWriter } from '../ui/copy-button.tsx';
import { ExternalLink } from '../ui/external-link.tsx';
import { fenceLanguage, highlightToHtml } from './highlight.ts';
import { CopyableFence, CopyableSpan } from './markdown-copy.tsx';
import { MarkdownTable } from './markdown-table.tsx';
import { remarkTableLabels } from './remark-table-labels.ts';

/**
 * Resolves authored file candidates to canonical session-relative paths. Injected
 * rather than imported: this component is a renderer, and the filesystem read
 * belongs to the host that already holds the daemon connection and the session cwd.
 */
type FilePathResolver = (candidates: readonly string[], signal: AbortSignal) => Promise<ReadonlyMap<string, string>>;

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

export interface MarkdownAstFenceNode {
  readonly children?: readonly MarkdownAstChildNode[];
}

/**
 * A FENCE KIND A SURFACE DRAWS BY ITSELF. Markdown is a shell facility and holds no feature, so a plugin that has a
 * fence kind of its own (Conversation's `fy-render` blocks) brings it here: `remark` marks the fences the document
 * holds, `draw` returns what to put INSTEAD of the `<pre>`, or `null` to leave the ordinary fence. The object must be
 * stable between renders (Markdown is memoised on it). It is acted on only where `enableFyRender` is set.
 */
export interface MarkdownFences {
  readonly remark: PluggableList;
  readonly draw: (fence: {
    readonly node: MarkdownAstFenceNode | undefined;
    readonly onTaskOpen: ((id: string, opener?: HTMLElement | null) => void) | undefined;
  }) => ReactNode | null;
}

/**
 * The authored body of an `fy-location` fence, or null for every other `<pre>`.
 * Read from the language class: unlike `fy-render` this block does no harm when an
 * author writes one, because the chip draws only numbers and one cleaned label.
 *
 * @internal Exported so the read has a focused regression of its own.
 */
export function locationFenceBody(node: MarkdownAstFenceNode | null | undefined): string | null {
  const code = node?.children?.[0] as
    | (MarkdownAstChildNode & { readonly properties?: { readonly className?: unknown } })
    | undefined;
  if (code?.type !== 'element' || code.tagName !== 'code') return null;
  const classes = code.properties?.className;
  if (!Array.isArray(classes) || !classes.includes(`language-${LOCATION_FENCE_LANGUAGE}`)) return null;
  const body = code.children?.[0];
  if (body?.type !== 'text' || typeof body.value !== 'string') return null;
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

/** What react-markdown hands the renderer for one tag: the element's own props and its hast node. */
type ElementProps<Tag extends 'a' | 'code' | 'pre' | 'table' | 'th'> = ComponentProps<Tag> & ExtraProps;

const fenceText = (node: unknown): string => {
  const text = (value: unknown): string => {
    const v = value as { readonly value?: unknown; readonly children?: readonly unknown[] };
    if (typeof v.value === 'string') return v.value;
    return (v.children ?? []).map(text).join('');
  };
  return text(node).replace(/\n$/u, '');
};

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
  /** The fence kinds this surface draws by itself (see {@link MarkdownFences}); acted on only with `enableFyRender`. */
  readonly fences?: MarkdownFences;
  /**
   * Draws a Markdown heading (`#` … `######`) as bold body text, never as an h1–h6. For prose that sits inside a
   * card's own structure (an agenda segment), where a pasted heading would out-shout the card's labels. Off by default.
   */
  readonly demoteHeadings?: boolean;
  /** Puts a Copy button on every code fence and inline code span, writing through this clipboard. Off by default. */
  readonly copyable?: ClipboardWriter;
  /** Proves `:callsign` against one daemon's live fleet. Without it, prose. */
  readonly agentReferenceResolver?: AgentReferenceResolver;
  /** Proves `&task` against the daemon's board. Syntax alone never links. */
  readonly taskReferenceResolver?: TaskReferenceResolver;
  /** Proves `!attention` against this session's ledger. */
  readonly agendaReferenceResolver?: AgendaReferenceResolver;
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
  readonly onAgendaOpen?: (id: AgendaId, opener?: HTMLElement | null) => void;
  /** Focuses one proved live surface — the terminal or page the token names.
   *  Without it a proved surface stays inert text, exactly like a task reference
   *  in a surface that cannot open a task board. */
  readonly onSurfaceOpen?: (reference: ResolvedSurfaceReference, opener?: HTMLElement | null) => void;
  readonly onSkillOpen?: (name: string, opener?: HTMLElement | null) => void;
  /** In-app navigation for a proved agent reference. */
  readonly onNavigate?: (to: string) => void;
}

/**
 * WHAT THE ELEMENT RENDERERS READ FROM THE MESSAGE THEY ARE IN: its proofs, its openers and the
 * capabilities the surface named. A new value each render is fine — a context change re-renders the
 * renderers in place; only a change of the renderer FUNCTIONS would remount what they drew.
 */
interface MarkdownRendering {
  readonly enableFyRender: boolean;
  readonly copyable: ClipboardWriter | undefined;
  readonly fences: MarkdownFences | undefined;
  readonly onTaskOpen: ((id: string, opener?: HTMLElement | null) => void) | undefined;
  readonly trustedResolvers: ReferenceResolvers;
  readonly hasOpener: (target: ResolvedReference) => boolean;
  readonly destination: (target: ResolvedReference) => string;
  readonly referenceClick: (
    target: ResolvedReference,
    chain?: (event: MouseEvent<HTMLAnchorElement>) => void,
  ) => (event: MouseEvent<HTMLAnchorElement>) => void;
}

const MarkdownRenderingContext = createContext<MarkdownRendering | null>(null);

const useMarkdownRendering = (): MarkdownRendering => {
  const rendering = useContext(MarkdownRenderingContext);
  if (rendering === null) throw new Error('a Markdown element renderer was drawn outside <Markdown>');
  return rendering;
};

/**
 * Render decorated code back out. Text arrives as strings, so the code's own
 * bytes reach the DOM through React's own escaping; highlighter tokens keep
 * their class and their nesting, which is what preserves the theme colours.
 */
const renderCodeNodes = (rendering: MarkdownRendering, nodes: readonly CodeNode[], path: string): ReactNode[] =>
  nodes.map((node, index) => {
    const key = `${path}.${index}`;
    if (node.kind === 'text') return node.text;
    if (node.kind === 'span')
      return (
        <span className={node.className} key={key}>
          {renderCodeNodes(rendering, node.children, key)}
        </span>
      );
    return (
      <a
        data-fy-reference={referenceIdentity(node.reference)}
        href={rendering.destination(node.reference)}
        key={key}
        onClick={rendering.referenceClick(node.reference)}
        title={referenceTitle(node.reference)}
      >
        {node.text}
      </a>
    );
  });

function MarkdownLink({ node, href, onClick, children, ...rest }: ElementProps<'a'>) {
  const { trustedResolvers, hasOpener, destination, referenceClick } = useMarkdownRendering();
  const parsed = parseReferenceHref(href);
  if (parsed === null) {
    return (
      <ExternalLink href={href} onClick={onClick} {...rest}>
        {children}
      </ExternalLink>
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
}

function MarkdownCode({ node: _node, className: fenceClassName, children, ...rest }: ElementProps<'code'>) {
  const rendering = useMarkdownRendering();
  const language = fenceLanguage(fenceClassName);
  const source = language ? String(children ?? '').replace(/\n$/u, '') : '';
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
          resolvers: rendering.trustedResolvers,
          isOpenable: rendering.hasOpener,
        });
  const element =
    decorated !== null ? (
      html === null ? (
        <code className={fenceClassName} {...rest}>
          {renderCodeNodes(rendering, decorated, 'code')}
        </code>
      ) : (
        <code className={`hljs language-${language}`}>{renderCodeNodes(rendering, decorated, 'code')}</code>
      )
    ) : html === null ? (
      // No language (inline code, bare fence) or an unknown one: hand it
      // back to react-markdown, which escapes it. Never raw HTML.
      <code className={fenceClassName} {...rest}>
        {children}
      </code>
    ) : (
      // Safe on the same contract `code-block.tsx` relies on:
      // `highlightToHtml` answers with highlight.js markup for a language
      // IT registered — which escapes the source it tokenizes — or null,
      // and the branch above covers every input it refused. Fence text is
      // never forwarded as markup.
      <code
        className={`hljs language-${language}`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted output is the registry's own escaped markup, through the fy-highlight Trusted Types policy; every refusal is handled above
        dangerouslySetInnerHTML={{ __html: trustedHighlight(html) }}
      />
    );
  if (rendering.copyable === undefined) return element;
  return (
    <CopyableSpan text={String(children).replace(/\n$/u, '')} write={rendering.copyable}>
      {element}
    </CopyableSpan>
  );
}

/**
 * THE ONE PLACE AN ILLUSTRATION CAN APPEAR, and it is a replacement rather than
 * an addition: a matched fence renders as the block INSTEAD of the `<pre>`,
 * because `<figure>` inside `<pre>` is not a tree a browser keeps and
 * `white-space: pre` is not a layout an illustration survives. Everything else —
 * the opt-in off, a different info string, an unparseable body — falls through to
 * the ordinary fence below, where `code` still highlights or escapes it exactly as
 * before. There is no partial state: a bad block is indistinguishable from a plain
 * fence, which is the same rule an unknown fence language already has.
 */
function MarkdownPre({ node, children, ...rest }: ElementProps<'pre'>) {
  const { enableFyRender, fences, copyable, onTaskOpen } = useMarkdownRendering();
  const drawn = enableFyRender
    ? (fences?.draw({ node: node as MarkdownAstFenceNode | undefined, onTaskOpen }) ?? null)
    : null;
  if (drawn !== null) return <>{drawn}</>;
  const locationBody = locationFenceBody(node as MarkdownAstFenceNode | undefined);
  const fix = locationBody === null ? null : parseLocationBlock(locationBody);
  if (fix !== null) return <LocationChip fix={fix} />;
  const fence = <pre {...rest}>{children}</pre>;
  if (copyable === undefined) return fence;
  return (
    <CopyableFence text={fenceText(node)} write={copyable}>
      {fence}
    </CopyableFence>
  );
}

/**
 * THE RENDERERS, once for the whole app — see the header for why they must never be rebuilt.
 *
 * Tables wrap aggressively to fit the pane and may full-bleed past the prose
 * measure (`styles/index.css`: `.md table` / `.md-table-scroll`); a phone reads a
 * table as cards or as the real table, its own choice (`markdown-table.tsx`).
 *
 * kteam additionally set the explicit ARIA table roles
 * (`role="table"`/`rowgroup`/`row`/`cell`/`columnheader`) so the header-to-cell
 * association survived the phone layout switching cells to `display:block`.
 * Biome rejects every one of them as a redundant role and its errors are hard
 * failures, so they are deliberately not carried over. `scope="col"` is not
 * redundant and is kept: it is the header association a screen reader reads first.
 */
const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  code: MarkdownCode,
  pre: MarkdownPre,
  table: ({ node: _node, ...rest }: ElementProps<'table'>) => <MarkdownTable {...rest} />,
  th: ({ node: _node, ...rest }: ElementProps<'th'>) => <th scope="col" {...rest} />,
};

/** A heading drawn as bold body text: a paragraph holding a `strong`, so no h1–h6 outline is made by pasted prose. */
function DemotedHeading({ node: _node, children }: ComponentProps<'h1'> & ExtraProps) {
  return (
    <p data-demoted-heading="">
      <strong>{children}</strong>
    </p>
  );
}

const DEMOTED_HEADING_COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  h1: DemotedHeading,
  h2: DemotedHeading,
  h3: DemotedHeading,
  h4: DemotedHeading,
  h5: DemotedHeading,
  h6: DemotedHeading,
};

export const Markdown = memo(function Markdown({
  text,
  className,
  enableFyRender = false,
  fences,
  demoteHeadings = false,
  copyable,
  agentReferenceResolver,
  taskReferenceResolver,
  agendaReferenceResolver,
  surfaceReferenceResolver,
  skillReferenceResolver,
  resolveFilePaths,
  onTaskOpen,
  onCodeReferenceOpen,
  onAgendaOpen,
  onSurfaceOpen,
  onSkillOpen,
  onNavigate,
}: MarkdownProps) {
  const screenHref = useScreenHref();
  const agentPath = (target: { readonly daemonId: string; readonly sessionId: string }): string | undefined =>
    screenHref(target.daemonId, 'conversation', 'chat', { ferret: target.sessionId });
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
    attention: agendaReferenceResolver,
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
        {
          const to = agentPath(target);
          if (to !== undefined) onNavigate?.(to);
        }
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
        onAgendaOpen?.(target.id, opener);
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
        return onNavigate !== undefined && agentPath(target) !== undefined;
      case 'file':
        return onCodeReferenceOpen !== undefined;
      case 'task':
        return onTaskOpen !== undefined;
      case 'attention':
        return onAgendaOpen !== undefined;
      case 'surface':
        return onSurfaceOpen !== undefined;
      case 'skill':
        return onSkillOpen !== undefined;
    }
  };

  const destination = (target: ResolvedReference): string =>
    target.kind === 'agent' ? (agentPath(target) ?? referenceHref(target)) : referenceHref(target);

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

  const rendering: MarkdownRendering = {
    copyable,
    destination,
    enableFyRender,
    hasOpener,
    fences,
    onTaskOpen,
    referenceClick,
    trustedResolvers,
  };

  return (
    <div className={`md min-w-0 max-w-full ${className ?? ''}`}>
      <MarkdownRenderingContext.Provider value={rendering}>
        <ReactMarkdown
          components={demoteHeadings ? DEMOTED_HEADING_COMPONENTS : MARKDOWN_COMPONENTS}
          // remarkTableLabels stamps each body cell with its column header as
          // `data-label`, which the mobile stacked-card layout prints. It must run
          // after remark-gfm has produced the table nodes.
          // remarkFyRenderFences marks fences whose info string is EXACTLY the
          // token — the one place mdast still holds the metadata hast drops.
          // Marking unconditionally rather than behind `enableFyRender` keeps the
          // mark a statement about the DOCUMENT; whether it is acted on is the
          // surface's decision, made in `MarkdownPre`.
          remarkPlugins={[
            remarkGfm,
            remarkTableLabels,
            ...(enableFyRender ? (fences?.remark ?? []) : []),
            [remarkReferences, { resolvers: transformResolvers }],
          ]}
        >
          {text}
        </ReactMarkdown>
      </MarkdownRenderingContext.Provider>
    </div>
  );
});
