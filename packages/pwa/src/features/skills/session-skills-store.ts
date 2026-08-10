/**
 * ONE skills catalog per session, read once and used by both halves.
 *
 * Two things in a session workspace need this session's skill names, and they
 * need them at different moments. The Skills pane needs the whole catalog when
 * the reader opens it. The session's reference surface needs the NAMES from the
 * moment the session is on screen, because a `/floop` the reader just inserted
 * has to prove itself in the transcript whether or not that pane was ever
 * opened — an unproved skill reference renders as prose, so the Use in chat
 * action would otherwise insert a token that goes nowhere.
 *
 * Two independent loads would be two owners of one fact, and the failure is not
 * hypothetical: they would answer at different times and, after a refresh, with
 * different content — a name proved in the transcript and absent from the pane,
 * or the reverse. So the read is owned HERE, once, and the pane is handed the
 * very same in-flight promise rather than a second loader that happens to point
 * at the same route.
 *
 * THE READ STARTS DURING RENDER, NOT IN AN EFFECT, and that is the whole reason
 * it is one read. React runs CHILD effects before parent ones, so a pane mounted
 * in the same commit asks its loader before a parent effect could have started
 * anything — and both would fetch. Render order is the opposite: this hook runs
 * before the pane exists, so the promise is already there to be joined.
 *
 * WHAT IS NOT KNOWN IS NOT EMPTY. `names` is `undefined` until a catalog has
 * actually been read, and is undefined again the moment the session changes,
 * because the answer is keyed by the session it came from. An empty array would
 * tell the reference surface that this session has no skills, which turns "we
 * have not asked yet" into a proof of absence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey, daemonSessionScope } from '../../lib/daemon-scope.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import { type SkillsCatalogLoader, skillsCatalogLoader } from './skills-api.ts';
import type { SkillsCatalog } from './skills-catalog.ts';

export interface SessionSkillsRead {
  /**
   * The names this session can prove, or `undefined` while unread. They are NOT
   * case-folded here: `sessionReferenceSurface` owns that normalisation, and
   * doing it twice would be two answers to "is this the same name".
   */
  readonly names: readonly string[] | undefined;
  /** The same proved catalog the names and pane share, or undefined while unread. */
  readonly catalog: SkillsCatalog | undefined;
  /** The read already in flight for this session, without consuming the pane's one join. */
  readonly settled: () => Promise<void> | undefined;
  /**
   * The loader the pane is given. Its first call for a session joins the read
   * this hook already started; every later call is a real refresh.
   */
  readonly load: SkillsCatalogLoader;
}

interface SharedRead {
  readonly key: string;
  readonly read: Promise<SkillsCatalog>;
  readonly controller: AbortController;
  /** Whether the one join has been spent. The next asker is a refresh. */
  handedOut: boolean;
  /** Whether callers still need to await this read. */
  pending: boolean;
}

/** This session's catalog, owned once and shared with the pane that shows it. */
export function useSessionSkills(
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher?: DaemonFetch,
): SessionSkillsRead {
  // The answer carries the session it describes, so a session change makes it
  // stale by construction rather than by remembering to clear it.
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly catalog: SkillsCatalog;
    readonly names: readonly string[];
  } | null>(null);
  // The identity is read as two primitives so the read re-runs on a real daemon
  // or session change and not merely because a parent re-rendered with a fresh
  // scope object.
  const { daemonId, sessionId } = scope;
  const key = daemonSessionKey({ daemonId, sessionId });
  const loader = useMemo(
    () => (fetcher === undefined ? skillsCatalogLoader(connection) : skillsCatalogLoader(connection, fetcher)),
    [connection, fetcher],
  );

  // A read of the session this hook is holding updates the shared answer. A read
  // of any other session still gets its result — the pane asked for it — but must
  // not become what the transcript proves against, which would prove one
  // session's invocations from another session's catalog.
  const start = useCallback<SkillsCatalogLoader>(
    (target, signal) =>
      loader(target, signal).then(catalog => {
        if (daemonSessionKey(target) === key)
          setAnswer({ key, catalog, names: catalog.skills.map(skill => skill.name) });
        return catalog;
      }),
    [key, loader],
  );

  const shared = useRef<SharedRead | null>(null);
  if (shared.current === null || shared.current.key !== key) {
    const controller = new AbortController();
    const read = start(daemonSessionScope({ daemonId }, sessionId), controller.signal);
    const held = { key, read, controller, handedOut: false, pending: true };
    shared.current = held;
    // The rejection is still delivered to whoever asked, so the pane can say
    // what happened. This only stops an unawaited read from failing the process.
    void read.then(
      () => {
        held.pending = false;
      },
      () => {
        held.pending = false;
      },
    );
  }

  // `key` is in the list although the body never reads it: it is what decides
  // WHICH read this cleanup owns. Dropping it would leave the abort attached to
  // the first session forever, so switching sessions would abandon a live read
  // rather than cancel it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the session this cleanup belongs to
  useEffect(() => {
    const held = shared.current;
    return () => held?.controller.abort();
  }, [key]);

  const load = useCallback<SkillsCatalogLoader>(
    (target, signal) => {
      const held = shared.current;
      if (held?.key === daemonSessionKey(target) && !held.handedOut) {
        held.handedOut = true;
        return held.read;
      }
      return start(target, signal);
    },
    [start],
  );

  const settled = useCallback((): Promise<void> | undefined => {
    const held = shared.current;
    if (held?.key !== key || !held.pending) return undefined;
    return held.read.then(() => undefined);
  }, [key]);

  return {
    catalog: answer?.key === key ? answer.catalog : undefined,
    names: answer?.key === key ? answer.names : undefined,
    load,
    settled,
  };
}
