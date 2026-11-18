/**
 * The task plan an ask points at (`task-plan`), fetched and kept fresh. The card is drawn ONLY from that daemon-set
 * ref: a ferret's plain ask with the same words draws plain. The plan is read from the secrets-gated plan route by its
 * id, so account names and usernames never come from the ask's text.
 */

import type { TaskPlan } from '../../../contract/routes/index.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { isStepUpRefusal } from '../../lib/step-up-refusal.ts';
import { ConfirmToSee } from '../confirm-to-see.tsx';
import { TaskPlanCard, type TaskPlanPhase } from './task-plan-card.tsx';

const POLL_MS = 3_000;

export interface TaskPlanHostProps {
  /** The Accounts client of the machine the ask is on. */
  readonly client: TaskPlanClient;
  /** The ferret the ask is about: a plan belongs to one ferret. */
  readonly ferret: string;
  readonly planId: string;
  readonly agentName?: string;
  /** Asks for the passkey bound to the stage; absent where this device cannot ask. */
  readonly askPasskey?: ApprovalPorts['askPasskey'];
  readonly onDone?: () => void;
}

export function TaskPlanHost({ client, ferret, planId, agentName, askPasskey, onDone }: TaskPlanHostProps) {
  const [found, setFound] = useState<TaskPlan | null>(null);
  const [phase, setPhase] = useState<TaskPlanPhase>({ kind: 'idle' });
  const [staged, setStaged] = useState<
    { readonly stage: string; readonly summary: readonly string[]; readonly codes: readonly number[] } | undefined
  >(undefined);
  const [forbidden, setForbidden] = useState(false);
  /** The daemon wants the owner's step-up to show this plan; the quiet read did not ask for it. */
  const [locked, setLocked] = useState(false);
  const [reads, setReads] = useState(0);
  const settled = useRef(false);
  /** Set by the owner's press on "Confirm it's you": the next read is theirs, so it may ask for the passkey. */
  const pressed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` re-runs the read after an answer
  useEffect(() => {
    let current = true;
    setForbidden(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (quiet: boolean): Promise<void> => {
      try {
        const { plans } = await listTaskPlans(client, { quiet });
        const plan = plans.find(each => each.sessionId === ferret && each.id === planId);
        if (!current) return;
        setLocked(false);
        setFound(plan ?? null);
        // A waiting plan is watched: the machine can stage a selection for this card at any moment.
        if (plan?.state === 'pending') timer = setTimeout(() => void read(true), POLL_MS);
      } catch (cause) {
        if (!current) return;
        // The page's own read is quiet: a step-up the daemon wants waits for the owner's press, not for opening the chat.
        if (isStepUpRefusal(cause)) {
          // The unlock ran out while the card was on screen: what it showed is dropped, not just hidden.
          setLocked(true);
          setFound(null);
          setStaged(undefined);
        }
        // A device that can't see accounts is refused every time: say so once and stop asking.
        else if (isForbidden(cause)) setForbidden(true);
        else timer = setTimeout(() => void read(true), POLL_MS * 3);
      }
    };
    const owned = pressed.current;
    pressed.current = false;
    void read(!owned);
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, ferret, planId, reads]);

  const stage = found?.machineStage?.stage;
  const foundPlanId = found?.id;
  const foundSessionId = found?.sessionId;
  // Read once per stage: a poll that hands back the same stage keeps the summary on screen.
  useEffect(() => {
    if (foundPlanId === undefined || foundSessionId === undefined || stage === undefined) return undefined;
    let current = true;
    void readStage(client, { id: foundPlanId, sessionId: foundSessionId }, stage, { quiet: true }).then(
      view => {
        if (current) setStaged({ stage, summary: view.summary, codes: view.codes });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client, foundPlanId, foundSessionId, stage]);
  const stagedRead = staged !== undefined && staged.stage === stage ? staged : undefined;

  const finish = useCallback(
    (outcome: ApprovalOutcome): void => {
      if (outcome.kind === 'settled') {
        setPhase({ kind: 'idle' });
        setFound(held => (held === null ? held : outcome.plan));
        if (!settled.current) {
          settled.current = true;
          onDone?.();
        }
      } else if (outcome.kind === 'dismissed') setPhase({ kind: 'dismissed' });
      else setPhase({ kind: 'failed', words: outcome.words });
    },
    [onDone],
  );

  if (locked)
    return (
      <ConfirmToSee
        onConfirm={() => {
          pressed.current = true;
          setReads(count => count + 1);
        }}
      />
    );
  if (forbidden)
    return (
      <div className="flex min-w-0 flex-col gap-3" data-task-plan-forbidden="">
        <p className="m-0 text-ui text-warn" role="status">
          {NO_ACCOUNTS_DEVICE_WORDS}
        </p>
      </div>
    );
  if (found === null) return null;

  const plan = found;
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
            setFound(revoked);
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
