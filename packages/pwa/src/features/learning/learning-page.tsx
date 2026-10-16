/**
 * THE LEARNING HUB (Insights › Learning): every lesson the fleet's ferrets filed or a scan found, and the
 * owner's verdict on each.
 *
 * Ferrets instructed to learn file lessons with `fy lesson suggest "…" --scope global|repo`; a scan reads
 * older transcripts. Nothing reaches an instruction file until the owner APPLIES a lesson, after seeing
 * the exact diff — accepting one writes nothing.
 *
 * One machine per mount: the page is keyed on the daemon, so a switch starts from nothing rather than
 * painting one machine's lessons under another's name while the new read is in flight.
 */

import type {
  LearningActionRequest,
  LearningApplyPreview,
  LearningScanScope,
  ProposalState,
  ProposalView,
  SessionView,
} from '@ferretry/protocol';
import { Lightbulb, ScanSearch, X } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PickerAccount } from '../../lib/account-picker-catalog.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { FleetProject } from '../../lib/fleet-grouping.ts';
import {
  actOnLearningProposal,
  applyLearningProposal,
  fetchApplyPreview,
  fetchLearningConfig,
  fetchLearningProposals,
  learningErrorMessage,
} from '../../lib/learning-api.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import { useDaemonFetch } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import {
  emptyTabSentence,
  LESSON_TABS,
  lessonCount,
  lessonsIn,
  SOURCE_FILTERS,
  type SourceFilter,
  scanPercent,
  scanReadingSentence,
} from './learning-model.ts';
import { LessonRow } from './lesson-row.tsx';
import { usePassiveLearning } from './passive-learning.tsx';
import { ScanDialog, ScanProgressBar } from './scan-dialog.tsx';
import { useLearningScan } from './use-learning-scan.ts';

export interface LearningPageProps {
  readonly connection: DaemonConnection;
  /** This machine's ferrets: names for evidence and source chips, and the scan's "Specific ferrets". */
  readonly sessions?: readonly SessionView[] | null;
  /** Registered projects, for the scan's "Projects". */
  readonly projects?: readonly FleetProject[];
  /** The logins a scan can run on; `null` while unread. */
  readonly accounts?: readonly PickerAccount[] | null;
  readonly onNavigate?: (to: string) => void;
  /** Test and harness seam; production reads through the carrier router. */
  readonly fetcher?: DaemonFetch;
  readonly scanPollMs?: number;
  readonly estimateDelayMs?: number;
  readonly now?: () => number;
  readonly timeZone?: string;
}

const NO_PROJECTS: readonly FleetProject[] = [];

export function LearningPage(props: LearningPageProps) {
  return <LearningHub key={props.connection.daemonId} {...props} />;
}

function LearningHub({
  connection,
  sessions = null,
  projects = NO_PROJECTS,
  accounts = null,
  onNavigate,
  fetcher,
  scanPollMs,
  estimateDelayMs,
  now,
  timeZone,
}: LearningPageProps) {
  const ambient = useDaemonFetch();
  const daemonFetch = fetcher ?? ambient;
  const [proposals, setProposals] = useState<readonly ProposalView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultAgent, setDefaultAgent] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<ProposalState>('pending');
  const [source, setSource] = useState<SourceFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanScope, setScanScope] = useState<LearningScanScope | null>(null);
  const scanControl = useLearningScan(connection, daemonFetch, scanPollMs);
  const learning = usePassiveLearning(connection, daemonFetch);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const byId = useMemo(() => new Map((sessions ?? []).map(view => [view.config.id, view])), [sessions]);

  const load = useCallback(async () => {
    try {
      const next = await fetchLearningProposals(connection, daemonFetch);
      if (!alive.current) return;
      setProposals(next);
      setError(null);
    } catch (reason) {
      if (alive.current) setError(learningErrorMessage(reason));
    }
  }, [connection, daemonFetch]);

  useEffect(() => {
    void load();
    fetchLearningConfig(connection, daemonFetch).then(
      config => {
        if (alive.current) setDefaultAgent(config.agent);
      },
      () => undefined,
    );
  }, [load, connection, daemonFetch]);

  // A scan that ends while the hub is open has added lessons: read them.
  const scan = scanControl.scan;
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = scan?.state === 'running';
    if (wasRunning.current && !running) void load();
    wasRunning.current = running;
  }, [scan, load]);

  const replace = (next: ProposalView) =>
    setProposals(current => (current ?? []).map(proposal => (proposal.id === next.id ? next : proposal)));

  const act = async (id: string, action: LearningActionRequest) => {
    const next = await actOnLearningProposal(connection, id, action, daemonFetch);
    replace(next);
    const said: Partial<Record<LearningActionRequest['action'], string>> = {
      accept: 'Accepted — apply it from the Accepted tab.',
      reject: 'Rejected.',
      reopen: 'Back in To review.',
      edit: 'Rule updated.',
    };
    const sentence = said[action.action];
    if (sentence !== undefined) setNotice(sentence);
    if (next.state !== tab) setOpenId(null);
  };

  const preview = (id: string): Promise<LearningApplyPreview> => fetchApplyPreview(connection, id, daemonFetch);

  const apply = async (id: string, shown: LearningApplyPreview) => {
    const next = await applyLearningProposal(connection, id, shown.etag, daemonFetch);
    replace(next);
    setOpenId(null);
    setNotice(`Wrote the lesson to ${next.applied?.path ?? shown.path}.`);
  };

  const list = proposals ?? [];
  const rows = lessonsIn(list, tab, source);

  return (
    <main className="h-full min-h-0 w-full overflow-y-auto scroll-thin pb-6" aria-labelledby="learning-hub-title">
      <div className="flex w-full max-w-[1080px] flex-col gap-3 py-3" data-daemon={connection.daemonId}>
        <header className="flex flex-wrap items-center gap-3">
          <h2
            id="learning-hub-title"
            className="m-0 flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap font-display text-display font-bold tracking-display"
          >
            <Lightbulb size={20} aria-hidden="true" className="shrink-0 text-accent" />
            Learning hub
          </h2>
          <Button
            variant="primary"
            className="min-h-[44px] items-center gap-1.5"
            onClick={() => setScanScope({ kind: 'not-passive' })}
          >
            <ScanSearch size={15} aria-hidden="true" />
            Scan for lessons…
          </Button>
        </header>
        <p className="m-0 text-ui text-muted">
          Ferrets that are instructed to learn file lessons with{' '}
          <span className="mono text-fg-soft">fy lesson suggest "…" --scope global|repo</span>. A scan reads older
          transcripts. Nothing reaches an instruction file until you apply it.
        </p>
        {scan?.state === 'running' && (
          <section aria-label="Running scan" className="kt-panel flex flex-col gap-2 p-3" data-learning-scan-inline="">
            <div className="flex flex-wrap items-center gap-2">
              <b className="min-w-0 flex-1 text-ui">{scanReadingSentence(scan)}</b>
              <Button size="sm" className="min-h-[44px]" onClick={() => setScanScope({ kind: 'not-passive' })}>
                Details
              </Button>
              <Button
                size="sm"
                variant="danger"
                className="min-h-[44px]"
                onClick={() =>
                  void scanControl.cancel().then(
                    () => setNotice('Scan cancelled.'),
                    (reason: unknown) => setNotice(learningErrorMessage(reason)),
                  )
                }
              >
                Cancel
              </Button>
            </div>
            <ScanProgressBar percent={scanPercent(scan)} />
          </section>
        )}
        {notice !== null && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-control border border-accent-border bg-accent-soft px-3 py-1 text-ui text-fg"
          >
            <span className="min-w-0 flex-1">{notice}</span>
            <button
              type="button"
              className="kt-btn h-11 w-11 shrink-0 p-0"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        {error !== null && (
          <p role="alert" className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui text-warn">
            {error}
          </p>
        )}
        <SourceFilterControl value={source} onChange={setSource} />
        <LessonTabs
          current={tab}
          counts={LESSON_TABS.map(entry => lessonCount(list, entry.state, source))}
          onSelect={next => {
            setTab(next);
            setOpenId(null);
          }}
        />
        <div role="tabpanel" id="learning-lessons" aria-labelledby={`learning-tab-${tab}`}>
          {proposals === null && error === null ? (
            <p role="status" className="m-0 py-4 text-ui text-muted">
              Reading lessons…
            </p>
          ) : rows.length === 0 ? (
            <p className="kt-panel m-0 p-4 text-ui text-muted">{emptyTabSentence(tab, source)}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {rows.map(proposal => (
                <LessonRow
                  key={proposal.id}
                  proposal={proposal}
                  open={openId === proposal.id}
                  onToggle={() => setOpenId(current => (current === proposal.id ? null : proposal.id))}
                  sessions={byId}
                  daemonId={connection.daemonId}
                  act={act}
                  preview={preview}
                  apply={apply}
                  {...(onNavigate === undefined ? {} : { onNavigate })}
                  {...(timeZone === undefined ? {} : { timeZone })}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      {scanScope !== null && (
        <ScanDialog
          connection={connection}
          fetcher={daemonFetch}
          control={scanControl}
          initialScope={scanScope}
          onClose={() => setScanScope(null)}
          onView={() => {
            setScanScope(null);
            setTab('pending');
            setSource('scan');
            setOpenId(null);
          }}
          sessions={sessions}
          projects={projects}
          accounts={accounts}
          passive={learning.passive}
          {...(defaultAgent === undefined ? {} : { defaultAgent })}
          {...(now === undefined ? {} : { now })}
          {...(estimateDelayMs === undefined ? {} : { estimateDelayMs })}
        />
      )}
    </main>
  );
}

function SourceFilterControl({
  value,
  onChange,
}: {
  readonly value: SourceFilter;
  readonly onChange: (next: SourceFilter) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Source" className="flex w-fit max-w-full flex-wrap gap-1">
      {SOURCE_FILTERS.map(option => (
        <label
          key={option.id}
          className={cn(
            'flex min-h-[44px] cursor-pointer items-center rounded-control border px-3 text-ui has-[:focus-visible]:outline has-[:focus-visible]:outline-2',
            value === option.id ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted',
          )}
        >
          <input
            type="radio"
            name="learning-source"
            value={option.id}
            className="sr-only"
            checked={value === option.id}
            onChange={() => onChange(option.id)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function LessonTabs({
  current,
  counts,
  onSelect,
}: {
  readonly current: ProposalState;
  readonly counts: readonly number[];
  readonly onSelect: (state: ProposalState) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = LESSON_TABS.length - 1;
    const target =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : undefined;
    const next = target === undefined ? undefined : LESSON_TABS[target];
    if (target === undefined || next === undefined) return;
    event.preventDefault();
    onSelect(next.state);
    refs.current[target]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Lesson status"
      className="flex max-w-full gap-1 overflow-x-auto border-b border-border-soft"
    >
      {LESSON_TABS.map((entry, index) => {
        const selected = entry.state === current;
        return (
          <button
            key={entry.state}
            ref={element => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`learning-tab-${entry.state}`}
            aria-selected={selected}
            aria-controls="learning-lessons"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(entry.state)}
            onKeyDown={event => onKeyDown(event, index)}
            className={cn(
              '-mb-px flex min-h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-3 text-ui',
              selected ? 'border-accent font-semibold text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {entry.label}
            <span className="mono rounded-badge bg-surface-2 px-1.5 text-meta text-muted">{counts[index]}</span>
          </button>
        );
      })}
    </div>
  );
}
