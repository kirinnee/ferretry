/**
 * Change model or account: the move of a ferret onto another account or model of ITS OWN CLI, guarded by the
 * daemon's in-operation preflight. There is deliberately no browser-side classifier or force path here: the move
 * route inspects immediately before it writes and refuses every destructive or unknown in-flight item without
 * changing the ferret. (Moving onto the other CLI is the sibling page, `convert-harness.tsx`.)
 *
 * The runtime field is the slot `ferrets.move-account`; this form owns the typed wrapper, the model box and the
 * request identity of the move.
 */

import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AskToStopJobsResult, ChosenFerretAccount, FerretSummary, InflightItem } from '../../../contract/index.ts';
import { Button } from '../../ui.ts';
import { AccountSlot, type RenderAccountSlot } from './account-slot.tsx';
import { moveCallFailure } from './call-failure.ts';
import {
  type MoveFailure,
  type MoveTarget,
  moveContextDecision,
  moveFailure,
  moveHasRuntimeChange,
  moveModelSuggestions,
  moveTarget,
  oneMillionVariant,
  onlyAgentJobsBlock,
} from './move-model.ts';

/** Performs the move. The page hands the real one (by route key); a test hands a scripted one. */
export type MoveFerret = (target: MoveTarget, requestId: string) => Promise<FerretSummary>;
export type AskToStopJobs = () => Promise<AskToStopJobsResult>;

/** Where asking the agent to stop its background jobs has got to. */
type JobsAsk =
  | { readonly state: 'idle' }
  | { readonly state: 'asking' }
  | { readonly state: 'asked'; readonly result: AskToStopJobsResult }
  /** The daemon looked again and none of the agent's jobs is in the way any more. */
  | { readonly state: 'cleared' }
  | { readonly state: 'failed'; readonly message: string };

const JOBS_IDLE: JobsAsk = { state: 'idle' };

/**
 * The stable identity of ONE logical move.
 *
 * A move is destructive and the client retries its POST on transport failure, so the id has to outlive a single
 * call: every attempt at the same target must be the same operation to the daemon. It must equally NOT outlive the
 * target — once the reader picks a different account, model or downgrade answer, that is a new decision, and reusing
 * the previous id would have the daemon answer with the move the reader just changed their mind about.
 */
export const moveRequestKey = (ferret: string, input: MoveTarget): string =>
  JSON.stringify([ferret, input.agent, input.model ?? null, input.allowContextDowngrade]);

type MovePhase = 'form' | 'confirm' | 'submitting' | 'downgrade' | 'refused';

const readableNumber = (value: number): string => new Intl.NumberFormat().format(value);

const NO_MODELS: readonly string[] = Object.freeze([]);

/**
 * THE ONE THING A CHOSEN ACCOUNT MAY DO TO THE MODEL BOX: SUGGEST. It may not write. Blank means "this account's own
 * default", the daemon resolves that itself, and typing the default in would turn it into a pin the reader never
 * asked for. The wrapper text must still agree with the chosen account: in a control whose typed value is its output,
 * a reader who typed over the wrapper has changed the answer. Unavailable models are left out: the manifest has
 * already said they cannot serve.
 */
const chosenAccountModels = (chosen: ChosenFerretAccount | null, agent: string): readonly string[] =>
  chosen === null || chosen.wrapper !== agent.trim()
    ? NO_MODELS
    : chosen.models.filter(model => model.available).map(model => model.id);

export interface ChangeAccountProps {
  readonly summary: FerretSummary;
  readonly slot: RenderAccountSlot;
  readonly move: MoveFerret;
  /** Asks the agent to stop its own background jobs. */
  readonly askToStopJobs: AskToStopJobs;
  readonly onCancel: () => void;
  readonly onMoved: (summary: FerretSummary) => void;
}

export function ChangeAccount({ summary, slot, move, askToStopJobs, onCancel, onMoved }: ChangeAccountProps) {
  const headingId = useId().replace(/:/gu, '');
  const agentHelpId = useId().replace(/:/gu, '');
  const agentFieldId = `${headingId}-agent`;
  const modelId = useId().replace(/:/gu, '');
  const modelListId = useId().replace(/:/gu, '');
  const currentAgent = summary.runtime ?? '';
  const currentModel = (summary.model ?? '').trim();
  const [agent, setAgent] = useState(currentAgent);
  const [model, setModel] = useState(currentModel);
  const [chosenAccount, setChosenAccount] = useState<ChosenFerretAccount | null>(null);
  const [phase, setPhase] = useState<MovePhase>('form');
  const [failure, setFailure] = useState<MoveFailure | null>(null);
  const [downgradeAcknowledged, setDowngradeAcknowledged] = useState(false);
  // Belongs to the refusal it answered: a retried safety check starts it over, and asking about the same jobs again
  // is answered with the message already queued rather than a second one.
  const [jobsAsk, setJobsAsk] = useState<JobsAsk>(JOBS_IDLE);
  const submitLock = useRef(false);
  const liveIdentity = useRef(summary.id);
  liveIdentity.current = summary.id;
  // The request identity of the move currently on offer. Held in a ref, not state, because minting it must not
  // re-render, and because a repeated submit has to observe the SAME id the first submit used.
  const requestIdentity = useRef<{ key: string; id: string } | null>(null);

  // All local draft/error/acknowledgement state belongs to this exact ferret.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ferret reset trigger, see above
  useLayoutEffect(() => {
    setAgent(currentAgent);
    setModel(currentModel);
    setPhase('form');
    setFailure(null);
    setDowngradeAcknowledged(false);
    setChosenAccount(null);
    setJobsAsk(JOBS_IDLE);
    submitLock.current = false;
    requestIdentity.current = null;
  }, [summary.id]);

  const target = useMemo(() => moveTarget(agent, model), [agent, model]);
  // GAP(ferrets): the summary carries neither the context window nor the tokens used, so a too-large conversation is
  // not caught here (the daemon refuses it) and a downgrade is judged from the model names alone.
  const context = moveContextDecision({ currentModel, targetModel: model });
  const hasRuntimeChange = moveHasRuntimeChange(currentAgent, currentModel, target);
  const canReview = target !== null && hasRuntimeChange && !context.conversationTooLarge;
  // The chosen account's models lead, because they are the ones the reader has just given this daemon's word for; the
  // current model's own variants stay, because moving account and keeping the window is the common move.
  const suggestions = useMemo(
    () => [...new Set([...chosenAccountModels(chosenAccount, agent), ...moveModelSuggestions(currentModel)])],
    [chosenAccount, agent, currentModel],
  );
  const terminal = summary.state === 'stopped';
  const busy = summary.state === 'working' || summary.state === 'starting';

  const askAgentToStopJobs = async (): Promise<void> => {
    if (jobsAsk.state === 'asking') return;
    const submitted = summary.id;
    setJobsAsk({ state: 'asking' });
    try {
      const result = await askToStopJobs();
      if (liveIdentity.current === submitted) setJobsAsk({ state: 'asked', result });
    } catch (error) {
      if (liveIdentity.current !== submitted) return;
      const reason = moveCallFailure(error);
      if (reason.code === 'no_background_jobs') setJobsAsk({ state: 'cleared' });
      else setJobsAsk({ state: 'failed', message: reason.message });
    }
  };

  const editAgent = (next: string): void => {
    setAgent(next);
    // The chosen account is deliberately NOT cleared here: `chosenAccountModels` already refuses to offer it once
    // the text disagrees, and clearing it would additionally lose the choice when a reader types the same wrapper back.
    setFailure(null);
    setDowngradeAcknowledged(false);
    setPhase('form');
  };

  const editModel = (next: string): void => {
    setModel(next);
    setFailure(null);
    setDowngradeAcknowledged(false);
    setPhase('form');
  };

  const review = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canReview) return;
    setFailure(null);
    setPhase('confirm');
  };

  const performMove = async (allowContextDowngrade: boolean): Promise<void> => {
    if (
      submitLock.current ||
      target === null ||
      !hasRuntimeChange ||
      context.conversationTooLarge ||
      (allowContextDowngrade && !downgradeAcknowledged)
    )
      return;

    const submitted = summary.id;
    const input: MoveTarget = { ...target, allowContextDowngrade };
    // One id per logical target. A repeated confirmation of the SAME target reuses it, so the daemon recognises the
    // second ask as the first one rather than relaunching twice; changing the target mints a new one.
    const key = moveRequestKey(summary.id, input);
    const identity = requestIdentity.current?.key === key ? requestIdentity.current : { key, id: crypto.randomUUID() };
    requestIdentity.current = identity;
    submitLock.current = true;
    setFailure(null);
    setJobsAsk(JOBS_IDLE);
    setPhase('submitting');
    try {
      const moved = await move(input, identity.id);
      if (liveIdentity.current !== submitted) return;
      onMoved(moved);
    } catch (error) {
      if (liveIdentity.current !== submitted) return;
      const next = moveFailure(moveCallFailure(error));
      setFailure(next);
      if (next.kind === 'context-downgrade' && !allowContextDowngrade) setPhase('downgrade');
      else if (next.kind === 'preflight-refused') setPhase('refused');
      else setPhase('confirm');
    } finally {
      if (liveIdentity.current === submitted) submitLock.current = false;
    }
  };

  // One sentence, two fields. It is the target of `aria-describedby` either way, so a reader hears the same account it
  // names whichever control they are standing in.
  const accountName = (wrapper: string, className?: string): ReactNode => (
    <span className={`mono ${className ?? ''}`.trim()}>{wrapper === '' ? 'unknown account' : wrapper}</span>
  );
  const agentHelp = (
    <span id={agentHelpId} className="text-meta leading-base text-muted">
      Current account: {accountName(currentAgent)}. Moving to the other CLI is its own choice above: Claude and Codex
      cannot resume each other’s conversation format.
    </span>
  );

  if (phase === 'submitting') {
    return (
      <div
        className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-3 px-panel pb-6 text-center"
        data-move-submitting=""
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="animate-spin text-accent" size={28} />
        <p className="m-0 text-title font-semibold text-fg">
          Moving — running the safety gate, stopping the old pane and relaunching…
        </p>
        <p className="m-0 max-w-xl text-ui leading-base text-muted">
          Keep this page open. A large conversation can take tens of seconds to resume.
        </p>
      </div>
    );
  }

  if (phase === 'form') {
    return (
      <form className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5" noValidate onSubmit={review}>
        <div className="mx-auto grid w-full max-w-2xl gap-5 py-4">
          <section aria-labelledby={`${headingId}-account-heading`}>
            <h2 id={`${headingId}-account-heading`} className="m-0 text-ui font-semibold text-fg">
              Target account
            </h2>
            <p className="mt-1 text-meta leading-base text-muted">
              Only this daemon’s {summary.harness === 'codex' ? 'Codex' : 'Claude Code'} accounts are offered. A wrapper
              it has never published is still submitted exactly as typed — the daemon is the thing that accepts or
              refuses one.
            </p>
            {/* Not a wrapping `<label>`: the rows are inside this control, and a click on one inside a label would
                be re-dispatched at the input and close the panel under the finger. */}
            <div className="mt-2 grid gap-1.5 text-ui text-fg">
              <span className="font-semibold" id={`${headingId}-agent-label`}>
                Agent wrapper
              </span>
              <AccountSlot
                fallbackLabel="Agent wrapper"
                field={{
                  harness: summary.harness,
                  value: agent,
                  onValueChange: editAgent,
                  onChosen: setChosenAccount,
                  fallbackId: agentFieldId,
                  labelId: `${headingId}-agent-label`,
                  fallbackPlaceholder: 'claude-default',
                  noAccounts: (
                    <p className="m-0 text-ui text-muted" data-move-no-accounts="">
                      No account on this daemon can run this ferret’s CLI.
                    </p>
                  ),
                }}
                render={slot}
              />
              {agentHelp}
            </div>
          </section>

          <section aria-labelledby={`${headingId}-model-heading`}>
            <label id={`${headingId}-model-heading`} className="text-ui font-semibold text-fg" htmlFor={modelId}>
              Model
            </label>
            <input
              id={modelId}
              autoCapitalize="none"
              autoCorrect="off"
              className="kt-input mt-2 !min-h-[44px] w-full mono"
              list={modelListId}
              onChange={event => editModel(event.target.value)}
              placeholder={agent.trim() === currentAgent ? 'Enter a different model' : 'Use the account default'}
              spellCheck={false}
              value={model}
            />
            <datalist id={modelListId}>
              {suggestions.map(suggestion => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
            <p className="mt-1 text-meta leading-base text-muted">
              Leave empty to use the account’s default model. Add <span className="mono">[1m]</span> for the
              million-token context variant.
            </p>

            {context.conversationTooLarge ? (
              <div
                className="mt-3 rounded-control border border-err bg-surface-2 p-3 text-ui leading-base text-err"
                role="alert"
              >
                <div className="flex items-start gap-sm">
                  <AlertOctagon aria-hidden="true" className="mt-0.5 shrink-0" size={17} />
                  <span>
                    This conversation no longer fits that model’s window. Pick a <span className="mono">[1m]</span>{' '}
                    variant. The daemon refuses this even with a downgrade acknowledgement.
                  </span>
                </div>
              </div>
            ) : context.isDowngrade && context.currentWindow !== undefined && context.targetWindow !== undefined ? (
              <div className="mt-3 rounded-control border border-warn-border bg-surface-2 p-3">
                <div className="flex items-start gap-sm text-warn">
                  <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={17} />
                  <p className="m-0 text-ui leading-base">
                    This appears to reduce the context window from {readableNumber(context.currentWindow)} to{' '}
                    {readableNumber(context.targetWindow)} tokens. The daemon will verify that and require a separate
                    acknowledgement before it proceeds.
                  </p>
                </div>
              </div>
            ) : null}
          </section>

          <section aria-labelledby={`${headingId}-safety-heading`}>
            <h2 id={`${headingId}-safety-heading`} className="m-0 text-ui font-semibold text-fg">
              Move safety
            </h2>
            <p className="mt-1 text-meta leading-base text-muted">
              The daemon inspects the pane and process tree inside the move request, immediately before any write. A
              preview here would already be stale by the time the pane is replaced.
            </p>
            {/* `list-disc` is explicit: the preflight resets `list-style` on every `ul`, and these three statements
                are the page's whole account of the safety model — unmarked they read as one run-on paragraph. */}
            <ul className="mt-2 grid list-disc gap-2 pl-5 text-ui leading-base text-muted">
              <li>Destructive or unknown in-flight work refuses the move without changing the ferret.</li>
              <li>This route has no force switch, and this page does not invent one.</li>
              <li>On success, the daemon writes the forensic report and hands it to the replacement agent.</li>
            </ul>
          </section>

          {!hasRuntimeChange && target !== null ? (
            <p className="m-0 text-ui leading-base text-warn" role="status">
              Choose another account or enter a different model. Relaunching the same account and model would only
              destroy the current pane.
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
            <Button className="min-h-[44px]" onClick={onCancel} type="button">
              Cancel
            </Button>
            <Button className="min-h-[44px]" disabled={!canReview} type="submit" variant="primary">
              Review move <ArrowRight aria-hidden="true" size={15} />
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5">
      {/* `minmax(0, 1fr)`, not the grid's `auto` track: an auto track grows to its longest unbroken line — a daemon
          command, a job's argv — and on a phone that pushed the cards past the gutter. */}
      <div className="mx-auto grid w-full max-w-2xl grid-cols-[minmax(0,1fr)] gap-4 py-4">
        {phase === 'refused' && failure ? (
          <section
            aria-labelledby={`${headingId}-refused-heading`}
            className="rounded-control border border-err bg-surface-2 p-4"
          >
            <div className="flex items-start gap-sm text-err">
              <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={19} />
              <div>
                <h2 id={`${headingId}-refused-heading`} className="m-0 text-title font-semibold text-fg">
                  {failure.title}
                </h2>
                <p className="mt-1 text-ui leading-base text-muted">{failure.guidance}</p>
              </div>
            </div>
            <pre
              className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-code-bg p-3 text-code leading-base text-code-fg"
              role="alert"
            >
              {failure.message}
            </pre>
            {onlyAgentJobsBlock(failure.inflight) ? (
              <AgentJobsAsk
                ask={jobsAsk}
                jobs={failure.inflight?.items.filter(item => item.blocks) ?? []}
                onAsk={() => void askAgentToStopJobs()}
              />
            ) : null}
            <p className="mt-3 text-ui font-semibold text-err">
              There is no force control. A refused preflight cannot start a move.
            </p>
          </section>
        ) : phase === 'downgrade' && failure ? (
          <section
            aria-labelledby={`${headingId}-downgrade-heading`}
            className="rounded-control border border-warn-border bg-surface-2 p-4"
          >
            <div className="flex items-start gap-sm text-warn">
              <ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0" size={19} />
              <div>
                <h2 id={`${headingId}-downgrade-heading`} className="m-0 text-title font-semibold text-fg">
                  {failure.title}
                </h2>
                <p className="mt-1 text-ui leading-base text-muted">{failure.guidance}</p>
              </div>
            </div>
            <p className="mt-3 break-words text-ui leading-base text-warn" role="alert">
              {failure.message}
            </p>
            <Button
              className="mt-3 min-h-[44px] w-full justify-center"
              onClick={() => editModel(failure.suggestedModel ?? oneMillionVariant(model || currentModel))}
              type="button"
              variant="primary"
            >
              Use {failure.suggestedModel ? <span className="mono">{failure.suggestedModel}</span> : 'a 1M model'}{' '}
              instead
            </Button>
            <label className="mt-3 flex min-h-[52px] items-start gap-sm rounded-control border border-warn-border p-3 text-ui text-fg">
              <input
                checked={downgradeAcknowledged}
                className="mt-1 h-4 w-4 shrink-0"
                onChange={event => setDowngradeAcknowledged(event.target.checked)}
                type="checkbox"
              />
              <span>I understand this ferret may permanently outgrow the smaller window and become unrecoverable.</span>
            </label>
          </section>
        ) : (
          <section
            aria-labelledby={`${headingId}-confirm-heading`}
            className="rounded-control border border-warn-border bg-surface-2 p-4"
          >
            <div className="flex items-start gap-sm text-warn">
              <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={19} />
              <div>
                <h2 id={`${headingId}-confirm-heading`} className="m-0 text-title font-semibold text-fg">
                  This is a destructive relaunch
                </h2>
                <p className="mt-1 text-ui leading-base text-muted">
                  {terminal
                    ? `This will relaunch the stopped ferret under ${target?.agent ?? agent}.`
                    : `Moving relaunches this ferret under ${target?.agent ?? agent}. The daemon will refuse if the current turn cannot be interrupted safely.`}
                </p>
              </div>
            </div>
          </section>
        )}

        <section aria-labelledby={`${headingId}-target-heading`}>
          <h2 id={`${headingId}-target-heading`} className="m-0 text-ui font-semibold text-fg">
            Requested runtime
          </h2>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-sm rounded-control border border-border bg-surface-2 p-3 text-ui">
            {accountName(currentAgent, 'text-muted')}
            <ArrowRight aria-hidden="true" className="shrink-0 text-accent" size={15} />
            {accountName(target?.agent ?? agent.trim(), 'font-semibold text-fg')}
            <span className="mono break-all text-muted">{target?.model ?? 'account default'}</span>
          </div>
        </section>

        {busy ? (
          <div
            className="flex items-center gap-sm rounded-control border border-warn bg-surface-2 p-3 text-ui font-semibold text-warn"
            role="alert"
          >
            <RefreshCw aria-hidden="true" className="shrink-0" size={17} />
            This ferret is working right now. The daemon’s preflight decides whether it can be interrupted.
          </div>
        ) : null}

        {phase === 'confirm' && failure ? (
          <div className="rounded-control border border-err bg-surface-2 p-4" role="alert">
            <h2 className="m-0 text-title font-semibold text-fg">{failure.title}</h2>
            <p className="mt-2 break-words text-ui leading-base text-err">{failure.message}</p>
            <p className="mt-2 text-ui leading-base text-muted">{failure.guidance}</p>
          </div>
        ) : null}

        <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
          <Button
            className="min-h-[44px]"
            onClick={() => {
              setFailure(null);
              setDowngradeAcknowledged(false);
              setPhase('form');
            }}
            type="button"
          >
            Back
          </Button>
          <Button
            className="min-h-[44px]"
            disabled={phase === 'downgrade' && !downgradeAcknowledged}
            onClick={() => void performMove(phase === 'downgrade')}
            type="button"
            variant="danger"
          >
            {phase === 'downgrade'
              ? 'Move with smaller window'
              : phase === 'refused'
                ? 'Retry safety check'
                : terminal
                  ? 'Relaunch on selected runtime'
                  : 'Move and relaunch'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The refusal's one remedy when everything in the way is the agent's own: ask it. One queued message — from
 * Ferretry · Move, the words naming each pid — and nothing is stopped by Ferretry. The person then runs the safety
 * check again, which stays the only way a move starts.
 */
function AgentJobsAsk({
  ask,
  jobs,
  onAsk,
}: {
  readonly ask: JobsAsk;
  readonly jobs: readonly InflightItem[];
  readonly onAsk: () => void;
}) {
  const asked = ask.state === 'asked' ? ask.result : null;
  return (
    <div className="mt-3 rounded-control border border-border bg-surface p-3" data-agent-jobs-ask="">
      <p className="m-0 text-ui font-semibold text-fg">
        {jobs.length === 1 ? 'This is a job the agent started itself' : 'These are jobs the agent started itself'}
      </p>
      <p className="mt-1 text-ui leading-base text-muted">
        The agent left {jobs.length === 1 ? 'it' : 'them'} running in the background from its own shell. Ferretry can
        send it one message asking it to stop {jobs.length === 1 ? 'it' : 'them'}, or to say why not. Ferretry stops
        nothing itself.
      </p>
      <ul className="mt-2 grid gap-1">
        {jobs.map(job => (
          <li className="flex min-w-0 items-baseline gap-sm text-meta" key={`${job.pid ?? ''}:${job.detail ?? ''}`}>
            {job.pid === undefined ? null : <span className="mono shrink-0 text-muted">{`pid ${job.pid}`}</span>}
            <span className="mono min-w-0 truncate text-fg">{job.detail ?? job.title}</span>
          </li>
        ))}
      </ul>
      {asked !== null || ask.state === 'cleared' ? null : (
        <Button
          className="!h-auto !whitespace-normal mt-3 min-h-[44px] w-full justify-center py-2 text-center sm:w-auto"
          data-agent-jobs-ask-button=""
          disabled={ask.state === 'asking'}
          onClick={onAsk}
          type="button"
          variant="primary"
        >
          {ask.state === 'asking' ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={15} />
          ) : (
            <MessageSquare aria-hidden="true" size={15} />
          )}
          {ask.state === 'asking' ? 'Asking the agent…' : 'Ask the agent to stop its background jobs'}
        </Button>
      )}
      {asked !== null ? (
        <p className="mt-2 text-ui leading-base text-fg" role="status">
          {asked.alreadyAsked
            ? 'The agent was already asked about these jobs — that message is still the one in its queue.'
            : 'Asked. The message is in the agent’s queue, and it reads it as soon as it is free.'}{' '}
          Once it has stopped them, press <span className="font-semibold">Retry safety check</span>.
        </p>
      ) : ask.state === 'cleared' ? (
        <p className="mt-2 text-ui leading-base text-fg" role="status">
          None of them is running any more, so nothing was sent. Press{' '}
          <span className="font-semibold">Retry safety check</span>.
        </p>
      ) : ask.state === 'failed' ? (
        <p className="mt-2 break-words text-ui leading-base text-err" role="alert">
          Couldn’t ask the agent: {ask.message}
        </p>
      ) : null}
    </div>
  );
}
