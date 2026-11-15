/**
 * THE CHAT'S ONE REFERENCE SURFACE (today's `sessionReferenceSurface`): what every Markdown reader inside one ferret's
 * conversation proves and opens a reference with. The provider is the shell's (`@ferretry/app`); the builder is the
 * chat screen's, because only the chat knows the daemon, the ferret and what Conversation may read.
 *
 * PROOF IS STILL PER-KIND, AND ABSENCE IS HONEST (docs/reference-standard.md). A resolver is supplied only for a kind
 * this half can prove; every other kind stays prose rather than a link that goes nowhere. Conversation needs Ferrets
 * and Asks only, so the kinds other plugins own are not proved here:
 *
 *   - `:agent` ......... proved from this daemon's fleet through Ferrets' addressing rule (`provedAgentReference`, the
 *     rule the daemon applies to `fy send <name>`); an unread fleet, an unknown name and a name two ferrets hold prove
 *     nothing. Every answer carries THIS daemon, so a reference cannot open another daemon's ferret.
 *   - `@file` .......... proved by Ferrets' file proof (`resolveFilePaths`: a folder listing through the daemon's file
 *     route, which the `filesystem` grant and the agent fence decide) AND only where Ferrets' `ferrets.file-open` hook
 *     gives an opener. A refused listing, a denied, ignored or escaping entry, or no hook leaves the path as prose.
 *   - `&card`, `!ask`, `/skill`, `%terminal:`, `%browser:` ... their owners' renderers and catalogs (lead decision Q6,
 *     `reference.catalog`); not proved by the chat itself.
 *
 * `%terminal:` / `%browser:` keep the surface resolver with NO listing, which answers nothing either way — the one
 * honest state with no evidence. fy-render blocks draw through Conversation's own fences — only where `ChatProse`, the one
 * opt-in, names the capability; this surface never does, because it is spread into every Markdown in the chat — and a `card` block asks this
 * daemon's board; a media block's `src: @path` is read through the same client and the same grants an `@file` is proved
 * with. Every destination is in this daemon, so a reference cannot open another daemon's anything.
 */

import { createSurfaceReferenceResolver, type ReferenceSurface } from '@ferretry/app';
import { type FerretsFileOpen, provedAgentReference, resolveFilePaths } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { fyRenderFences } from '../render/fences.tsx';
import { readWorkspaceMedia } from '../render/fy-render-workspace-media.ts';
import type { ChatFleet } from './chat-fleet.ts';

export interface ChatReferenceSurfaceOptions {
  readonly daemonId: string;
  readonly ferretId: string;
  /** In-app navigation, for the one reference kind that IS a route. */
  readonly onNavigate?: (to: string) => void;
  /** This daemon's fleet; `undefined` is not read yet, and nothing is proved from it. */
  readonly fleet?: ChatFleet | undefined;
  /** This daemon's client: the `@file` proof and a media block's file read go through it, and nothing else does. */
  readonly client?: Pick<PluginClient, 'call'> | undefined;
  /** Ferrets' `ferrets.file-open` (narrowed); without it an `@file` has no opener and stays prose. */
  readonly fileOpen?: FerretsFileOpen | undefined;
  /** Brings the Files panel on screen after an opener asked for a path. */
  readonly showFiles?: (() => void) | undefined;
}

/** Assemble the surface one ferret's chat can honestly offer. Build once per daemon and ferret; keep it stable. */
export function chatReferenceSurface(options: ChatReferenceSurfaceOptions): ReferenceSurface {
  const { daemonId, ferretId, onNavigate, fleet, client, fileOpen, showFiles } = options;
  const cwd = fleet?.folders.get(ferretId);
  return {
    fences: fyRenderFences({
      cardEmbed: { daemon: daemonId },
      ...(client === undefined
        ? {}
        : {
            readWorkspaceMedia: async (path, signal, folder) =>
              await readWorkspaceMedia(client, ferretId, path, cwd, signal, folder),
          }),
    }),
    surfaceReferenceResolver: createSurfaceReferenceResolver({ daemonId, sessionId: ferretId }, undefined, undefined),
    ...(fleet === undefined
      ? {}
      : {
          agentReferenceResolver: lookup => {
            const proved = provedAgentReference(lookup, fleet.candidates);
            return proved === null ? null : { daemonId, sessionId: proved.id, name: proved.name };
          },
        }),
    ...(client === undefined || fileOpen === undefined
      ? {}
      : {
          resolveFilePaths: async (candidates, signal) =>
            new Map(await resolveFilePaths(client, ferretId, candidates, cwd, signal)),
          onCodeReferenceOpen: reference => {
            if (fileOpen.open(ferretId, reference.path)) showFiles?.();
          },
        }),
    ...(onNavigate === undefined ? {} : { onNavigate }),
  };
}
