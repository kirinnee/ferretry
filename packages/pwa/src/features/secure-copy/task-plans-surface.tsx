/**
 * Settings › Secure copy › Task plans: the plans that are live on this machine, with one tap to end a line or the whole
 * plan. Revoking needs no passkey, because it only narrows. Plans live in the daemon's memory, so a restart forgets
 * them all; the names come from the secrets-gated plan route, like the card's.
 */

import type { TaskPlan } from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  approvedTick,
  failureWords,
  HONEST_CLIENT_LINE,
  isForbidden,
  isPlanLive,
  LINE_STATE_WORDS,
  lineTitle,
  listTaskPlans,
  NO_ACCOUNTS_DEVICE_WORDS,
  remainingOf,
  revokeLines,
  type TaskPlanClient,
  timeWords,
  usesLeftWords,
} from '../../lib/task-plan.ts';
import { ApprovedFacts } from './task-plan-card.tsx';

interface TaskPlansCardProps {
  readonly plans: readonly TaskPlan[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly onRevoke: (plan: TaskPlan, lines?: readonly number[]) => void;
}

export function TaskPlansCard({ plans, busy, error, onRevoke }: TaskPlansCardProps) {
  const live = plans.filter(isPlanLive);
  return (
    <section className="kt-panel p-panel" aria-label="Task plans" data-task-plans="">
      <h3 className="m-0 text-row font-semibold text-fg">Task plans</h3>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">
        What a ferret may sign in or paste without asking, from a plan you approved. They end on time and when this
        machine restarts.
      </p>
      <p className="mb-0 mt-1 text-meta text-muted" data-task-plans-honest="">
        {HONEST_CLIENT_LINE}
      </p>
      {error === null ? null : (
        <p className="mb-0 mt-2 text-ui text-err" data-task-plans-error="" role="alert">
          {error}
        </p>
      )}
      {live.length === 0 ? (
        <p className="mb-0 mt-3 text-ui text-faint" data-task-plans-empty="">
          No live task plans. Every sign-in and paste asks you.
        </p>
      ) : (
        <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
          {live.map(plan => (
            <li
              className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
              data-task-plans-plan={plan.id}
              key={`${plan.sessionId}/${plan.id}`}
            >
              <p className="m-0 text-ui font-medium text-fg">
                {plan.state === 'pending' ? 'Waiting for you' : 'Allowed'} until{' '}
                <span className="mono">{timeWords(plan.expiresAt)}</span>
              </p>
              <p className="m-0 text-meta text-faint">Session {plan.sessionId.slice(-8)}</p>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {plan.lines.map(line => {
                  const left = remainingOf(line);
                  return (
                    <li className="flex min-w-0 flex-col gap-1" data-task-plans-line={line.line} key={line.line}>
                      <span className="min-w-0 break-words text-ui text-fg">
                        <span className="text-muted">Line {line.line + 1} · </span>
                        {lineTitle(line, approvedTick(line))}
                      </span>
                      <ApprovedFacts line={line} />
                      <span className="text-meta text-muted">
                        {LINE_STATE_WORDS[line.state]}
                        {line.state === 'approved' && left !== undefined ? ` · ${usesLeftWords(left, line.uses)}` : ''}
                      </span>
                      {plan.state === 'approved' && line.state === 'approved' ? (
                        <button
                          className="kt-btn min-h-[44px] self-start"
                          data-task-plans-revoke={line.line}
                          disabled={busy}
                          onClick={() => onRevoke(plan, [line.line])}
                          type="button"
                        >
                          Revoke line {line.line + 1}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <button
                className="kt-btn min-h-[44px] self-start"
                data-task-plans-revoke-all={plan.id}
                disabled={busy}
                onClick={() => onRevoke(plan)}
                type="button"
              >
                {plan.state === 'pending' ? 'End this plan' : 'Revoke all'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TaskPlansSurface({
  connection,
  createClient,
}: {
  readonly connection: DaemonConnection;
  readonly createClient: (connection: DaemonConnection) => Promise<TaskPlanClient>;
}) {
  const [client, setClient] = useState<TaskPlanClient | null>(null);
  const [plans, setPlans] = useState<readonly TaskPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setClient(null);
    setPlans(null);
    setError(null);
    void createClient(connection)
      .then(async next => {
        const list = await listTaskPlans(next);
        if (!current) return;
        setClient(next);
        setPlans(list.plans);
      })
      .catch(cause => {
        if (!current) return;
        setError(
          isForbidden(cause)
            ? NO_ACCOUNTS_DEVICE_WORDS
            : `This browser could not read this daemon’s task plans: ${failureWords(cause)}`,
        );
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const revoke = useCallback(
    async (plan: TaskPlan, lines?: readonly number[]): Promise<void> => {
      if (client === null) return;
      setBusy(true);
      setError(null);
      try {
        await revokeLines(client, plan, lines);
        setPlans((await listTaskPlans(client)).plans);
      } catch (cause) {
        setError(failureWords(cause));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  if (plans === null && error === null)
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading task plans">
        <p className="m-0 text-ui text-faint">Reading this daemon’s task plans…</p>
      </section>
    );
  return (
    <TaskPlansCard busy={busy} error={error} onRevoke={(plan, lines) => void revoke(plan, lines)} plans={plans ?? []} />
  );
}
