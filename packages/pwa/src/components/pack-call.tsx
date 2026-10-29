/**
 * A SUB-FERRET'S START, shown in its parent's chat as what it is instead of the shell command that did it.
 *
 * A ferret in Pack mode (docs/pack-mode.md) starts a sub-ferret by running the CLI's `new`, asks which model
 * suits a part with `recommend`, and collects a result with `wait`. Each left a tool call reading
 * `Bash · fy new --runtime … "<brief>"` that the reader had to parse. These cards say what happened, the
 * way "Sent to" does for a message (`sent-message.tsx`):
 *
 *   - "Started sub-ferret :name" — the sub-ferret as a proved `:name` reference, the runtime, model and
 *     effort it runs on, the brief it was given (folded), the probe, how it is doing NOW (from the
 *     daemon's session list, so the card stays live), and — once the parent waited for it — its result.
 *   - "Sub-ferret not started" — the refusal's code and message, every candidate tried, and whether the
 *     ferret tried again (the next start is a card of its own, below).
 *   - "Waited for :name" — a wait whose start is not in this transcript.
 *   - "Asked which model suits" — the task, the routing prompt in effect (folded) and the models usable here
 *     now, with what the prompt names and what quota they have left (folded).
 *
 * The call it came from is one tap away under "Show command", as on "Sent to" (`pack-calls.ts` reads it).
 */

import type { SessionView } from '@ferretry/protocol';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { clockOfInstant } from '../lib/message-clock.ts';
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
import type { TranscriptEntry } from '../lib/session-screens.ts';
import { sessionStatusLabel } from '../lib/session-screens.ts';
import { subFerretState } from '../lib/sub-ferret-state.ts';
import { PeerName } from './agent-message-rows.tsx';
import { Markdown } from './markdown.tsx';
import { useReferenceSurface } from './reference-surface.tsx';
import { MessageFooter } from './send-receipt.tsx';
import { SubFerretStateLabel } from './sub-ferrets.tsx';
import { ToolGroup } from './tool-group.tsx';

// ── The live session list ───────────────────────────────────────────────────────────────────────

/** This daemon's sessions, so a card can say how the sub-ferret it started is doing now. */
const PackSessionsContext = createContext<readonly SessionView[] | undefined>(undefined);

export function PackSessionsProvider({
  sessions,
  children,
}: {
  readonly sessions: readonly SessionView[] | undefined;
  readonly children: ReactNode;
}) {
  return <PackSessionsContext.Provider value={sessions}>{children}</PackSessionsContext.Provider>;
}

const usePackSession = (id: string): SessionView | undefined =>
  useContext(PackSessionsContext)?.find(view => view.config.id === id);

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

/** A wait's answer: the status it ended on and the result the sub-ferret reported. */
function WaitResult({ outcome }: { readonly outcome: PackWaitOutcome }) {
  const surface = useReferenceSurface();
  return (
    <>
      <p className="fy-pack-line">
        <span className="fy-pack-muted">Ended {sessionStatusLabel(outcome.status)}</span>
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

/** How the started sub-ferret is doing now, when the session list has it. */
function LiveState({ id }: { readonly id: string }) {
  const view = usePackSession(id);
  if (view === undefined) return null;
  return (
    <p className="fy-pack-line" data-pack-live="">
      <SubFerretStateLabel reading={subFerretState(view)} />
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
              ? 'Starting a sub-ferret…'
              : progress.state === 'failed'
                ? 'Could not start a sub-ferret'
                : 'Sub-ferret start'}
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
          <span className="fy-sent-label">Sub-ferret not started</span>
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
        <span className="fy-sent-label">Started sub-ferret</span>
        <PeerName peer={{ name: outcome.teammate ?? outcome.id, sessionId: outcome.id }} surface={surface} />
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
        <PeerName peer={{ name: call.id, sessionId: call.id }} surface={surface} />
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
