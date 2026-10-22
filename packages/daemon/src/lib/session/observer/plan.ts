import type { SessionId } from '../../session-id.ts';

/** How many dedicated session-worker threads a daemon starts before it pools sessions into them. */
export const DEFAULT_SESSION_WORKER_CAP = 8;

/** A worker the plan does not have yet: the supervisor starts one and gives it the session. */
export const NEW_WORKER = 'new';

/** One step of hosting: which session goes where, which leaves, and which threads end. */
export interface SessionWorkerPlan {
  readonly attach: readonly { readonly session: SessionId; readonly worker: number | typeof NEW_WORKER }[];
  readonly detach: readonly { readonly session: SessionId; readonly worker: number }[];
  /** Workers left hosting nothing. */
  readonly terminate: readonly number[];
}

/**
 * Which session runs on which worker, given the sessions that should be hosted and where they are now.
 *
 * ONE THREAD PER SESSION up to `cap` — the owner's "1 thread per agent". Past the cap no new threads: the
 * next session joins the least-loaded worker (ties to the lowest id), so a pooled worker is the same
 * program hosting more than one. When the hosted set falls back within the cap, ONE pooled session per
 * plan moves to a fresh dedicated worker — a move is a detach and an attach, and the observer re-derives,
 * which is what a restart does anyway. Pure: the supervisor executes it.
 */
export function planSessionWorkers(
  wanted: readonly SessionId[],
  hosted: ReadonlyMap<number, readonly SessionId[]>,
  cap: number,
): SessionWorkerPlan {
  const want = new Set(wanted);
  const detach: { session: SessionId; worker: number }[] = [];
  const load = new Map<number, number>();
  const placed = new Set<SessionId>();
  for (const [worker, sessions] of hosted) {
    let kept = 0;
    for (const session of sessions) {
      if (want.has(session)) {
        kept += 1;
        placed.add(session);
      } else detach.push({ session, worker });
    }
    load.set(worker, kept);
  }
  const terminate = [...load].filter(([, kept]) => kept === 0).map(([worker]) => worker);
  for (const worker of terminate) load.delete(worker);
  const attach: { session: SessionId; worker: number | typeof NEW_WORKER }[] = [];
  let threads = load.size;
  for (const session of wanted) {
    if (placed.has(session)) continue;
    placed.add(session);
    if (threads < cap) {
      attach.push({ session, worker: NEW_WORKER });
      threads += 1;
      continue;
    }
    const target = leastLoaded(load);
    if (target === undefined) continue;
    attach.push({ session, worker: target });
    load.set(target, (load.get(target) ?? 0) + 1);
  }
  const pooled = mostLoaded(load);
  if (attach.length === 0 && threads < cap && pooled !== undefined && (load.get(pooled) ?? 0) > 1) {
    const session = (hosted.get(pooled) ?? []).filter(candidate => want.has(candidate)).at(-1);
    if (session !== undefined) {
      detach.push({ session, worker: pooled });
      attach.push({ session, worker: NEW_WORKER });
    }
  }
  return { attach, detach, terminate };
}

function leastLoaded(load: ReadonlyMap<number, number>): number | undefined {
  let best: number | undefined;
  for (const [worker, sessions] of load)
    if (best === undefined || sessions < (load.get(best) ?? 0) || (sessions === load.get(best) && worker < best))
      best = worker;
  return best;
}

function mostLoaded(load: ReadonlyMap<number, number>): number | undefined {
  let best: number | undefined;
  for (const [worker, sessions] of load)
    if (best === undefined || sessions > (load.get(best) ?? 0) || (sessions === load.get(best) && worker < best))
      best = worker;
  return best;
}
