/**
 * THE ROUTING PROMPT (docs/pack-mode.md): the one paragraph every Pack ferret reads to pick the model each
 * sub-task runs on — the asking ferret in its system prompt, Jev when Jev decides — edited here with the
 * model names marked as they are typed, and cleaned up on request against this machine's harness setup.
 *
 * Save writes `models-guide.yaml` › `prompt` through the configuration-file routes and drops `suggested`,
 * because saved text is the owner's words; an empty Save removes `prompt` and the default applies. Write it
 * for me and Clean up are one builder in two modes and each spends one model run, only on a press: Write it
 * for me posts a short optional idea (and the prompt in the box, if the owner has one) and the ferret WRITES a
 * whole prompt; Clean up posts what is in the box and rewrites it. The run is read only while this card is
 * mounted and going, and its result is shown as a diff (just the new prompt when there was nothing before)
 * that writes nothing until Accept. One accept can be undone. Until a prompt has been saved the card is a
 * first-run nudge — "Not written yet" and a big Write it for me — rather than a box holding the default.
 */

import type { PackCleanUpJob, PackCleanUpSuggestion, PackView } from '@ferretry/protocol';
import { MAX_IDEA_CHARS, modelVocabulary } from '@ferretry/protocol';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  cleanUpProblem,
  ideaCounter,
  ideaFill,
  routingCounter,
  routingSaveProblem,
  routingSourceWords,
  writeProblem,
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
  const [idea, setIdea] = useState('');
  const [byHand, setByHand] = useState(false);
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
  const writeBlock = writeProblem(cleanUp, running);
  // No prompt saved yet and the owner has not chosen to type one: offer to write it instead of an editor.
  const nudge = routing.source === 'default' && !byHand;

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

  const startWrite = (): void => {
    setBusy(true);
    setOutcome(null);
    setSuggestion(null);
    setReadError(null);
    // What is in the box counts as the owner's prompt only when it is theirs: a saved prompt, or words they typed.
    const theirs = routing.source === 'default' && words === routing.text.trim() ? '' : words;
    const note = idea.trim();
    void state
      .cleanUp({
        mode: 'generate',
        ...(note === '' ? {} : { idea: note }),
        ...(theirs === '' ? {} : { prompt: theirs }),
      })
      .then(started => {
        setBusy(false);
        if (started.kind === 'started') {
          setJob(started.job);
          setNowMs(clockRef.current());
        } else setOutcome({ tone: 'err', message: started.message });
      });
  };

  // Cmd/Ctrl+Enter in the idea field presses Write it for me, only when the button itself could be pressed.
  const submitWrite = (): void => {
    if (!busy && !running && writeBlock === null) startWrite();
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
      {nudge ? (
        <div
          className="flex min-w-0 flex-col gap-3 rounded-control border border-dashed border-border-strong bg-surface-2 p-4"
          data-routing-nudge=""
        >
          <p className="m-0 text-ui font-semibold">Not written yet</p>
          <p className="m-0 text-meta leading-base text-muted">
            Ferrets are using a default built from the model catalogs. Tell a short-lived ferret what you want, in your
            own words, as long as you like, or leave it out, and it writes a routing prompt that names the models you
            really have here.
          </p>
          <IdeaField
            id={`${id}-idea`}
            value={idea}
            onChange={setIdea}
            onSubmit={submitWrite}
            disabled={busy || running}
          />
          <Button
            variant="primary"
            className="min-h-[52px] w-full text-ui sm:w-auto"
            disabled={busy || writeBlock !== null}
            onClick={startWrite}
            data-routing-action="write"
          >
            Write it for me
          </Button>
          {writeBlock === null || running ? null : (
            <p className="m-0 break-words text-meta leading-base text-warn" data-routing-write-blocked="">
              {writeBlock}
            </p>
          )}
          <button
            type="button"
            className="min-h-[44px] self-start text-ui text-accent underline"
            onClick={() => setByHand(true)}
            data-routing-action="by-hand"
          >
            Or write it by hand
          </button>
        </div>
      ) : (
        <>
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
          <div
            className="flex min-w-0 flex-col gap-2 rounded-control border border-border-soft bg-surface-2 p-3"
            data-routing-write=""
          >
            <IdeaField
              id={`${id}-idea`}
              value={idea}
              onChange={setIdea}
              onSubmit={submitWrite}
              disabled={busy || running}
            />
            <Button
              variant="primary"
              className="min-h-[44px] w-full sm:w-auto sm:self-start"
              disabled={busy || writeBlock !== null}
              onClick={startWrite}
              data-routing-action="write"
            >
              Write it for me
            </Button>
            {writeBlock === null || running ? null : (
              <p className="m-0 break-words text-meta leading-base text-warn" data-routing-write-blocked="">
                {writeBlock}
              </p>
            )}
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
            <Button className="min-h-[44px]" disabled={busy || !canSave} onClick={save} data-routing-action="save">
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
                Undo
              </Button>
            )}
          </div>
          {cleanUpBlock === null || running ? null : (
            <p className="m-0 break-words text-meta leading-base text-warn" data-routing-clean-up-blocked="">
              {cleanUpBlock}
            </p>
          )}
          <p className="m-0 text-meta leading-base text-faint">
            Write it for me has a short-lived ferret write the whole prompt from your idea; Clean up rewrites what is in
            the box. Both read this machine’s runtimes, models and quota, spend one model run only when you press them,
            and save nothing until you accept.
          </p>
        </>
      )}
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
          mode={job?.mode ?? 'clean-up'}
          busy={busy}
          onAccept={accept}
          onEdit={() => {
            setDraft(suggestion.after);
            setByHand(true);
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

/** Rows the idea field shows empty, and the most it grows to before it scrolls. */
const IDEA_MIN_ROWS = 4;
const IDEA_MAX_ROWS = 12;

/** The one optional note Write it for me takes: what the owner wants, in their own words, as long as they like. */
function IdeaField({
  id,
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly disabled: boolean;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const counterId = `${id}-count`;
  const fill = ideaFill(value);

  // Grow with the text up to IDEA_MAX_ROWS (the CSS max-height), then scroll inside the box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the re-measure trigger; the effect reads the node
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    field.style.height = 'auto';
    field.style.height = `${String(field.scrollHeight + field.offsetHeight - field.clientHeight)}px`;
  }, [value]);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-ui font-semibold">
        Your idea (optional)
      </label>
      <textarea
        ref={fieldRef}
        id={id}
        className="kt-input w-full resize-none overflow-y-auto"
        style={{ maxHeight: `calc(${String(IDEA_MAX_ROWS)}lh + 2 * var(--pad-row-y) + 2 * var(--stroke-control))` }}
        rows={IDEA_MIN_ROWS}
        value={value}
        maxLength={MAX_IDEA_CHARS}
        disabled={disabled}
        aria-describedby={counterId}
        placeholder="Cheap models for chores, Opus for planning, never burn the Claude weekly quota"
        onChange={event => onChange(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onSubmit();
        }}
        data-routing-idea=""
      />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-meta">
        <span className="min-w-0 text-faint">Enter adds a line; Cmd or Ctrl + Enter writes it.</span>
        <span
          id={counterId}
          className={cn(
            'mono shrink-0',
            fill === 'full' ? 'font-semibold text-err' : fill === 'near' ? 'font-semibold text-warn' : 'text-muted',
          )}
          data-idea-counter={fill}
        >
          {ideaCounter(value)}
          <span className="sr-only"> characters</span>
        </span>
      </div>
    </div>
  );
}
