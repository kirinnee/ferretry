/**
 * A SUB-FERRET'S START, shown in its parent's chat as what it is instead of the shell command that did it.
 *
 * A ferret in Pack mode (docs/pack-mode.md) starts a helper by running the CLI's `new`, asks which model
 * suits a part with `recommend`, and collects a result with `wait`. Each left a tool call reading
 * `Bash · fy new --runtime … "<brief>"` that the reader had to parse. These cards say what happened, the
 * way "Sent to" does for a message (`sent-message.tsx`):
 *
 *   - "Started helper :name" — the helper as a proved `:name` reference, the runtime, model and
 *     effort it runs on, the brief it was given (folded), the probe, how it is doing NOW (from the
 *     daemon's pack table, so the card stays live), and — once the parent waited for it — its result.
 *   - "Helper not started" — the refusal's code and message, every candidate tried, and whether the
 *     ferret tried again (the next start is a card of its own, below).
 *   - "Waited for :name" — a wait whose start is not in this transcript.
 *   - "Asked which model suits" — the task, the routing prompt in effect (folded) and the models usable here
 *     now, with what the prompt names and what quota they have left (folded).
 *
 * The call it came from is one tap away under "Show command", as on "Sent to" (`pack-calls.ts` reads it).
 */

import { createContext, type ReactNode, useContext, useState } from 'react';
import type { PackRow } from '../../contract/index.ts';
import { helperState } from '../lib/helper-state.ts';
import type {
  PackAdvice,
  PackCall,
  PackProgress,
  PackRecommendCall,
  PackStartCall,
  PackTry,
  PackWaitCall,
  PackWaitOutcome,
} from '../lib/pack-calls.ts';
import { clockOfInstant, stateLabel, type TranscriptEntry } from '../lib/shell-ports.ts';
import { Markdown, MessageFooter, PeerName, ToolGroup, useReferenceSurface } from '../ui.ts';
import { HelperStateLabel } from './helpers.tsx';

// ── The live pack table ─────────────────────────────────────────────────────────────────────────

/** The lead's pack table rows, so a card can say how the helper it started is doing now. */
const PackRowsContext = createContext<readonly PackRow[] | undefined>(undefined);

export function PackRowsProvider({
  rows,
  children,
}: {
  readonly rows: readonly PackRow[] | undefined;
  readonly children: ReactNode;
}) {
  return <PackRowsContext.Provider value={rows}>{children}</PackRowsContext.Provider>;
}

const usePackRow = (id: string): PackRow | undefined => useContext(PackRowsContext)?.find(row => row.id === id);

// ── Parts ───────────────────────────────────────────────────────────────────────────────────────

type Rhythm = Record<string, string | undefined>;

/** `<runtime> · <model> · effort <level>`, leaving out what is unknown. */
const runsOn = (runtime?: string, model?: string, effort?: string): string =>
  [runtime, model, effort === undefined ? undefined : `effort ${effort}`].filter(Boolean).join(' · ');

const probeWords = (probe: PackTry['probe']): string | undefined =>
  probe === undefined ? undefined : probe === 'cached' ? 'probe cached' : `probe ${String(probe)} ms`;

/** Every candidate a start tried, in order. */
function Attempts({ attempts }: { readonly attempts: readonly PackTry[] }) {
  if (attempts.length === 0) return null;
  return (
    <ol className="fy-pack-attempts" data-pack-attempts="">
      {attempts.map((attempt, index) => (
        <li data-pack-attempt={attempt.outcome} key={`${attempt.runtime}:${attempt.model ?? ''}:${String(index)}`}>
          <span className="fy-pack-attempt-outcome">{attempt.outcome}</span>{' '}
          <span className="fy-pack-mono">{runsOn(attempt.runtime, attempt.model)}</span>
          {probeWords(attempt.probe) === undefined ? null : (
            <span className="fy-pack-muted"> ({probeWords(attempt.probe)})</span>
          )}
          {attempt.code === undefined ? null : (
            <span className="fy-pack-refusal">
              {' '}
              — <code>{attempt.code}</code>
              {attempt.message === undefined || attempt.message === '' ? null : `: ${attempt.message}`}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A folded block: a one-line summary that opens to the whole. */
function Fold({
  label,
  preview,
  children,
}: {
  readonly label: string;
  readonly preview?: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="fy-pack-fold">
      <summary>
        <span className="fy-pack-fold-label">{label}</span>
        {preview === undefined ? null : <span className="fy-pack-fold-preview">{preview}</span>}
      </summary>
      <div className="fy-pack-fold-body">{children}</div>
    </details>
  );
}

const firstLine = (text: string): string =>
  text
    .split('\n')
    .find(line => line.trim() !== '')
    ?.trim() ?? '';

/** The brief a start was given, folded to its first line. */
function Brief({ call }: { readonly call: PackStartCall }) {
  const surface = useReferenceSurface();
  if (call.brief === null)
    return (
      <p className="fy-pack-muted fy-pack-line">
        {call.briefFile === undefined
          ? 'The brief was composed by a shell command.'
          : `The brief was read from ${call.briefFile}.`}
      </p>
    );
  if (call.brief === '') return null;
  return (
    <Fold label="Brief" preview={firstLine(call.brief)}>
      <Markdown text={call.brief} {...surface} />
    </Fold>
  );
}

/** A wait's answer: the status it ended on and the result the helper reported. */
function WaitResult({ outcome }: { readonly outcome: PackWaitOutcome }) {
  const surface = useReferenceSurface();
  return (
    <>
      <p className="fy-pack-line">
        <span className="fy-pack-muted">Ended {stateLabel(outcome.status)}</span>
        {outcome.stopped ? <span className="fy-pack-muted"> · stopped once its result was collected</span> : null}
      </p>
      {outcome.summary === undefined ? (
        <p className="fy-pack-muted fy-pack-line">It reported no result.</p>
      ) : (
        <Markdown className="fy-pack-result-body" text={outcome.summary} {...surface} />
      )}
      {outcome.note === undefined ? null : <p className="fy-pack-muted fy-pack-line">{outcome.note}</p>}
    </>
  );
}

/** Where a wait got to, inside a start's card or on its own. */
function Collected({ progress }: { readonly progress: PackProgress<PackWaitOutcome> }) {
  return (
    <section className="fy-pack-result" data-pack-collected={progress.state}>
      <p className="fy-pack-section-title">
        {progress.state === 'running'
          ? 'Waiting for its result…'
          : progress.state === 'done'
            ? 'Result collected'
            : progress.state === 'failed'
              ? 'Could not collect its result'
              : 'Result collected — not recognised; see the command'}
      </p>
      {progress.state === 'done' ? <WaitResult outcome={progress.value} /> : null}
      {progress.state === 'failed' ? <p className="fy-pack-error fy-pack-line">{progress.reason}</p> : null}
    </section>
  );
}

/** "Show command" and the time, under every card. */
function Foot({
  entry,
  live,
  isLast,
}: {
  readonly entry: TranscriptEntry;
  readonly live: boolean;
  readonly isLast: boolean;
}) {
  const [showCommand, setShowCommand] = useState(false);
  return (
    <>
      <div className="fy-sent-foot">
        <button
          aria-expanded={showCommand}
          className="fy-sent-command-toggle"
          onClick={() => setShowCommand(current => !current)}
          type="button"
        >
          {showCommand ? 'Hide command' : 'Show command'}
        </button>
        <MessageFooter clock={clockOfInstant(entry.at)} side="other" />
      </div>
      {showCommand && entry.tools !== undefined ? <ToolGroup calls={entry.tools} isLast={isLast} live={live} /> : null}
    </>
  );
}

// ── The cards ───────────────────────────────────────────────────────────────────────────────────

/** How the started helper is doing now, when the pack table has it. */
function LiveState({ id }: { readonly id: string }) {
  const row = usePackRow(id);
  if (row === undefined) return null;
  return (
    <p className="fy-pack-line" data-pack-live="">
      <HelperStateLabel reading={helperState(row)} />
    </p>
  );
}

function StartCard({ call }: { readonly call: PackStartCall }) {
  const surface = useReferenceSurface();
  const { progress } = call;
  const asked = runsOn(call.auto ? 'chosen by Ferretry' : call.runtime, call.model, call.effort);
  if (progress.state !== 'done')
    return (
      <>
        <header>
          <span className="fy-sent-label">
            {progress.state === 'running'
              ? 'Starting a helper…'
              : progress.state === 'failed'
                ? 'Could not start a helper'
                : 'Helper start'}
          </span>
        </header>
        {asked === '' ? null : <p className="fy-pack-mono fy-pack-line">{asked}</p>}
        {progress.state === 'failed' ? (
          <p className="fy-pack-error fy-pack-line" role="alert">
            {progress.reason}
          </p>
        ) : null}
        {progress.state === 'unread' ? (
          <p className="fy-pack-muted fy-pack-line">Its answer was not recognised — see the command.</p>
        ) : null}
        <Brief call={call} key="brief" />
      </>
    );
  const outcome = progress.value;
  if (outcome.outcome === 'refused')
    return (
      <>
        <header>
          <span className="fy-sent-label">Helper not started</span>
          <code className="fy-pack-code">{outcome.code}</code>
        </header>
        {asked === '' ? null : <p className="fy-pack-mono fy-pack-line">{asked}</p>}
        <p className="fy-pack-error fy-pack-line" role="alert">
          {outcome.message}
        </p>
        {outcome.remedy === undefined ? null : <p className="fy-pack-muted fy-pack-line">{outcome.remedy}</p>}
        {outcome.attempts.length === 0 ? null : (
          <>
            <p className="fy-pack-section-title">Tried</p>
            <Attempts attempts={outcome.attempts} />
          </>
        )}
        {call.retried === true ? (
          <p className="fy-pack-line fy-pack-retried" data-pack-retried="">
            Tried again — the next start is below.
          </p>
        ) : null}
        <Brief call={call} key="brief" />
      </>
    );
  const started = outcome.attempts.filter(attempt => attempt.outcome === 'started').at(-1);
  const probe =
    started?.probe === undefined
      ? undefined
      : started.probe === 'cached'
        ? 'probe cached'
        : `answered the probe in ${String(started.probe)} ms`;
  return (
    <>
      <header>
        <span className="fy-sent-label">Started helper</span>
        <PeerName peer={{ name: outcome.name ?? outcome.id, ferretId: outcome.id }} surface={surface} />
      </header>
      <p className="fy-pack-mono fy-pack-line">
        {runsOn(outcome.runtime, outcome.model ?? call.model, outcome.effort ?? call.effort)}
      </p>
      <p className="fy-pack-muted fy-pack-line">
        {[`decided by ${outcome.decidedBy}`, probe].filter(Boolean).join(' · ')}
      </p>
      {outcome.note === undefined ? null : <p className="fy-pack-muted fy-pack-line">{outcome.note}</p>}
      {outcome.attempts.length > 1 ? (
        <Fold label={`Tried ${String(outcome.attempts.length)} candidates`}>
          <Attempts attempts={outcome.attempts} />
        </Fold>
      ) : null}
      <LiveState id={outcome.id} />
      <Brief call={call} key="brief" />
      {call.collected === undefined ? null : <Collected progress={call.collected} />}
    </>
  );
}

function WaitCard({ call }: { readonly call: PackWaitCall }) {
  const surface = useReferenceSurface();
  return (
    <>
      <header>
        <span className="fy-sent-label">Waited for</span>
        <PeerName peer={{ name: call.id, ferretId: call.id }} surface={surface} />
      </header>
      <LiveState id={call.id} />
      <Collected progress={call.progress} />
    </>
  );
}

/** 1 → "1st", 2 → "2nd", 11 → "11th": where the routing prompt first names a model (as the CLI says it). */
const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10];
  return `${String(n)}${suffix ?? 'th'}`;
};

/** The routing prompt in effect, folded to its first line, and where it came from. */
function RoutingPrompt({ advice }: { readonly advice: PackAdvice }) {
  const surface = useReferenceSurface();
  return (
    <Fold label="Routing prompt" preview={firstLine(advice.routing)}>
      {advice.source === undefined ? null : <p className="fy-pack-muted fy-pack-line">{advice.source}</p>}
      <Markdown text={advice.routing} {...surface} />
    </Fold>
  );
}

function AdviceList({ advice }: { readonly advice: PackAdvice }) {
  return (
    <>
      <ul className="fy-pack-options" data-pack-options="">
        {advice.options.map((choice, index) => (
          <li data-pack-ready={choice.ready ? 'true' : 'false'} key={`${String(index)}:${choice.id}:${choice.runtime}`}>
            <span className="fy-pack-option-head">
              <span className="fy-pack-mono">{choice.model}</span>
              <span className={choice.ready ? 'fy-pack-ready' : 'fy-pack-cannot'}>
                {choice.ready ? 'ready' : 'cannot run'}
              </span>
            </span>
            <span className="fy-pack-muted fy-pack-mono"> {runsOn(choice.runtime, choice.id, choice.effort)}</span>
            {choice.named === undefined && choice.quota === undefined ? null : (
              <span className="fy-pack-option-why">
                {[
                  choice.named === undefined ? undefined : `named ${ordinal(choice.named)} in the prompt`,
                  choice.quota === undefined ? undefined : `quota ${choice.quota}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            {choice.refusal === undefined ? null : <span className="fy-pack-refusal">{choice.refusal}</span>}
          </li>
        ))}
      </ul>
      {advice.next === undefined ? <p className="fy-pack-muted fy-pack-line">Nothing can run it here now.</p> : null}
    </>
  );
}

function RecommendCard({ call }: { readonly call: PackRecommendCall }) {
  const { progress } = call;
  const ready = progress.state === 'done' ? progress.value.options.filter(choice => choice.ready).length : 0;
  return (
    <>
      <header>
        <span className="fy-sent-label">Asked which model suits</span>
      </header>
      {call.task === null || call.task === '' ? null : <p className="fy-pack-task fy-pack-line">{call.task}</p>}
      {progress.state === 'running' ? <p className="fy-pack-muted fy-pack-line">Asking…</p> : null}
      {progress.state === 'failed' ? <p className="fy-pack-error fy-pack-line">{progress.reason}</p> : null}
      {progress.state === 'unread' ? (
        <p className="fy-pack-muted fy-pack-line">Its answer was not recognised — see the command.</p>
      ) : null}
      {progress.state === 'done' ? (
        <>
          <RoutingPrompt advice={progress.value} />
          <Fold
            label={`${String(progress.value.options.length)} models, ${String(ready)} ready`}
            preview={progress.value.options[0]?.model ?? ''}
          >
            <AdviceList advice={progress.value} />
          </Fold>
        </>
      ) : null}
    </>
  );
}

const KIND: Readonly<Record<PackCall['kind'], string>> = { new: 'start', wait: 'wait', recommend: 'recommend' };

export function PackCallRow({
  entry,
  pack,
  rhythm,
  live = false,
  isLast = false,
}: {
  readonly entry: TranscriptEntry;
  readonly pack: PackCall;
  readonly rhythm: Rhythm;
  readonly live?: boolean;
  readonly isLast?: boolean;
}) {
  const state =
    pack.kind === 'new' && pack.progress.state === 'done' ? pack.progress.value.outcome : pack.progress.state;
  return (
    <article
      className="fy-message fy-message-pack"
      data-pack-kind={KIND[pack.kind]}
      data-pack-state={state}
      data-transcript-kind="pack"
      {...rhythm}
    >
      {pack.kind === 'new' ? <StartCard call={pack} /> : null}
      {pack.kind === 'wait' ? <WaitCard call={pack} /> : null}
      {pack.kind === 'recommend' ? <RecommendCard call={pack} /> : null}
      <Foot entry={entry} isLast={isLast} live={live} />
    </article>
  );
}
