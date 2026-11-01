/**
 * A ferret's TASK PLAN, asked before it starts (docs/secure-copy.md, "Task plans"): the sign-ins and pastes it means to
 * make, grouped under the account each would use, in the daemon's words with the ferret's reason small beneath. The
 * owner ticks what it may do; NOTHING STARTS TICKED, and a sign-in line is approved with a passkey that is bound to
 * exactly the selection the daemon staged. Every name on this card (account, username, place) is a fact the daemon
 * resolved, never text the ferret wrote; nothing here is a value.
 */

import type { TaskPlan, TaskPlanCandidate, TaskPlanLine } from '@ferretry/protocol';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import {
  type ApprovalProgress,
  accountTakenElsewhere,
  allowBlockedWords,
  approvalOf,
  approvedAccountName,
  approvedCode,
  approvedTick,
  becauseWords,
  candidateName,
  clockWords,
  codeOnly,
  groupLines,
  HONEST_CLIENT_LINE,
  initialTicks,
  isPlanLive,
  LINE_STATE_WORDS,
  type LineTick,
  lineTitle,
  machineStageWords,
  mayTick,
  NO_HISTORY_WORDS,
  PICK_FIRST_WORDS,
  pickedCandidate,
  preselectWords,
  remainingOf,
  rootBadge,
  rootHost,
  rootTool,
  rootWords,
  STILL_ASKED,
  selectionProblem,
  settledWords,
  stagedCodeOn,
  stagedLines,
  type Ticks,
  TOTP_IMPOSSIBLE_WORDS,
  TOTP_TICK_WARNING,
  ticksNeedPasskey,
  timeWords,
  totpState,
  usesLeftWords,
  usesWords,
  withCode,
  withPick,
  withTicked,
} from '../../lib/task-plan.ts';

/** Where the owner's approval stands, as the host drives it. */
export type TaskPlanPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly progress: ApprovalProgress }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'failed'; readonly words: string };

export interface TaskPlanCardProps {
  readonly plan: TaskPlan;
  readonly agentName: string;
  readonly phase: TaskPlanPhase;
  /** The daemon's own summary of a selection staged at the machine, one line each; `undefined` until it is read. */
  readonly machineSummary?: readonly string[];
  /** The staged lines that also type the 6-digit code, as the daemon says them; `undefined` until it is read. */
  readonly machineCodes?: readonly number[];
  /** Whether this device can confirm with a passkey. Without it a sign-in line can't be ticked. */
  readonly canUsePasskey: boolean;
  /** Sends the ticked lines. An empty selection declines the plan. */
  readonly onApprove: (approval: ReturnType<typeof approvalOf>) => void;
  readonly onConfirmMachine: () => void;
  readonly onDenyMachine: () => void;
  /** Ends the named lines, or every line. Needs no passkey: it only narrows. */
  readonly onRevoke: (lines?: readonly number[]) => void;
}

const PROGRESS_WORDS: Readonly<Record<ApprovalProgress, string>> = {
  staging: 'Preparing what you ticked…',
  passkey: 'Waiting for your passkey…',
  committing: 'Allowing…',
};

const isSignIn = (line: TaskPlanLine): line is Extract<TaskPlanLine, { readonly fields: unknown }> =>
  line.kind !== 'paste';

const Flag = ({
  tone,
  children,
  name,
}: {
  readonly tone: 'err' | 'warn';
  readonly children: string;
  readonly name: string;
}) => (
  <span
    className={`flex items-start gap-1.5 text-meta font-medium ${tone === 'err' ? 'text-err' : 'text-warn'}`}
    data-task-plan-flag={name}
  >
    <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
    <span className="min-w-0 break-words">{children}</span>
  </span>
);

type SignInLine = Extract<TaskPlanLine, { readonly fields: unknown }>;

/**
 * Red "root on <host>" for a line that types a password into sudo, su or doas, and the words that say what that gives.
 * Only a line that is offered: an unavailable one (an ssh sign-in, say) types nothing, so it gives nothing.
 */
function RootFlag({ line, picked }: { readonly line: SignInLine; readonly picked: TaskPlanCandidate | undefined }) {
  if (line.state === 'unavailable') return null;
  if (line.kind !== 'terminal-sign-in' && !line.flags.includes('root')) return null;
  const host = rootHost(picked, line);
  return (
    <div className="flex flex-col gap-1" data-task-plan-root="">
      <Flag name="root" tone="err">
        {rootBadge(host)}
      </Flag>
      <span className="text-meta text-err">{rootWords(host, picked?.username, rootTool(picked, line))}</span>
    </div>
  );
}

/** The honest-client line: said on every card, whatever its state. */
function HonestLine() {
  return (
    <p className="m-0 flex items-start gap-2 text-meta text-muted" data-task-plan-honest="">
      <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
      <span className="min-w-0 break-words">{HONEST_CLIENT_LINE}</span>
    </p>
  );
}

export function TaskPlanCard(props: TaskPlanCardProps) {
  const { plan } = props;
  if (plan.state === 'pending' && plan.machineStage !== undefined) return <MachineStaged {...props} />;
  if (plan.state === 'pending') return <Ticking {...props} />;
  return <Settled {...props} />;
}

// ── The plan, waiting for the owner ──────────────────────────────────────────────────────────────────

function Ticking({ plan, agentName, phase, canUsePasskey, onApprove }: TaskPlanCardProps) {
  const [ticks, setTicks] = useState<Ticks>(() => initialTicks(plan));
  const groups = useMemo(() => groupLines(plan, ticks), [plan, ticks]);
  const working = phase.kind === 'working';
  const ticked = plan.lines.some(line => ticks[line.line]?.ticked === true);
  const approval = approvalOf(plan, ticks);
  const count = approval.lines.length;
  const needsPasskey = ticksNeedPasskey(plan, ticks);
  const problem = selectionProblem(plan, ticks);
  const blocked = needsPasskey && !canUsePasskey;
  const why = allowBlockedWords(plan, ticks, canUsePasskey);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-task-plan={plan.id} data-task-plan-state="pending">
      <HonestLine />
      <p className="m-0 text-cell text-muted">
        Tick what {agentName} may do without asking.{ticked ? '' : ' Nothing is ticked yet.'} Each ticked line works for
        the uses it shows, until <span className="mono">{timeWords(plan.expiresAt)}</span>.
      </p>
      {groups.map(group => (
        <section className="flex min-w-0 flex-col gap-2" data-task-plan-group={group.key} key={group.key}>
          <h4 className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">{group.title}</h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {group.lines.map(line => (
              <LineRow
                agentName={agentName}
                canUsePasskey={canUsePasskey}
                disabled={working}
                key={line.line}
                line={line}
                onCode={on => setTicks(current => withCode(plan, current, line.line, on))}
                onPick={signIn => setTicks(current => withPick(current, line.line, signIn))}
                onTick={on => setTicks(current => withTicked(plan, current, line.line, on))}
                plan={plan}
                ticks={ticks}
              />
            ))}
          </ul>
        </section>
      ))}
      <StillAsked />
      {phase.kind === 'working' ? (
        <p className="m-0 text-ui text-muted" data-task-plan-progress={phase.progress} role="status">
          {PROGRESS_WORDS[phase.progress]}
        </p>
      ) : null}
      {phase.kind === 'dismissed' ? (
        <p className="m-0 text-ui text-warn" data-task-plan-dismissed="" role="status">
          The passkey was dismissed, so nothing was approved. Tick the lines to try again.
        </p>
      ) : null}
      {phase.kind === 'failed' ? (
        <p className="m-0 text-ui text-err" data-task-plan-failure="" role="alert">
          {phase.words}
        </p>
      ) : null}
      {why === undefined ? null : (
        <p className="m-0 text-meta text-warn" data-task-plan-allow-why="" role="status">
          {why}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2" data-task-plan-actions="">
        <button
          className="kt-btn min-h-[44px]"
          data-task-plan-decline=""
          disabled={working}
          onClick={() => onApprove({ lines: [] })}
          type="button"
        >
          Decline all
        </button>
        <button
          className="kt-btn min-h-[44px]"
          data-task-plan-allow=""
          data-variant="primary"
          disabled={working || count === 0 || problem !== undefined || blocked}
          onClick={() => onApprove(approval)}
          type="button"
        >
          {working
            ? 'Allowing…'
            : needsPasskey
              ? `Allow ${String(count)} of ${String(plan.lines.length)} with passkey`
              : `Allow ${String(count)} of ${String(plan.lines.length)}`}
        </button>
      </div>
    </div>
  );
}

interface LineRowProps {
  readonly plan: TaskPlan;
  readonly line: TaskPlanLine;
  readonly ticks: Ticks;
  readonly agentName: string;
  readonly disabled: boolean;
  readonly canUsePasskey: boolean;
  readonly onTick: (on: boolean) => void;
  readonly onPick: (signIn: string | undefined) => void;
  readonly onCode: (on: boolean) => void;
}

function LineRow({ plan, line, ticks, agentName, disabled, canUsePasskey, onTick, onPick, onCode }: LineRowProps) {
  const id = useId();
  const tick: LineTick | undefined = ticks[line.line];
  const waiting = line.state === 'waiting';
  const signIn = isSignIn(line) ? line : undefined;
  const picked = signIn === undefined ? undefined : pickedCandidate(signIn, tick);
  const taken = signIn !== undefined && accountTakenElsewhere(plan, ticks, signIn);
  const tickable = waiting && mayTick(line, tick) && !taken && (signIn === undefined || canUsePasskey);
  const code = signIn === undefined ? 'not-asked' : totpState(signIn, tick);
  const chosenByFerret = signIn?.preselect?.signIn === tick?.signIn ? signIn?.preselect?.why : undefined;
  const tag = chosenByFerret === undefined ? undefined : preselectWords(chosenByFerret);

  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
      data-task-plan-line={line.line}
      data-task-plan-line-kind={line.kind}
      data-task-plan-line-state={line.state}
    >
      <div className="flex items-start gap-3">
        {waiting ? (
          <label
            className="-my-2 -ml-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
            data-task-plan-tap=""
            htmlFor={id}
          >
            <input
              aria-describedby={`${id}-why`}
              checked={tick?.ticked === true}
              className="h-5 w-5"
              data-task-plan-tick={line.line}
              disabled={disabled || !tickable}
              id={id}
              onChange={event => onTick(event.currentTarget.checked)}
              type="checkbox"
            />
          </label>
        ) : null}
        <label
          className={`flex min-w-0 flex-1 flex-col gap-1 ${waiting && tickable ? 'cursor-pointer' : ''}`}
          htmlFor={waiting ? id : undefined}
        >
          <span className="min-w-0 break-words text-ui text-fg" data-task-plan-title="">
            <span className="text-muted">Line {line.line + 1} · </span>
            {lineTitle(line, tick)}
          </span>
          <span className="text-meta text-faint" data-task-plan-uses="">
            {usesWords(line.uses)}
            {tag === undefined ? '' : ` · ${tag}`}
          </span>
        </label>
      </div>

      {signIn !== undefined && waiting && signIn.candidates.length > 1 ? (
        <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
          Account
          <select
            className="kt-input min-h-[44px] min-w-0"
            data-task-plan-pick={line.line}
            disabled={disabled}
            onChange={event => onPick(event.currentTarget.value === '' ? undefined : event.currentTarget.value)}
            value={tick?.signIn ?? ''}
          >
            <option value="">Choose an account…</option>
            {signIn.candidates.map(candidate => (
              <option key={candidate.signIn} value={candidate.signIn}>
                {candidateName(candidate)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {waiting && signIn !== undefined && picked === undefined && signIn.candidates.length > 0 ? (
        <span className="text-meta text-muted" data-task-plan-pick-first="">
          {PICK_FIRST_WORDS}
        </span>
      ) : null}
      {taken ? (
        <span className="text-meta text-warn" data-task-plan-taken="">
          Another ticked line already uses this account.
        </span>
      ) : null}

      {signIn === undefined ? null : <RootFlag line={signIn} picked={picked} />}
      {signIn?.flags.includes('no-history') === true && waiting ? (
        <Flag name="no-history" tone="warn">
          {NO_HISTORY_WORDS}
        </Flag>
      ) : null}

      {waiting && code !== 'not-asked' && !codeOnly(line) ? (
        <label
          className="flex min-h-[44px] items-start gap-3 text-meta text-err"
          data-task-plan-code={code}
          htmlFor={`${id}-code`}
        >
          <input
            checked={tick?.totp === true}
            className="mt-0.5 h-5 w-5 shrink-0"
            data-task-plan-code-tick={line.line}
            disabled={disabled || code === 'impossible' || tick?.ticked !== true}
            id={`${id}-code`}
            onChange={event => onCode(event.currentTarget.checked)}
            type="checkbox"
          />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-fg">
              Also fill the 6-digit code
              {code === 'impossible' ? ` · ${TOTP_IMPOSSIBLE_WORDS}` : ''}
            </span>
            {code === 'available' ? <span data-task-plan-one-factor="">{TOTP_TICK_WARNING}</span> : null}
          </span>
        </label>
      ) : null}
      {waiting && code !== 'not-asked' && codeOnly(line) ? (
        <span className="text-meta text-err" data-task-plan-one-factor="">
          {code === 'impossible' ? TOTP_IMPOSSIBLE_WORDS : TOTP_TICK_WARNING}
        </span>
      ) : null}

      {!waiting ? <LineState line={line} /> : null}
      <span className="text-meta text-faint" data-task-plan-why="" id={`${id}-why`}>
        {agentName} says: “{line.why}”
      </span>
    </li>
  );
}

/** What an approved sign-in line was allowed for: the account by name, root where it gives root, and a ticked code flagged. */
export function ApprovedFacts({ line }: { readonly line: TaskPlanLine }) {
  const account = approvedAccountName(line);
  if (!isSignIn(line) || account === undefined) return null;
  const picked = line.candidates.find(each => each.signIn === line.approved?.signIn);
  return (
    <>
      <span className="min-w-0 break-words text-meta text-muted" data-task-plan-account="">
        Account: {account}
      </span>
      <RootFlag line={line} picked={picked} />
      {approvedCode(line) ? (
        <span className="text-meta text-err" data-task-plan-one-factor="">
          Includes the 6-digit code. {TOTP_TICK_WARNING}
        </span>
      ) : null}
    </>
  );
}

/** A line that is not waiting says where it stands and, for a stopped or unavailable one, the daemon's reason. */
function LineState({ line }: { readonly line: TaskPlanLine }) {
  const reason = isSignIn(line) ? becauseWords(line.because) : undefined;
  const left = remainingOf(line);
  return (
    <span
      className={`text-meta ${line.state === 'approved' ? 'text-ok' : line.state === 'stopped' ? 'text-err' : 'text-muted'}`}
      data-task-plan-line-status={line.state}
    >
      {LINE_STATE_WORDS[line.state]}
      {line.state === 'approved' && left !== undefined ? ` · ${usesLeftWords(left, line.uses)}` : ''}
      {reason === undefined ? '' : ` · ${reason}`}
    </span>
  );
}

/** What a plan can't cover: said on every plan card, so the owner knows what will still ask. */
function StillAsked() {
  return (
    <details className="rounded-control border border-border p-3" data-task-plan-still-asked="" open>
      <summary className="min-h-[44px] cursor-pointer text-ui font-medium text-fg">You’ll still be asked</summary>
      <ul className="m-0 mt-1 flex list-none flex-col gap-2 p-0 text-meta text-muted">
        {STILL_ASKED.map(each => (
          <li className="min-w-0 break-words" key={each.what}>
            <span className="text-fg">{each.what}</span> — {each.instead}
          </li>
        ))}
      </ul>
    </details>
  );
}

// ── A selection typed at the machine, waiting here for its passkey ───────────────────────────────────

/** One line of a selection staged at the machine, with every warning the ticking card gives the same line. */
function StagedLine({
  line,
  agentName,
  codes,
}: {
  readonly line: TaskPlanLine;
  readonly agentName: string;
  readonly codes: readonly number[] | undefined;
}) {
  const signIn = isSignIn(line) ? line : undefined;
  // Until the stage is read (or on a picker) the plan's own candidates stand.
  const picked = signIn === undefined || signIn.candidates.length !== 1 ? undefined : signIn.candidates[0];
  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
      data-task-plan-line={line.line}
      data-task-plan-line-kind={line.kind}
    >
      <span className="min-w-0 break-words text-ui text-fg" data-task-plan-title="">
        <span className="text-muted">Line {line.line + 1} · </span>
        {lineTitle(line)}
      </span>
      <span className="text-meta text-faint" data-task-plan-uses="">
        {usesWords(line.uses)}
      </span>
      {signIn === undefined ? null : <RootFlag line={signIn} picked={picked} />}
      {signIn?.flags.includes('no-history') === true ? (
        <Flag name="no-history" tone="warn">
          {NO_HISTORY_WORDS}
        </Flag>
      ) : null}
      {stagedCodeOn(codes, line) ? (
        <span className="text-meta text-err" data-task-plan-one-factor="">
          Includes the 6-digit code. {TOTP_TICK_WARNING}
        </span>
      ) : null}
      <span className="text-meta text-faint" data-task-plan-why="">
        {agentName} says: “{line.why}”
      </span>
    </li>
  );
}

function MachineStaged({
  plan,
  agentName,
  phase,
  machineSummary,
  machineCodes,
  canUsePasskey,
  onConfirmMachine,
  onDenyMachine,
}: TaskPlanCardProps) {
  const stage = plan.machineStage;
  const working = phase.kind === 'working';
  if (stage === undefined) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-task-plan={plan.id} data-task-plan-state="machine-staged">
      <HonestLine />
      <p className="m-0 text-ui text-fg" data-task-plan-machine="">
        {machineStageWords(stage)}
      </p>
      {machineSummary === undefined ? null : (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-ui text-fg" data-task-plan-machine-summary="">
          {machineSummary.map(line => (
            <li className="break-words" key={line}>
              {line}
            </li>
          ))}
        </ul>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Staged lines" data-task-plan-machine-lines="">
        {stagedLines(plan).map(line => (
          <StagedLine agentName={agentName} key={line.line} line={line} codes={machineCodes} />
        ))}
      </ul>
      <p className="m-0 text-meta text-muted" data-task-plan-expiry="">
        Each allowed line works for the uses it shows, until <span className="mono">{timeWords(plan.expiresAt)}</span>.
      </p>
      <StillAsked />
      {phase.kind === 'working' ? (
        <p className="m-0 text-ui text-muted" data-task-plan-progress={phase.progress} role="status">
          {PROGRESS_WORDS[phase.progress]}
        </p>
      ) : null}
      {phase.kind === 'dismissed' ? (
        <p className="m-0 text-ui text-warn" data-task-plan-dismissed="" role="status">
          The passkey was dismissed, so nothing was approved. Confirm again, or Deny.
        </p>
      ) : null}
      {phase.kind === 'failed' ? (
        <p className="m-0 text-ui text-err" data-task-plan-failure="" role="alert">
          {phase.words}
        </p>
      ) : null}
      {canUsePasskey ? null : (
        <p className="m-0 text-meta text-warn" data-task-plan-no-passkey="">
          This device cannot confirm with a passkey. Deny, or open this card on a device that can.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2" data-task-plan-actions="">
        <button
          className="kt-btn min-h-[44px]"
          data-task-plan-machine-deny=""
          disabled={working}
          onClick={onDenyMachine}
          type="button"
        >
          Deny
        </button>
        <button
          className="kt-btn min-h-[44px]"
          data-task-plan-machine-confirm=""
          data-variant="primary"
          disabled={working || !canUsePasskey}
          onClick={onConfirmMachine}
          type="button"
        >
          {working ? 'Allowing…' : 'Confirm with passkey'}
        </button>
      </div>
    </div>
  );
}

// ── After the answer ─────────────────────────────────────────────────────────────────────────────────

function Settled({ plan, agentName, phase, onRevoke }: TaskPlanCardProps) {
  const live = isPlanLive(plan);
  const working = phase.kind === 'working';
  const revocable = plan.lines.filter(line => line.state === 'approved');
  return (
    <div className="flex min-w-0 flex-col gap-3" data-task-plan={plan.id} data-task-plan-state={plan.state}>
      <HonestLine />
      <p
        className={`m-0 text-ui ${plan.state === 'approved' ? 'text-ok' : 'text-muted'}`}
        data-task-plan-settled=""
        role="status"
      >
        {settledWords(plan)}
        {plan.state === 'approved' && plan.answered !== undefined
          ? ` Answered at ${clockWords(plan.answered.at)}.`
          : ''}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Plan lines">
        {plan.lines.map(line => (
          <li
            className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-surface-2 p-3"
            data-task-plan-line={line.line}
            data-task-plan-line-state={line.state}
            key={line.line}
          >
            <span className="min-w-0 break-words text-ui text-fg">
              <span className="text-muted">Line {line.line + 1} · </span>
              {lineTitle(line, approvedTick(line))}
            </span>
            <ApprovedFacts line={line} />
            <LineState line={line} />
            <span className="text-meta text-faint" data-task-plan-why="">
              {agentName} says: “{line.why}”
            </span>
            {live && line.state === 'approved' ? (
              <button
                className="kt-btn min-h-[44px] self-start"
                data-task-plan-revoke={line.line}
                disabled={working}
                onClick={() => onRevoke([line.line])}
                type="button"
              >
                Revoke line {line.line + 1}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {phase.kind === 'failed' ? (
        <p className="m-0 text-ui text-err" data-task-plan-failure="" role="alert">
          {phase.words}
        </p>
      ) : null}
      {live && revocable.length > 1 ? (
        <div className="flex justify-end">
          <button
            className="kt-btn min-h-[44px]"
            data-task-plan-revoke-all=""
            disabled={working}
            onClick={() => onRevoke()}
            type="button"
          >
            Revoke all
          </button>
        </div>
      ) : null}
    </div>
  );
}
