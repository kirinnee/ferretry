import {
  type CodeReference,
  findReferences,
  type ReferenceResolvers,
  type ReferenceSurface,
  type ResolvedReference,
  referenceHref,
  useReferenceSurface,
  useScreenHref,
} from '@ferretry/app';
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

/**
 * WHAT A REFERENCE CHIP NEEDS FROM THE MESSAGE IT IS IN: how to prove a token, how to re-prove it, where it goes and
 * how to open it. It is assembled ONCE per message from this ferret's reference surface (`useReferenceSurface`, the
 * shell's one surface), so the transcript, a notice and an agenda card prove references the same way; a chip reads it
 * from context and never takes a resolver prop of its own.
 *
 * PROOF IS PER KIND AND ABSENCE IS HONEST (docs/reference-standard.md §6). `resolvers` prove at paint; `trusted`
 * re-prove, with a file answering only for a path already resolved; a kind with no opener is prose. This is the Markdown
 * reader's own logic, ported so the two readers cannot disagree (the parity suite holds them to it).
 *
 * An `@file` is proved by listing the session's folder, which costs a request: the whole message's candidates go in
 * ONE call here (not one per chip), and an answer for the previous text never paints a link in the next.
 */
export interface ReferenceProof {
  /** Proves a token at paint. */
  readonly resolvers: ReferenceResolvers;
  /** Re-proves a painted link (at paint and again at click). */
  readonly trusted: ReferenceResolvers;
  readonly hasOpener: (target: ResolvedReference) => boolean;
  readonly destination: (target: ResolvedReference) => string;
  readonly open: (target: ResolvedReference, opener: HTMLElement | null) => void;
}

const ProofContext = createContext<ReferenceProof | null>(null);

/** The proof of the message being drawn, or `null` outside one (a reference is then the text it was written as). */
export const useReferenceProof = (): ReferenceProof | null => useContext(ProofContext);

const EMPTY_PATHS: ReadonlyMap<string, string> = new Map();

interface ResolvedPaths {
  readonly key: string;
  readonly paths: ReadonlyMap<string, string>;
}

/** The sentence a proved reference opens, by kind: the Markdown reader's own switch. */
function openReference(
  surface: ReferenceSurface,
  agentPath: (target: { readonly daemonId: string; readonly sessionId: string }) => string | undefined,
  target: ResolvedReference,
  opener: HTMLElement | null,
): void {
  switch (target.kind) {
    case 'agent': {
      const to = agentPath(target);
      if (to !== undefined) surface.onNavigate?.(to);
      return;
    }
    case 'file': {
      const reference: CodeReference = {
        path: target.path,
        ...(target.line === undefined ? {} : { line: target.line }),
        ...(target.endLine === undefined ? {} : { endLine: target.endLine }),
      };
      surface.onCodeReferenceOpen?.(reference, opener);
      return;
    }
    case 'task':
      surface.onTaskOpen?.(target.id, opener);
      return;
    case 'attention':
      surface.onAgendaOpen?.(target.id, opener);
      return;
    case 'surface':
      surface.onSurfaceOpen?.(target, opener);
      return;
    case 'skill':
      surface.onSkillOpen?.(target.name, opener);
      return;
  }
}

function openerOf(surface: ReferenceSurface, agentPath: (t: never) => string | undefined) {
  return (target: ResolvedReference): boolean => {
    switch (target.kind) {
      // A proved agent whose destination cannot be reached is still a dead link: the click is intercepted.
      case 'agent':
        return surface.onNavigate !== undefined && agentPath(target as never) !== undefined;
      case 'file':
        return surface.onCodeReferenceOpen !== undefined;
      case 'task':
        return surface.onTaskOpen !== undefined;
      case 'attention':
        return surface.onAgendaOpen !== undefined;
      case 'surface':
        return surface.onSurfaceOpen !== undefined;
      case 'skill':
        return surface.onSkillOpen !== undefined;
    }
  };
}

/** Provides the proof of ONE message's `text` to every chip and code span under it. */
export function ReferenceProofProvider({ text, children }: { readonly text: string; readonly children: ReactNode }) {
  const surface = useReferenceSurface();
  const screenHref = useScreenHref();
  const { resolveFilePaths, onCodeReferenceOpen } = surface;
  const candidates = useMemo(
    () => [
      ...new Set(
        findReferences(text).flatMap(match => (match.reference.kind === 'file' ? [match.reference.path] : [])),
      ),
    ],
    [text],
  );
  const key = JSON.stringify(candidates);
  const [resolved, setResolved] = useState<ResolvedPaths | null>(null);

  useEffect(() => {
    if (!resolveFilePaths || !onCodeReferenceOpen || candidates.length === 0) return undefined;
    const controller = new AbortController();
    void resolveFilePaths(candidates, controller.signal)
      .then(paths => {
        if (!controller.signal.aborted) setResolved({ key, paths });
      })
      .catch(() => {
        // Resolution is an enhancement, never a reason prose should fail to render.
        if (!controller.signal.aborted) setResolved({ key, paths: EMPTY_PATHS });
      });
    return () => controller.abort();
  }, [candidates, key, onCodeReferenceOpen, resolveFilePaths]);

  const paths = resolved?.key === key ? resolved.paths : EMPTY_PATHS;
  const value = useMemo<ReferenceProof>(() => {
    const canonical = new Set(paths.values());
    const resolvers: ReferenceResolvers = {
      agent: surface.agentReferenceResolver,
      file: path => paths.get(path) ?? null,
      task: surface.taskReferenceResolver,
      attention: surface.agendaReferenceResolver,
      surface: surface.surfaceReferenceResolver,
      skill: surface.skillReferenceResolver,
    };
    const agentPath = (target: { readonly daemonId: string; readonly sessionId: string }): string | undefined =>
      screenHref(target.daemonId, 'conversation', 'chat', { ferret: target.sessionId });
    return {
      resolvers,
      trusted: { ...resolvers, file: path => (canonical.has(path) ? path : null) },
      hasOpener: openerOf(surface, agentPath as never),
      destination: target =>
        target.kind === 'agent' ? (agentPath(target) ?? referenceHref(target)) : referenceHref(target),
      open: (target, opener) => openReference(surface, agentPath, target, opener),
    };
  }, [paths, screenHref, surface]);

  return <ProofContext.Provider value={value}>{children}</ProofContext.Provider>;
}

/**
 * THE ONE CLICK BEHAVIOUR, shared by chips and code decorations. A modified or non-primary click is the reader asking
 * the browser for a new tab and is never intercepted. The target is asked again before it acts: the fleet, the
 * filesystem and the board move while a transcript sits on screen.
 */
export const referenceClick =
  (proof: ReferenceProof, target: ResolvedReference, revalidate: (target: ResolvedReference) => boolean) =>
  (event: MouseEvent<HTMLAnchorElement>): void => {
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
    if (revalidate(target)) proof.open(target, event.currentTarget);
  };
