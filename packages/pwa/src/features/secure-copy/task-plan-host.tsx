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
import { useApproveTaskPlanStepUp, useDaemonClient } from '../../lib/store.tsx';
import {
  type ApprovalOutcome,
  type ApprovalPorts,
  dropStage,
  failureWords,
  isForbidden,
  listTaskPlans,
  NO_ACCOUNTS_DEVICE_WORDS,
  readStage,
  revokeLines,
  runApproval,
  runMachineConfirm,
  type TaskPlanClient,
} from '../../lib/task-plan.ts';
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
  const [staged, setStaged] = useState<
    { readonly stage: string; readonly summary: readonly string[]; readonly codes: readonly number[] } | undefined
  >(undefined);
  const [forbidden, setForbidden] = useState(false);
  const [reads, setReads] = useState(0);
  const settled = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` re-runs the read after an answer
  useEffect(() => {
    if (!offered || planId === undefined) return undefined;
    let current = true;
    setForbidden(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (client: TaskPlanClient): Promise<void> => {
      try {
        const { plans } = await listTaskPlans(client);
        const plan = plans.find(each => each.sessionId === sessionId && each.id === planId);
        if (!current) return;
        setFound(plan === undefined ? null : { client, plan });
        // A waiting plan is watched: the machine can stage a selection for this card at any moment.
        if (plan?.state === 'pending') timer = setTimeout(() => void read(client), POLL_MS);
      } catch (cause) {
        // A device that can't see accounts is refused every time: say so once and stop asking.
        if (!current) return;
        if (isForbidden(cause)) setForbidden(true);
        else timer = setTimeout(() => void read(client), POLL_MS * 3);
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
  const foundClient = found?.client;
  const foundPlanId = found?.plan.id;
  const foundSessionId = found?.plan.sessionId;
  // Read once per stage: a poll that hands back the same stage keeps the summary on screen.
  useEffect(() => {
    if (foundClient === undefined || foundPlanId === undefined || foundSessionId === undefined || stage === undefined)
      return undefined;
    let current = true;
    void readStage(foundClient, { id: foundPlanId, sessionId: foundSessionId }, stage).then(
      view => {
        if (current) setStaged({ stage, summary: view.summary, codes: view.codes });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [foundClient, foundPlanId, foundSessionId, stage]);
  const stagedRead = staged !== undefined && staged.stage === stage ? staged : undefined;

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
  const paste =
    item.copyPlan === undefined ? null : (
      <CopyPlanHost
        connection={connection}
        item={item}
        sessionId={sessionId}
        {...(agentName === undefined ? {} : { agentName })}
        {...(injected === undefined ? {} : { createClient: injected })}
      />
    );
  if (!offered) return paste;
  if (forbidden)
    return (
      <div className="flex min-w-0 flex-col gap-3" data-task-plan-forbidden="">
        <p className="m-0 text-ui text-warn" role="status">
          {NO_ACCOUNTS_DEVICE_WORDS}
        </p>
        {paste}
      </div>
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
      machineCodes={stagedRead?.codes}
      machineSummary={stagedRead?.summary}
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
