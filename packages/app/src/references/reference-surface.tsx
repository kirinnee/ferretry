/**
 * ONE reference surface per ferret, shared by every Markdown reader in it.
 *
 * The reference standard is only one standard if the transcript, a notice, task prose, Agenda prose, a file preview
 * and the composer's preview all read the same grammar, ask the same resolvers, and open the same destinations.
 * Passing six props down six different trees would guarantee they drift, so the surface is assembled ONCE where the
 * daemon client and the ferret live (the chat screen), and every reader takes it from context.
 *
 * PROOF IS STILL PER-KIND, AND ABSENCE IS HONEST. A resolver is supplied only when this ferret can actually prove that
 * kind, and a kind with no opener renders as prose rather than as a link that goes nowhere. A surface with nothing wired
 * is exactly the default value of this context, which is why the default is an empty object and not a set of stubs.
 *
 * MULTI-DAEMON. The surface is built for one daemon: the agent resolver stamps its daemon onto every answer, and every
 * click destination is in that daemon, so a reference in one daemon's transcript cannot open another daemon's file,
 * terminal or ferret.
 *
 * What stays with the chat screen: the BUILDER that assembles a surface from a ferret's fleet slice, its cards, its
 * agenda ledger, skills, terminals and browser (today's `sessionReferenceSurface`). It reads those through their owners'
 * contracts, which the shell does not import.
 */

import { createContext, type ReactNode, useContext } from 'react';
import type { MarkdownProps } from '../prose/markdown.tsx';

/** Everything a Markdown reader needs to prove and to open a reference. */
export type ReferenceSurface = Omit<MarkdownProps, 'text' | 'className' | 'copyable'>;

/** Nothing proved and nothing openable: reference-shaped text stays prose. */
const NO_SURFACE: ReferenceSurface = {};

const ReferenceSurfaceContext = createContext<ReferenceSurface>(NO_SURFACE);

/** The surface this reader sits in, or the honest empty one outside a ferret. */
export const useReferenceSurface = (): ReferenceSurface => useContext(ReferenceSurfaceContext);

export function ReferenceSurfaceProvider({
  surface,
  children,
}: {
  readonly surface: ReferenceSurface;
  readonly children: ReactNode;
}) {
  return <ReferenceSurfaceContext.Provider value={surface}>{children}</ReferenceSurfaceContext.Provider>;
}
