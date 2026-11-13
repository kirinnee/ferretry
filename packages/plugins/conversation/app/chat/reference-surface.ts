/**
 * THE CHAT'S ONE REFERENCE SURFACE (today's `sessionReferenceSurface`): what every Markdown reader inside one ferret's
 * conversation proves and opens a reference with. The provider is the shell's (`@ferretry/app`); the builder is the
 * chat screen's, because only the chat knows the daemon, the ferret and what Conversation may read.
 *
 * PROOF IS STILL PER-KIND, AND ABSENCE IS HONEST (docs/reference-standard.md). A resolver is supplied only for a kind
 * this half can prove; every other kind stays prose rather than a link that goes nowhere. Conversation needs Ferrets
 * and Asks only, so the kinds other plugins own are not proved here:
 *
 *   - `:agent` ......... GAP(ferrets): today proved from the daemon's fleet slice through the protocol's addressing
 *     rule (`resolveAgentAddress`); 5.0's fleet list is Ferrets' summary and the rule is the Ferrets daemon's, with no
 *     contract export yet. Agent references stay prose.
 *   - `@file` .......... GAP(ferrets): proved through Ferrets' file routes (`files-api.ts`), the Ferrets app half's.
 *   - `&card`, `!ask`, `/skill`, `%terminal:`, `%browser:` ... their owners' renderers and catalogs (lead decision Q6,
 *     `reference.catalog`); not proved by the chat itself.
 *
 * `%terminal:` / `%browser:` keep the surface resolver with NO listing, which answers nothing either way — the one
 * honest state with no evidence. fy-render blocks draw through Conversation's own fences — only where `ChatProse`, the one
 * opt-in, names the capability; this surface never does, because it is spread into every Markdown in the chat — and a `card` block asks this
 * daemon's board. Every destination is in this daemon, so a reference cannot open another daemon's anything.
 */

import { createSurfaceReferenceResolver, type ReferenceSurface } from '@ferretry/app';
import { fyRenderFences } from '../render/fences.tsx';

export interface ChatReferenceSurfaceOptions {
  readonly daemonId: string;
  readonly ferretId: string;
  /** In-app navigation, for the one reference kind that IS a route. */
  readonly onNavigate?: (to: string) => void;
}

/** Assemble the surface one ferret's chat can honestly offer. Build once per daemon and ferret; keep it stable. */
export function chatReferenceSurface(options: ChatReferenceSurfaceOptions): ReferenceSurface {
  const { daemonId, ferretId, onNavigate } = options;
  return {
    fences: fyRenderFences({ cardEmbed: { daemon: daemonId } }),
    surfaceReferenceResolver: createSurfaceReferenceResolver({ daemonId, sessionId: ferretId }, undefined, undefined),
    ...(onNavigate === undefined ? {} : { onNavigate }),
  };
}
