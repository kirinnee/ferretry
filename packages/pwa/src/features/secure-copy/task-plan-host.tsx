/**
 * The task plan an agenda item points at (`taskPlan`), fetched and kept fresh. The card is drawn ONLY from that
 * daemon-set ref: a ferret's plain item with the same words draws plain. The plan is read from the secrets-gated plan
 * route by its id, so account names and usernames never come from the item's text. A machine that does not report
 * `task-plan.1` (an old daemon) gets today's paste-plan card for the item's `copyPlan`, or nothing.
 */

import { type AgendaItem, DAEMON_FEATURES, type TaskPlan } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { machineOffers } from '../../lib/daemon-health.ts';
import {
  type ApprovalOutcome,
  type ApprovalPorts,
  dropStage,
  failureWords,
  listTaskPlans,
  readStage,
  revokeLines,
  runApproval,
  runMachineConfirm,
  type TaskPlanClient,
} from '../../lib/task-plan.ts';
import { useApproveTaskPlanStepUp, useDaemonClient } from '../../lib/store.tsx';
import { useDaemonHealth } from '../../lib/use-daemon-health.ts';
import { CopyPlanHost } from './copy-plan-host.tsx';
import { TaskPlanCard, type TaskPlanPhase } from './task-plan-card.tsx';

const POLL_MS = 3_000;

export interface TaskPlanHostProps {
  readonly connection: DaemonConnection;
  readonly sessionId: string;
  readonly item: Pick<AgendaItem, 'taskPlan' | 'copyPlan'>;
  readonly agentName?: string;
  /** Hands in a client in place of the app store's (the harness and tests). */
  readonly createClient?: (connection: DaemonConnection) => Promise<TaskPlanClient>;
  /** Asks for the passkey bound to the stage, in place of the store's step-up (the harness and tests). */
  readonly askPasskey?: ApprovalPorts['askPasskey'];
  /** Says the machine offers `task-plan.1` without reading its health (the harness and tests). */
  readonly offered?: boolean;
  readonly onDone?: () => void;
}

export function TaskPlanHost({
  connection,
  sessionId,
  item,
  agentName,
  createClient: injected,
  askPasskey: injectedAsk,
  offered: injectedOffered,
  onDone,
}: TaskPlanHostProps) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const health = useDaemonHealth(injectedOffered === undefined ? connection : undefined);
  const askStage = useApproveTaskPlanStepUp();
  const offered = injectedOffered ?? machineOffers(health, DAEMON_FEATURES.taskPlan);
  const unknown = injectedOffered === undefined && health.kind === 'loading';
  const planId = item.taskPlan?.planId;

  const askPasskey = useMemo<ApprovalPorts['askPasskey']>(
    () => injectedAsk ?? (askStage === undefined ? undefined : (stage, words) => askStage(connection, stage, words)),
    [askStage, connection, injectedAsk],
  );

  const [found, setFound] = useState<{ readonly client: TaskPlanClient; readonly plan: TaskPlan } | null>(null);
  const [phase, setPhase] = useState<TaskPlanPhase>({ kind: 'idle' });
  const [summary, setSummary] = useState<readonly string[] | undefined>(undefined);
  const [reads, setReads] = useState(0);
  const settled = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` re-runs the read after an answer
  useEffect(() => {
    if (!offered || planId === undefined) return undefined;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (client: TaskPlanClient): Promise<void> => {
      try {
        const { plans } = await listTaskPlans(client);
        const plan = plans.find(each => each.sessionId === sessionId && each.id === planId);
        if (!current) return;
        setFound(plan === undefined ? null : { client, plan });
        // A waiting plan is watched: the machine can stage a selection for this card at any moment.
        if (plan?.state === 'pending') timer = setTimeout(() => void read(client), POLL_MS);
      } catch {
        if (current) timer = setTimeout(() => void read(client), POLL_MS * 3);
      }
    };
    void createClient(connection)
      .then(client => (current ? read(client) : undefined))
      .catch(() => undefined);
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [offered, connection, createClient, sessionId, planId, reads]);

  const stage = found?.plan.machineStage?.stage;
  useEffect(() => {
    setSummary(undefined);
    if (found === null || stage === undefined) return undefined;
    let current = true;
    void readStage(found.client, found.plan, stage).then(
      view => {
        if (current) setSummary(view.summary);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [found, stage]);

  const finish = useCallback(
    (outcome: ApprovalOutcome): void => {
      if (outcome.kind === 'settled') {
        setPhase({ kind: 'idle' });
        setFound(held => (held === null ? held : { client: held.client, plan: outcome.plan }));
        if (!settled.current) {
          settled.current = true;
          onDone?.();
        }
      } else if (outcome.kind === 'dismissed') setPhase({ kind: 'dismissed' });
      else setPhase({ kind: 'failed', words: outcome.words });
    },
    [onDone],
  );

  if (planId === undefined || unknown) return null;
  if (!offered)
    return item.copyPlan === undefined ? null : (
      <CopyPlanHost
        connection={connection}
        item={item}
        sessionId={sessionId}
        {...(agentName === undefined ? {} : { agentName })}
        {...(injected === undefined ? {} : { createClient: injected })}
      />
    );
  if (found === null) return null;

  const { client, plan } = found;
  const ports: ApprovalPorts = {
    client,
    askPasskey,
    report: progress => setPhase({ kind: 'working', progress }),
  };
  return (
    <TaskPlanCard
      agentName={agentName ?? 'The ferret'}
      canUsePasskey={askPasskey !== undefined}
      machineSummary={summary}
      onApprove={approval => void runApproval(ports, plan, approval).then(finish)}
      onConfirmMachine={() => {
        if (stage !== undefined) void runMachineConfirm(ports, plan, stage).then(finish);
      }}
      onDenyMachine={() => {
        if (stage === undefined) return;
        setPhase({ kind: 'working', progress: 'staging' });
        void dropStage(client, plan, stage).then(
          () => {
            setPhase({ kind: 'idle' });
            setReads(count => count + 1);
          },
          cause => setPhase({ kind: 'failed', words: failureWords(cause) }),
        );
      }}
      onRevoke={lines => {
        setPhase({ kind: 'working', progress: 'committing' });
        void revokeLines(client, plan, lines).then(
          revoked => {
            setPhase({ kind: 'idle' });
            setFound({ client, plan: revoked });
          },
          cause => setPhase({ kind: 'failed', words: failureWords(cause) }),
        );
      }}
      phase={phase}
      plan={plan}
      key={plan.id}
    />
  );
}
