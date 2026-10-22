/**
 * SUGGEST A GUIDE (docs/pack-mode.md § Suggesting a guide): ask a short-lived builder ferret to draft the
 * models guide from the models this machine has, then review its draft use case by use case.
 *
 * The one thing that spends anything is the button: it starts a ferret that runs the model once. The job is
 * read only while this panel is mounted and the run is going, and nothing is written to the guide until the
 * review is accepted — and an accepted suggestion can be undone.
 */

import {
  type GuideRouting,
  type GuideUseCase,
  MAX_ROUTING_PREFERENCES_CHARS,
  type PackGuideBuilder,
  type PackGuideJob,
  type PackGuideSuggestion,
} from '@ferretry/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { formatElapsedSeconds } from '../../lib/live-counter.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { absoluteTime } from '../../lib/session-screens.ts';
import { Badge, type BadgeTone, Button } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { GuideReviewView } from './guide-review-view.tsx';
import type { GuideWrite, MachinePack } from './use-machine-pack.ts';

/** How often a running builder is read, in milliseconds. */
const GUIDE_POLL_MS = 3_000;

const JOB_BADGE: Readonly<Record<PackGuideJob['status'], { readonly tone: BadgeTone; readonly label: string }>> = {
  running: { tone: 'accent', label: 'Running' },
  suggested: { tone: 'ok', label: 'Suggested' },
  failed: { tone: 'err', label: 'Failed' },
};

export interface GuideSuggestPanelProps {
  readonly connection: DaemonConnection;
  readonly state: Pick<MachinePack, 'suggest' | 'readJob' | 'acceptGuide' | 'undoGuide' | 'saveConfig'>;
  readonly builder: PackGuideBuilder | undefined;
  /** What `pack.yaml` remembers as the owner's routing preferences. */
  readonly preferences: string;
  /** The ticked result, to be loaded into the editor's draft. */
  readonly onEdit: (guide: { readonly useCases: readonly GuideUseCase[]; readonly routing?: GuideRouting }) => void;
  readonly pollMs?: number;
  readonly clock?: () => number;
  /** A run and its suggestion the panel starts on (harness, tests). */
  readonly initial?: { readonly job: PackGuideJob; readonly suggestion?: PackGuideSuggestion };
}

function SessionLink({ connection, job }: { readonly connection: DaemonConnection; readonly job: PackGuideJob }) {
  const router = useOptionalRouter();
  return (
    <RouteLink
      to={daemonSessionPath(connection.daemonId, job.session)}
      {...(router ? { onNavigate: router.navigate } : {})}
      className="inline-flex min-h-[44px] items-center text-ui text-accent underline"
      data-guide-job-session=""
    >
      Open the builder’s session
    </RouteLink>
  );
}

function JobCard({
  connection,
  job,
  nowMs,
  readError,
}: {
  readonly connection: DaemonConnection;
  readonly job: PackGuideJob;
  readonly nowMs: number;
  readonly readError: string | null;
}) {
  const badge = JOB_BADGE[job.status];
  const started = Date.parse(job.startedAt);
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-control border border-border-strong bg-surface-2 p-3"
      data-guide-job={job.status}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="min-w-0 break-all text-ui font-semibold" data-guide-job-name="">
          {job.name}
        </span>
      </div>
      <p className="m-0 min-w-0 break-words text-meta leading-base text-muted">
        On <span className="mono">{job.runtime}</span>
        {job.model === undefined ? (
          ''
        ) : (
          <>
            {' '}
            · <span className="mono">{job.model}</span>
          </>
        )}
        {job.status === 'running'
          ? ` · running for ${formatElapsedSeconds((nowMs - started) / 1000)}`
          : ` · started ${absoluteTime(job.startedAt)}`}
      </p>
      {job.status === 'failed' ? (
        <p role="alert" className="m-0 break-words text-meta leading-base text-err" data-guide-job-message="">
          {job.message ?? 'The builder stopped without a draft.'}
        </p>
      ) : null}
      {readError === null ? null : (
        <p role="status" className="m-0 break-words text-meta leading-base text-warn">
          Could not read the builder just now ({readError}) — trying again.
        </p>
      )}
      <SessionLink connection={connection} job={job} />
    </div>
  );
}

export function GuideSuggestPanel({
  connection,
  state,
  builder,
  preferences,
  onEdit,
  pollMs = GUIDE_POLL_MS,
  clock = Date.now,
  initial,
}: GuideSuggestPanelProps) {
  const id = useId().replace(/:/gu, '');
  const runtimes = builder?.runtimes ?? [];
  const available = builder?.available === true;
  const [runtime, setRuntime] = useState('');
  const [words, setWords] = useState(preferences);
  const [drawnFrom, setDrawnFrom] = useState(preferences);
  const [remember, setRemember] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [job, setJob] = useState<PackGuideJob | null>(initial?.job ?? null);
  const [suggestion, setSuggestion] = useState<PackGuideSuggestion | null>(initial?.suggestion ?? null);
  const [readError, setReadError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [done, setDone] = useState<(GuideWrite & { readonly undoable: boolean }) | null>(null);
  const [nowMs, setNowMs] = useState(clock);
  const readJob = useRef(state.readJob);
  readJob.current = state.readJob;
  const clockRef = useRef(clock);
  clockRef.current = clock;

  if (preferences !== drawnFrom) {
    if (words === drawnFrom) setWords(preferences);
    setDrawnFrom(preferences);
  }

  // A run already going when the page opens is picked up, so a reload does not lose it.
  const adopted = useRef(false);
  const running = builder?.job;
  useEffect(() => {
    if (adopted.current || running === undefined || running.status !== 'running') return;
    adopted.current = true;
    setJob(current => current ?? running);
  }, [running]);

  const jobId = job?.id;
  const jobRunning = job?.status === 'running';
  useEffect(() => {
    if (jobId === undefined || !jobRunning) return;
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
  }, [jobId, jobRunning, pollMs]);

  const start = (): void => {
    setStarting(true);
    setProblem(null);
    setDone(null);
    setSuggestion(null);
    setReadError(null);
    const preferencesText = words.trim();
    void (async () => {
      if (remember) {
        const saved = await state.saveConfig({ routingPreferences: preferencesText });
        if (saved.kind === 'refused') {
          setProblem(`Your preferences were not saved, so no run was started. ${saved.message}`);
          setStarting(false);
          return;
        }
      }
      const started = await state.suggest({
        ...(runtime === '' ? {} : { runtime }),
        preferences: preferencesText,
      });
      if (started.kind === 'started') {
        setJob(started.job);
        setNowMs(clockRef.current());
      } else setProblem(started.message);
      setStarting(false);
    })();
  };

  const accept = (request: Parameters<MachinePack['acceptGuide']>[0]): void => {
    setWriting(true);
    void state.acceptGuide(request).then(result => {
      setWriting(false);
      if (result.kind === 'refused') {
        setProblem(result.message);
        return;
      }
      setProblem(null);
      setSuggestion(null);
      setJob(null);
      setDone({ ...result, undoable: result.kind === 'applied' });
    });
  };
  const undo = (): void => {
    setWriting(true);
    void state.undoGuide().then(result => {
      setWriting(false);
      setDone(result.kind === 'refused' ? null : { ...result, undoable: false });
      setProblem(result.kind === 'refused' ? result.message : null);
    });
  };

  const blocked = !available;
  return (
    <section className="kt-panel flex min-w-0 flex-col gap-3 p-4" aria-labelledby={`${id}-h`} data-guide-suggest="">
      <div className="min-w-0">
        <h3 id={`${id}-h`} className="m-0 text-ui font-semibold">
          Suggest a guide
        </h3>
        <p className="m-0 mt-1 text-meta leading-base text-muted">
          A short-lived ferret reads the models this machine has and drafts the guide. It spends one model run on the
          runtime you pick, only now, when you press the button. Nothing is written until you review the draft and
          accept it.
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-runtime`} className="text-meta font-semibold text-fg-soft">
            Runtime
          </label>
          <select
            id={`${id}-runtime`}
            className="kt-input min-h-[44px] w-full"
            value={runtime}
            disabled={blocked || starting}
            onChange={event => setRuntime(event.currentTarget.value)}
          >
            <option value="">Best ready{runtimes[0] === undefined ? '' : ` (${runtimes[0]})`}</option>
            {runtimes.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-prefs`} className="text-meta font-semibold text-fg-soft">
            Preferences <span className="font-normal text-muted">(in your own words, optional)</span>
          </label>
          <textarea
            id={`${id}-prefs`}
            className="kt-input min-h-[44px] w-full resize-y"
            rows={3}
            maxLength={MAX_ROUTING_PREFERENCES_CHARS}
            placeholder="For example: prefer cheap models for chores; never use a model that is not on this machine."
            value={words}
            disabled={starting}
            onChange={event => setWords(event.currentTarget.value)}
            data-guide-preferences=""
          />
        </div>
      </div>
      <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-ui">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={remember}
          disabled={starting}
          onChange={event => setRemember(event.currentTarget.checked)}
          data-guide-remember=""
        />
        Remember these preferences in pack.yaml
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          className="min-h-[44px]"
          disabled={blocked || starting || jobRunning}
          onClick={start}
          data-guide-start=""
        >
          Suggest a guide
        </Button>
        {blocked ? (
          <span className="min-w-0 break-words text-meta leading-base text-warn" data-guide-unavailable="">
            {builder?.reason ?? 'This machine cannot build a guide: its daemon is too old to offer it.'}
          </span>
        ) : null}
      </div>
      {problem === null ? null : (
        <p role="alert" className="m-0 break-words text-meta leading-base text-err" data-guide-problem="">
          {problem}
        </p>
      )}
      {job === null ? null : <JobCard connection={connection} job={job} nowMs={nowMs} readError={readError} />}
      {suggestion === null ? null : (
        <GuideReviewView
          suggestion={suggestion}
          busy={writing}
          onAccept={accept}
          onEdit={guide => {
            onEdit(guide);
            setSuggestion(null);
            setJob(null);
          }}
          onDiscard={() => {
            setSuggestion(null);
            setJob(null);
          }}
        />
      )}
      {done === null ? null : (
        <div
          role="status"
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-ok-border bg-ok-bg px-3 py-2',
          )}
          data-guide-done=""
        >
          <span className="min-w-0 flex-1 break-words text-meta leading-base text-ok">{done.message}</span>
          {done.undoable ? (
            <Button className="min-h-[44px]" disabled={writing} onClick={undo} data-guide-undo="">
              Undo
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
