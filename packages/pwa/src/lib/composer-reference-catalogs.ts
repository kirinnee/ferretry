/**
 * One session-scoped catalog feeding both composer autocomplete and Markdown proof.
 *
 * Tasks, Attention and skills are each daemon facts. A standalone reader can
 * hydrate all three once; the session page instead supplies tasks and skills
 * from their existing workspace owners and this module reads only Attention.
 * Either way, preview and autocomplete receive the same arrays. A failed family
 * stays `undefined`: that is "not proved", never an empty daemon fact.
 */
import {
  type AttentionItem,
  AttentionSnapshotSchema,
  type IFyApiClient,
  type SessionSkills,
  SessionSkillsSchema,
  SessionTaskListResponseSchema,
  type TaskSummary,
} from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ComposerReferenceCatalogFamily = 'tasks' | 'attention' | 'skills';
type ComposerReferenceTask = Pick<TaskSummary, 'id' | 'title' | 'status'>;

export interface ComposerReferenceCatalogs {
  readonly tasks?: readonly ComposerReferenceTask[];
  readonly attention?: readonly AttentionItem[];
  readonly skills?: SessionSkills;
  readonly failures: Readonly<Partial<Record<ComposerReferenceCatalogFamily, string>>>;
}

type ComposerReferenceCatalogPatch = Partial<Pick<ComposerReferenceCatalogs, 'tasks' | 'attention' | 'skills'>> & {
  readonly failures: Readonly<Partial<Record<ComposerReferenceCatalogFamily, string>>>;
};

export type ComposerReferenceCatalogReader = Pick<IFyApiClient, 'request'>;

/** Existing workspace owners a session page shares with the composer bundle. */
export interface ComposerReferenceCatalogSources {
  readonly tasks: readonly ComposerReferenceTask[] | undefined;
  readonly skills: SessionSkills | undefined;
  readonly taskFailure?: string;
  readonly skillFailure?: string;
  readonly waitForTasks: () => Promise<void> | undefined;
  readonly waitForSkills: () => Promise<void> | undefined;
}

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * One literal path per family, spelled out.
 *
 * A `${suffix}` helper reads as `/v1/sessions/*​/*` to `route-agreement.sh`, and
 * a client path the gate cannot read is a client path nothing checks against the
 * daemon's route table — which is the whole defect that gate exists to catch. So
 * the final segment is a literal at each call site, and the gate can see all
 * three.
 */
const sessionTasksPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`;
const sessionAttentionPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/attention`;
const sessionSkillsPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/skills`;

const sameSession = <Value extends { readonly sessionId: string }>(sessionId: string, value: Value): Value => {
  if (value.sessionId !== sessionId) throw new Error(`daemon returned ${value.sessionId} while reading ${sessionId}`);
  return value;
};

/**
 * Start all three reads once, then report each family from those same promises.
 * A slow sibling cannot withhold a proved family from the page, while the final
 * promise still represents the one complete in-flight host read menus await.
 */
async function readComposerReferenceCatalogsIncrementally(
  client: ComposerReferenceCatalogReader,
  sessionId: string,
  signal: AbortSignal,
  publish: (patch: ComposerReferenceCatalogPatch) => void,
): Promise<ComposerReferenceCatalogs> {
  const tasks = client
    .request(sessionTasksPath(sessionId), SessionTaskListResponseSchema, { signal })
    .then(value => sameSession(sessionId, value));
  const attention = client
    .request(sessionAttentionPath(sessionId), AttentionSnapshotSchema, { signal })
    .then(value => sameSession(sessionId, value));
  const skills = client.request(sessionSkillsPath(sessionId), SessionSkillsSchema, { signal });
  const publishIfLive = (patch: ComposerReferenceCatalogPatch): void => {
    if (!signal.aborted) publish(patch);
  };
  const reportedTasks = tasks.then(
    value => {
      publishIfLive({ tasks: value.tasks, failures: {} });
      return value;
    },
    reason => {
      publishIfLive({ failures: { tasks: failureMessage(reason) } });
      throw reason;
    },
  );
  const reportedAttention = attention.then(
    value => {
      publishIfLive({ attention: value.items, failures: {} });
      return value;
    },
    reason => {
      publishIfLive({ failures: { attention: failureMessage(reason) } });
      throw reason;
    },
  );
  const reportedSkills = skills.then(
    value => {
      publishIfLive({ skills: value, failures: {} });
      return value;
    },
    reason => {
      publishIfLive({ failures: { skills: failureMessage(reason) } });
      throw reason;
    },
  );
  const settled = await Promise.allSettled([reportedTasks, reportedAttention, reportedSkills] as const);
  if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

  const [taskResult, attentionResult, skillResult] = settled;
  const failures: Partial<Record<ComposerReferenceCatalogFamily, string>> = {};
  if (taskResult.status === 'rejected') failures.tasks = failureMessage(taskResult.reason);
  if (attentionResult.status === 'rejected') failures.attention = failureMessage(attentionResult.reason);
  if (skillResult.status === 'rejected') failures.skills = failureMessage(skillResult.reason);
  return {
    ...(taskResult.status === 'fulfilled' ? { tasks: taskResult.value.tasks } : {}),
    ...(attentionResult.status === 'fulfilled' ? { attention: attentionResult.value.items } : {}),
    ...(skillResult.status === 'fulfilled' ? { skills: skillResult.value } : {}),
    failures,
  };
}

/** Attention is the only family the session page has no existing owner for. */
async function readComposerAttentionIncrementally(
  client: ComposerReferenceCatalogReader,
  sessionId: string,
  signal: AbortSignal,
  publish: (patch: ComposerReferenceCatalogPatch) => void,
): Promise<void> {
  const attention = client
    .request(sessionAttentionPath(sessionId), AttentionSnapshotSchema, { signal })
    .then(value => sameSession(sessionId, value));
  await attention.then(
    value => {
      if (!signal.aborted) publish({ attention: value.items, failures: {} });
    },
    reason => {
      if (!signal.aborted) publish({ failures: { attention: failureMessage(reason) } });
      throw reason;
    },
  );
  if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Read all independently: one refused family must not erase two valid ones. */
export async function readComposerReferenceCatalogs(
  client: ComposerReferenceCatalogReader,
  sessionId: string,
  signal: AbortSignal,
): Promise<ComposerReferenceCatalogs> {
  return await readComposerReferenceCatalogsIncrementally(client, sessionId, signal, () => undefined);
}

const EMPTY_CATALOGS: ComposerReferenceCatalogs = Object.freeze({ failures: Object.freeze({}) });

const mergeCatalogPatch = (
  current: ComposerReferenceCatalogs,
  patch: ComposerReferenceCatalogPatch,
): ComposerReferenceCatalogs => ({
  ...current,
  ...(patch.tasks === undefined ? {} : { tasks: patch.tasks }),
  ...(patch.attention === undefined ? {} : { attention: patch.attention }),
  ...(patch.skills === undefined ? {} : { skills: patch.skills }),
  failures: { ...current.failures, ...patch.failures },
});

/**
 * Hydrate on concrete session identity and fence late answers after navigation.
 * Tests and partial hosts may omit `request`; they then prove no catalog facts.
 */
export function useComposerReferenceCatalogs(
  client: Partial<ComposerReferenceCatalogReader>,
  sessionId: string,
  sources?: ComposerReferenceCatalogSources,
): ComposerReferenceCatalogs & {
  /**
   * All in-flight owner reads for THIS session, or nothing once they settle.
   *
   * It exists for the race a reader hits on the first message of every session:
   * a menu opened while the page is still reading would otherwise offer an
   * invented empty list, or — for skills — make the composer issue its own
   * second request for exactly what is already being fetched. Awaiting their
   * aggregate is what makes "one read per fact" true rather than intended.
   */
  readonly settled: () => Promise<void> | undefined;
} {
  const [snapshot, setSnapshot] = useState<{
    readonly sessionId: string;
    readonly catalogs: ComposerReferenceCatalogs;
  } | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const settled = useCallback((): Promise<void> | undefined => {
    const waits: Promise<void>[] = [];
    if (pending.current !== null) waits.push(pending.current);
    const current = sourcesRef.current;
    const tasks = current?.waitForTasks();
    const skills = current?.waitForSkills();
    if (tasks !== undefined) waits.push(tasks);
    if (skills !== undefined) waits.push(skills);
    return waits.length === 0 ? undefined : Promise.allSettled(waits).then(() => undefined);
  }, []);
  const usesSharedSources = sources !== undefined;

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    if (typeof client.request !== 'function') {
      pending.current = null;
      return () => controller.abort();
    }
    const publish = (patch: ComposerReferenceCatalogPatch): void => {
      setSnapshot(current => ({
        sessionId,
        catalogs: mergeCatalogPatch(current?.sessionId === sessionId ? current.catalogs : EMPTY_CATALOGS, patch),
      }));
    };
    const operation = usesSharedSources
      ? readComposerAttentionIncrementally(
          client as ComposerReferenceCatalogReader,
          sessionId,
          controller.signal,
          publish,
        )
      : readComposerReferenceCatalogsIncrementally(
          client as ComposerReferenceCatalogReader,
          sessionId,
          controller.signal,
          publish,
        );
    const read = operation
      .then(() => undefined)
      .catch(() => {
        // Abort is expected on navigation. All non-abort family failures are
        // already published by their own family continuation above.
      })
      .finally(() => {
        if (pending.current === read) pending.current = null;
      });
    pending.current = read;
    return () => {
      controller.abort();
      pending.current = null;
    };
  }, [client, sessionId, usesSharedSources]);

  const owned = snapshot?.sessionId === sessionId ? snapshot.catalogs : EMPTY_CATALOGS;
  const catalogs = useMemo<ComposerReferenceCatalogs>(() => {
    if (sources === undefined) return owned;
    return {
      ...(sources.tasks === undefined ? {} : { tasks: sources.tasks }),
      ...(owned.attention === undefined ? {} : { attention: owned.attention }),
      ...(sources.skills === undefined ? {} : { skills: sources.skills }),
      failures: {
        ...(owned.failures.attention === undefined ? {} : { attention: owned.failures.attention }),
        ...(sources.taskFailure === undefined ? {} : { tasks: sources.taskFailure }),
        ...(sources.skillFailure === undefined ? {} : { skills: sources.skillFailure }),
      },
    };
  }, [owned, sources]);
  return useMemo(() => ({ ...catalogs, settled }), [catalogs, settled]);
}
