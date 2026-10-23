/**
 * THE ROUTING PROMPT (docs/pack-mode.md): the one paragraph every Pack ferret reads to pick the model each
 * sub-task runs on — the asking ferret in its system prompt, Jev when Jev decides — edited here with the
 * model names marked as they are typed, and cleaned up on request against this machine's harness setup.
 *
 * Save writes `models-guide.yaml` › `prompt` through the configuration-file routes and drops `suggested`,
 * because saved text is the owner's words; an empty Save removes `prompt` and the default applies. Clean up
 * spends one model run, only on a press: it posts what is in the box now, the run is read only while this
 * card is mounted and going, and its rewrite is shown as a diff that writes nothing until Accept. One
 * accept can be undone.
 */

import type { PackCleanUpJob, PackCleanUpSuggestion, PackView } from '@ferretry/protocol';
import { modelVocabulary } from '@ferretry/protocol';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  cleanUpProblem,
  routingCounter,
  routingSaveProblem,
  routingSourceWords,
} from '../../lib/pack/routing-prompt.ts';
import { absoluteTime } from '../../lib/session-screens.ts';
import { Button } from '../../shell/primitives.tsx';
import { AvailableNow } from './available-now.tsx';
import { CleanUpJobCard, CleanUpReview } from './clean-up-review.tsx';
import { ModelMentionField } from './model-mention-field.tsx';
import type { MachinePack } from './use-machine-pack.ts';

/** How often a running clean-up is read, in milliseconds. */
const CLEAN_UP_POLL_MS = 3_000;

/** What the last press came to, said under the buttons. */
type Outcome = { readonly tone: 'ok' | 'warn' | 'err'; readonly message: string };

const OUTCOME_CLASS: Readonly<Record<Outcome['tone'], string>> = {
  ok: 'border-ok-border bg-ok-bg text-ok',
  warn: 'border-warn-border bg-warn-bg text-warn',
  err: 'border-err-border bg-err-bg text-err',
};

export interface RoutingPromptCardProps {
  readonly connection: DaemonConnection;
  readonly view: Pick<PackView, 'routing' | 'models' | 'available' | 'undo' | 'cleanUp'>;
  readonly state: Pick<MachinePack, 'savePrompt' | 'cleanUp' | 'readJob' | 'accept' | 'undo'>;
  readonly pollMs?: number;
  readonly clock?: () => number;
  /** A run and its rewrite the card starts on (harness, tests). */
  readonly initial?: { readonly job: PackCleanUpJob; readonly suggestion?: PackCleanUpSuggestion };
}

export function RoutingPromptCard({
  connection,
  view,
  state,
  pollMs = CLEAN_UP_POLL_MS,
  clock = Date.now,
  initial,
}: RoutingPromptCardProps) {
  const id = useId().replace(/:/gu, '');
  const { routing, cleanUp } = view;
  const vocabulary = useMemo(() => modelVocabulary(view.models), [view.models]);
  const [draft, setDraft] = useState(routing.text);
  const [drawnFrom, setDrawnFrom] = useState(routing.text);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [job, setJob] = useState<PackCleanUpJob | null>(initial?.job ?? null);
  const [suggestion, setSuggestion] = useState<PackCleanUpSuggestion | null>(initial?.suggestion ?? null);
  const [readError, setReadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(clock);
  const readJob = useRef(state.readJob);
  readJob.current = state.readJob;
  const clockRef = useRef(clock);
  clockRef.current = clock;

  // The prompt moved under an untouched box (a save, an accept, an undo, another device, `fy`): show it.
  if (routing.text !== drawnFrom) {
    if (draft === drawnFrom) setDraft(routing.text);
    setDrawnFrom(routing.text);
  }

  // A run already going when the page opens is picked up, so a reload does not lose it.
  const adopted = useRef(false);
  const going = cleanUp.job;
  useEffect(() => {
    if (adopted.current || going === undefined || going.status !== 'running') return;
    adopted.current = true;
    setJob(current => current ?? going);
  }, [going]);

  const jobId = job?.id;
  const running = job?.status === 'running';
  useEffect(() => {
    if (jobId === undefined || !running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      void readJob.current(jobId).then(read => {
        if (!live) return;
        if (read.kind === 'read') {
          setReadError(null);
          setJob(read.result.job);
          if (read.result.suggestion !== undefined) setSuggestion(read.result.suggestion);
          if (read.result.job.status !== 'running') return;
        } else setReadError(read.message);
        timer = setTimeout(tick, pollMs);
      });
    };
    timer = setTimeout(tick, pollMs);
    const clockTimer = setInterval(() => setNowMs(clockRef.current()), 1_000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(clockTimer);
    };
  }, [jobId, running, pollMs]);

  const words = draft.trim();
  const blank = words === '';
  const changed = words !== routing.text.trim();
  const saveProblem = routingSaveProblem(draft);
  // An empty box over the default already in effect has nothing to remove.
  const canSave = changed && saveProblem === null && !(blank && routing.source === 'default');
  const cleanUpBlock = cleanUpProblem(draft, cleanUp, running);

  const save = (): void => {
    setBusy(true);
    setOutcome(null);
    void state.savePrompt(blank ? null : words).then(result => {
      setBusy(false);
      if (result.kind === 'applied') {
        setOutcome({
          tone: 'ok',
          message: blank
            ? 'Removed your prompt: the default, built from the model catalogs, applies now.'
            : 'Saved. These are your words now.',
        });
      } else setOutcome({ tone: result.kind === 'pending' ? 'warn' : 'err', message: result.message });
    });
  };

  const startCleanUp = (): void => {
    setBusy(true);
    setOutcome(null);
    setSuggestion(null);
    setReadError(null);
    void state.cleanUp(blank ? {} : { prompt: words }).then(started => {
      setBusy(false);
      if (started.kind === 'started') {
        setJob(started.job);
        setNowMs(clockRef.current());
      } else setOutcome({ tone: 'err', message: started.message });
    });
  };

  const closeReview = (): void => {
    setSuggestion(null);
    setJob(null);
  };

  const accept = (): void => {
    if (suggestion === null) return;
    setBusy(true);
    setOutcome(null);
    void state.accept({ prompt: suggestion.after, suggested: suggestion.suggested }).then(result => {
      setBusy(false);
      if (result.kind === 'refused') {
        setOutcome({ tone: 'err', message: result.message });
        return;
      }
      // The accepted words are what the box shows next, whatever was typed before the clean-up.
      setDraft(suggestion.after);
      closeReview();
      setOutcome({ tone: 'ok', message: result.message });
    });
  };

  const undo = (): void => {
    setBusy(true);
    setOutcome(null);
    void state.undo().then(result => {
      setBusy(false);
      setOutcome({ tone: result.kind === 'refused' ? 'err' : 'ok', message: result.message });
    });
  };

  const counterId = `${id}-count`;
  const over = saveProblem !== null;
  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-4" aria-labelledby={`${id}-h`} data-routing-card="">
      <div className="min-w-0">
        <h3 id={`${id}-h`} className="m-0 text-ui font-semibold">
          Routing prompt
        </h3>
        <p className="m-0 mt-1 text-meta leading-base text-muted">
          Ferrets use this to pick which model runs each sub-task.
        </p>
        <p className="m-0 mt-1 text-meta leading-base text-faint">
          The asking ferret reads it in its system prompt; Jev reads it when Jev decides. Models are tried in the order
          it names them.
        </p>
      </div>
      <p className="m-0 flex min-w-0 items-start gap-2 text-meta leading-base">
        <span
          aria-hidden="true"
          className={cn(
            'mt-[0.45em] h-2 w-2 shrink-0 rounded-full',
            routing.source === 'default' ? 'bg-surface-3' : 'bg-accent',
          )}
        />
        <span className="min-w-0 break-words">
          <span className="text-muted">Where it came from: </span>
          <span
            className="font-semibold text-fg-soft"
            data-routing-source={routing.suggested === undefined ? routing.source : 'cleaned-up'}
          >
            {routingSourceWords(routing, absoluteTime)}
          </span>
        </span>
      </p>
      <ModelMentionField
        id={`${id}-prompt`}
        label="How to pick a model"
        value={draft}
        onChange={setDraft}
        vocabulary={vocabulary}
        rows={6}
        disabled={busy}
        problem={saveProblem}
        describedBy={counterId}
        placeholder="For example: planning or review → claude-opus-5-5 at max; chores → claude-haiku-4-5 low."
      />
      <div className="-mt-1 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-meta">
        <span className="min-w-0 text-faint">
          {blank && routing.source === 'file'
            ? 'Saving it empty removes your prompt, and the default applies.'
            : 'Leave it empty and Save to use the default.'}
        </span>
        <span
          id={counterId}
          className={cn('mono shrink-0', over ? 'font-semibold text-err' : 'text-muted')}
          data-routing-counter={over ? 'over' : 'ok'}
        >
          {routingCounter(draft)}
          <span className="sr-only"> characters</span>
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          className="min-h-[44px]"
          disabled={busy || cleanUpBlock !== null}
          onClick={startCleanUp}
          data-routing-action="clean-up"
        >
          Clean up
        </Button>
        <Button
          variant="primary"
          className="min-h-[44px]"
          disabled={busy || !canSave}
          onClick={save}
          data-routing-action="save"
        >
          Save
        </Button>
        {view.undo === undefined ? null : (
          <Button
            variant="ghost"
            className="min-h-[44px]"
            disabled={busy}
            onClick={undo}
            title={`Put back the prompt kept ${absoluteTime(view.undo.savedAt)}`}
            data-routing-action="undo"
          >
            Undo clean-up
          </Button>
        )}
      </div>
      {cleanUpBlock === null || running ? null : (
        <p className="m-0 break-words text-meta leading-base text-warn" data-routing-clean-up-blocked="">
          {cleanUpBlock}
        </p>
      )}
      <p className="m-0 text-meta leading-base text-faint">
        Clean up has a short-lived ferret rewrite what is in the box against this machine’s runtimes, models and quota.
        It spends one model run, only when you press it; nothing is saved until you accept.
      </p>
      {outcome === null ? null : (
        <p
          role="status"
          data-routing-outcome={outcome.tone}
          className={cn(
            'm-0 break-words rounded-control border px-3 py-2 text-meta leading-base',
            OUTCOME_CLASS[outcome.tone],
          )}
        >
          {outcome.message}
        </p>
      )}
      {job === null ? null : <CleanUpJobCard connection={connection} job={job} nowMs={nowMs} readError={readError} />}
      {suggestion === null ? null : (
        <CleanUpReview
          suggestion={suggestion}
          busy={busy}
          onAccept={accept}
          onEdit={() => {
            setDraft(suggestion.after);
            setOutcome({ tone: 'warn', message: 'The rewrite is in the box. Save it when it says what you want.' });
            closeReview();
          }}
          onDiscard={closeReview}
        />
      )}
      <div className="border-t border-border-soft pt-3">
        <AvailableNow available={view.available} headingId={`${id}-available`} />
      </div>
    </section>
  );
}
