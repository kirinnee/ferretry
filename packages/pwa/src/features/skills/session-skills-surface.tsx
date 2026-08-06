/**
 * Skills, bound to one live pairing and one live composer.
 *
 * `SkillsSurface` is deliberately hostless — it takes a loader and an insert
 * callback so a test and the harness render exactly the rows a reader sees. That
 * leaves someone to supply the two real halves, and this is that someone. It
 * exists so the session workspace mounts skills with ONE element and no local
 * knowledge of how a catalog is fetched or how a draft is reached.
 *
 * BOTH HALVES ARE SCOPED THE SAME WAY. The catalog comes from the daemon that
 * owns this session, and the invocation is delivered to the composer registered
 * under this exact `(daemonId, sessionId)` pair. A skill name is not global: two
 * paired daemons routinely run the same session id over entirely unrelated skill
 * directories, so a catalog read from the wrong daemon would offer names the
 * agent cannot invoke, and a draft reached by guessing "the foreground composer"
 * would type them at a different agent.
 *
 * THE ANNOUNCEMENT IS THE HOST'S WHEN THE HOST HAS NEWS. An insert that lands
 * gets the surface's own plain sentence. Anything else — no composer mounted, the
 * invocation already in the draft, a name the grammar refuses — is a fact only
 * the delivery half knows, so it is said in the same words every Add to chat uses.
 */

import { useCallback, useMemo } from 'react';

import { addReferenceMessage } from '../../lib/composer-references.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { type SkillsCatalogLoader, skillsCatalogLoader } from './skills-api.ts';
import { addSkillInvocationToComposer } from './skills-composer.ts';
import { SkillsSurface } from './skills-surface.tsx';

export interface SessionSkillsSurfaceProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /**
   * The session's ONE catalog read, from `useSessionSkills`. The workspace owns
   * it because the reference surface needs the same names to prove an inserted
   * `/floop` in the transcript, and two reads would be two owners of one fact.
   * Omitted, this surface reads the catalog itself — which is what the harness
   * and a focused test want, and what nothing in the workspace should do.
   */
  readonly loadCatalog?: SkillsCatalogLoader;
}

export function SessionSkillsSurface({ connection, scope, loadCatalog }: SessionSkillsSurfaceProps) {
  const load = useMemo(
    () => loadCatalog ?? skillsCatalogLoader(connection),
    // The connection is the identity the loader closes over, so a re-pairing
    // rebuilds it and the surface refetches. A fresh object with the same daemon
    // id does not, which is what keeps an unrelated parent render from
    // re-reading the catalog.
    [connection, loadCatalog],
  );
  const insert = useCallback(
    (invocation: string): string | undefined => {
      const outcome = addSkillInvocationToComposer(invocation, scope);
      return outcome === 'added' ? undefined : addReferenceMessage(outcome, invocation);
    },
    [scope],
  );
  return <SkillsSurface loadCatalog={load} onInsert={insert} scope={scope} />;
}
