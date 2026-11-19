/**
 * TRY IT — records a short take with one engine and shows the words and the timings (Settings › Voice › Engine).
 * It changes nothing: not the draft, not the engine in use. Moved here from the old engine list (r10 S5) so the
 * engine cards stay short and "Try it" sits in one row under them, for whichever engine is chosen.
 */

import { FlaskConical, Mic, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../shell-voice.ts';
import {
  type EngineTrial,
  type EngineTrialPorts,
  type EngineTrialResult,
  type EngineTrialUpdate,
  formatSeconds,
  startEngineTrial,
  TRIAL_RECORD_MS,
} from '../../lib/stt/engine-trial.ts';
import type { OnDeviceSession, OnDeviceSessionOptions } from '../../lib/stt/on-device-voice.ts';

export const TRIAL_EXPLANATION = `Try it records ${TRIAL_RECORD_MS / 1000} seconds and shows what it heard and how long it took. It changes nothing: not your draft, not the engine in use.`;

/** The clock a trial runs on. Tests pass their own; production uses the page's. */
export type TrialClock = Pick<EngineTrialPorts, 'now' | 'setTimeout' | 'clearTimeout' | 'recordMs'>;

export const pageClock: TrialClock = {
  now: () => globalThis.performance?.now() ?? Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type TrialState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly update: EngineTrialUpdate }
  | { readonly kind: 'done'; readonly result: EngineTrialResult }
  | { readonly kind: 'failed'; readonly message: string };

const TRIAL_PHASE_COPY: Readonly<Record<EngineTrialUpdate['phase'], string>> = {
  opening: 'Opening the microphone…',
  recording: `Recording ${TRIAL_RECORD_MS / 1000} s — say a sentence.`,
  transcribing: 'Transcribing…',
};

/** Records a short take with one engine and shows the words and the timings. */
export function EngineTrialControl({
  name,
  open,
  clock,
}: {
  readonly name: string;
  open(options: OnDeviceSessionOptions): OnDeviceSession;
  readonly clock: TrialClock;
}) {
  const [state, setState] = useState<TrialState>({ kind: 'idle' });
  const trialRef = useRef<EngineTrial | null>(null);
  useEffect(() => () => trialRef.current?.cancel(), []);

  const start = (): void => {
    trialRef.current?.cancel();
    // Updates can arrive while the trial is still being started, before it has a name to compare.
    const owner = { trial: null as EngineTrial | null };
    const trial = startEngineTrial({ ...clock, open }, update => {
      if (owner.trial === null || trialRef.current === owner.trial) setState({ kind: 'running', update });
    });
    owner.trial = trial;
    trialRef.current = trial;
    trial.result.then(
      result => {
        if (trialRef.current !== trial) return;
        trialRef.current = null;
        setState({ kind: 'done', result });
      },
      (error: unknown) => {
        if (trialRef.current !== trial) return;
        trialRef.current = null;
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 'aborted') setState({ kind: 'idle' });
        else setState({ kind: 'failed', message: error instanceof Error ? error.message : 'The trial failed.' });
      },
    );
  };

  if (state.kind === 'running')
    return (
      <div className="flex flex-col gap-2 rounded-control border border-border bg-surface p-2" data-trial="running">
        <p className="m-0 flex items-center gap-1 text-meta text-fg" role="status">
          <Mic size={14} aria-hidden="true" className="shrink-0 text-accent" />
          <span>{TRIAL_PHASE_COPY[state.update.phase]}</span>
        </p>
        {state.update.live === '' ? null : <p className="m-0 text-meta leading-base text-muted">{state.update.live}</p>}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={() => trialRef.current?.cancel()}
          >
            <X size={14} aria-hidden="true" />
            <span className="ml-1">Stop trial</span>
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      {state.kind === 'done' ? (
        <div className="flex flex-col gap-1 rounded-control border border-border bg-surface p-2" data-trial="done">
          <p className="m-0 text-ui leading-base text-fg">
            {state.result.text === '' ? <span className="text-faint">(nothing heard)</span> : `“${state.result.text}”`}
          </p>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-meta leading-base">
            <dt className="text-muted">Microphone open</dt>
            <dd className="m-0 mono tabular-nums text-fg">{formatSeconds(state.result.openMs)}</dd>
            <dt className="text-muted">First words</dt>
            <dd className="m-0 mono tabular-nums text-fg">
              {state.result.firstWordMs === null ? 'after Stop' : `${formatSeconds(state.result.firstWordMs)} in`}
            </dd>
            <dt className="text-muted">Text after Stop</dt>
            <dd className="m-0 mono tabular-nums text-fg">{formatSeconds(state.result.finishMs)}</dd>
            {state.result.loadMs === null ? null : (
              <>
                <dt className="text-muted">Model load (first take only)</dt>
                <dd className="m-0 mono tabular-nums text-fg">{formatSeconds(state.result.loadMs)}</dd>
              </>
            )}
            {state.result.model === undefined ? null : (
              <>
                <dt className="text-muted">Ran on</dt>
                <dd className="m-0 min-w-0 break-words text-fg">{state.result.model}</dd>
              </>
            )}
          </dl>
        </div>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="m-0 text-meta leading-base text-warn" role="alert">
          {state.message}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-[44px]"
          onClick={start}
          aria-label={`Try ${name}`}
        >
          <FlaskConical size={14} aria-hidden="true" />
          <span className="ml-1">{state.kind === 'idle' ? `Try it (${TRIAL_RECORD_MS / 1000} s)` : 'Try again'}</span>
        </Button>
      </div>
    </div>
  );
}
