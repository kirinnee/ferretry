/**
 * One session-scoped read feeding both composer autocomplete and Markdown proof.
 *
 * Tasks, Attention and skills are each daemon facts. Reading them independently
 * in the preview and in autocomplete creates two freshness stories and doubles
 * the transport work, so the session host hydrates this bundle once and passes
 * the same arrays to both consumers. A failed family stays `undefined`: that is
 * "not proved", never an empty daemon fact.
 */
import {
  type AttentionItem,
  AttentionSnapshotSchema,
  type IFyApiClient,
  type ScopedTaskSummary,
  type SessionSkills,
  SessionSkillsSchema,
  SessionTaskListResponseSchema,
} from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ComposerReferenceCatalogFamily = 'tasks' | 'attention' | 'skills';

export interface ComposerReferenceCatalogs {
  readonly tasks?: readonly ScopedTaskSummary[];
  readonly attention?: readonly AttentionItem[];
  readonly skills?: SessionSkills;
  readonly failures: Readonly<Partial<Record<ComposerReferenceCatalogFamily, string>>>;
}

type ComposerReferenceCatalogPatch = Partial<Pick<ComposerReferenceCatalogs, 'tasks' | 'attention' | 'skills'>> & {
  readonly failures: Readonly<Partial<Record<ComposerReferenceCatalogFamily, string>>>;
};

export type ComposerReferenceCatalogReader = Pick<IFyApiClient, 'request'>;

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
): ComposerReferenceCatalogs & {
  /**
   * The one in-flight read for THIS session, or nothing once it has settled.
   *
   * It exists for the race a reader hits on the first message of every session:
   * a menu opened while the page is still reading would otherwise offer an
   * invented empty list, or — for skills — make the composer issue its own
   * second request for exactly what is already being fetched. Awaiting this is
   * what makes "one read per session" true rather than merely intended.
   */
  readonly settled: () => Promise<void> | undefined;
} {
  const [snapshot, setSnapshot] = useState<{
    readonly sessionId: string;
    readonly catalogs: ComposerReferenceCatalogs;
  } | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const settled = useCallback(() => pending.current ?? undefined, []);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    if (typeof client.request !== 'function') {
      pending.current = null;
      return () => controller.abort();
    }
    const read = readComposerReferenceCatalogsIncrementally(
      client as ComposerReferenceCatalogReader,
      sessionId,
      controller.signal,
      patch => {
        setSnapshot(current => ({
          sessionId,
          catalogs: mergeCatalogPatch(current?.sessionId === sessionId ? current.catalogs : EMPTY_CATALOGS, patch),
        }));
      },
    )
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
  }, [client, sessionId]);

  const catalogs = snapshot?.sessionId === sessionId ? snapshot.catalogs : EMPTY_CATALOGS;
  return useMemo(() => ({ ...catalogs, settled }), [catalogs, settled]);
}
