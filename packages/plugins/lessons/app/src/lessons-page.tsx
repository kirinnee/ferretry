/**
 * THE LEARNING HUB (Insights › Lessons): every lesson the fleet's ferrets filed or a scan found, and the
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
  LessonsActionRequest,
  LessonsApplyPreview,
  LessonsScanScope,
  ProposalState,
  ProposalView,
  LessonsFerret,
} from '../../contract/index.ts';
import { Lightbulb, ScanSearch, X } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@ferretry/app/ui';
import type { LessonsConnection } from './api.ts';
import {
  actOnLessonsProposal,
  applyLessonsProposal,
  fetchApplyPreview,
  fetchLessonsConfig,
  fetchLessonsProposals,
  lessonsErrorMessage,
} from './api.ts';
import { Button } from '@ferretry/app/ui';
import {
  emptyTabSentence,
  LESSON_TABS,
  lessonCount,
  lessonsIn,
  SOURCE_FILTERS,
  type SourceFilter,
  scanPercent,
  scanReadingSentence,
} from './model.ts';
import { LessonRow } from './lesson-row.tsx';
import { usePassiveLessons } from './passive.tsx';
import { ScanDialog, ScanProgressBar } from './scan-dialog.tsx';
import { useLessonsScan } from './use-scan.ts';

export interface LessonsPageProps {
  readonly connection: LessonsConnection;
  /** This machine's ferrets: names for evidence and source chips, and the scan's "Specific ferrets". */
  readonly ferrets?: readonly LessonsFerret[] | null;
  readonly onNavigate?: (to: string) => void;
  /** Test and harness seam; production reads through the carrier router. */
  readonly scanPollMs?: number;
  readonly estimateDelayMs?: number;
  readonly now?: () => number;
  readonly timeZone?: string;
}

export function LessonsPage(props: LessonsPageProps) {
  return <LessonsHub key={props.connection.key} {...props} />;
}

function LessonsHub({
  connection,
  ferrets = null,
  onNavigate,
  scanPollMs,
  estimateDelayMs,
  now,
  timeZone,
}: LessonsPageProps) {
  const [proposals, setProposals] = useState<readonly ProposalView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultAgent, setDefaultAgent] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<ProposalState>('pending');
  const [source, setSource] = useState<SourceFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanScope, setScanScope] = useState<LessonsScanScope | null>(null);
  const scanControl = useLessonsScan(connection, scanPollMs);
  const lessons = usePassiveLessons(connection);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const byId = useMemo(() => new Map((ferrets ?? []).map(view => [view.ferretId, view])), [ferrets]);

  const load = useCallback(async () => {
    try {
      const next = await fetchLessonsProposals(connection);
      if (!alive.current) return;
      setProposals(next);
      setError(null);
    } catch (reason) {
      if (alive.current) setError(lessonsErrorMessage(reason));
    }
  }, [connection]);

  useEffect(() => {
    void load();
    fetchLessonsConfig(connection).then(
      config => {
        if (alive.current) setDefaultAgent(config.agent);
      },
      () => undefined,
    );
  }, [load, connection]);

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

  const act = async (id: string, action: LessonsActionRequest) => {
    const next = await actOnLessonsProposal(connection, id, action);
    replace(next);
    const said: Partial<Record<LessonsActionRequest['action'], string>> = {
      accept: 'Accepted — apply it from the Accepted tab.',
      reject: 'Rejected.',
      reopen: 'Back in To review.',
      edit: 'Rule updated.',
    };
    const sentence = said[action.action];
    if (sentence !== undefined) setNotice(sentence);
    if (next.state !== tab) setOpenId(null);
  };

  const preview = (id: string): Promise<LessonsApplyPreview> => fetchApplyPreview(connection, id);

  const apply = async (id: string, shown: LessonsApplyPreview) => {
    const next = await applyLessonsProposal(connection, id, shown.etag);
    replace(next);
    setOpenId(null);
    setNotice(`Wrote the lesson to ${next.applied?.path ?? shown.path}.`);
  };

  const list = proposals ?? [];
  const rows = lessonsIn(list, tab, source);

  return (
    <main className="h-full min-h-0 w-full overflow-y-auto scroll-thin pb-6" aria-labelledby="lessons-hub-title">
      <div className="flex w-full max-w-[1080px] flex-col gap-3 py-3">
        <header className="flex flex-wrap items-center gap-3">
          <h2
            id="lessons-hub-title"
            className="m-0 flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap font-display text-display font-bold tracking-display"
          >
            <Lightbulb size={20} aria-hidden="true" className="shrink-0 text-accent" />
            Lessons hub
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
          <section aria-label="Running scan" className="kt-panel flex flex-col gap-2 p-3" data-lessons-scan-inline="">
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
                    (reason: unknown) => setNotice(lessonsErrorMessage(reason)),
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
          <p
            role="alert"
            className="m-0 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui text-warn"
          >
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
        <div role="tabpanel" id="lessons-lessons" aria-labelledby={`lessons-tab-${tab}`}>
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
                  ferrets={byId}
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
          control={scanControl}
          initialScope={scanScope}
          onClose={() => setScanScope(null)}
          onView={() => {
            setScanScope(null);
            setTab('pending');
            setSource('scan');
            setOpenId(null);
          }}
          ferrets={ferrets}
          passive={lessons.passive}
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
            name="lessons-source"
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
            id={`lessons-tab-${entry.state}`}
            aria-selected={selected}
            aria-controls="lessons-lessons"
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(entry.state)}
            onKeyDown={event => onKeyDown(event, index)}
            className={cn(
              '-mb-px flex min-h-[44px] shrink-0 items-center gap-1.5 border-b-heavy px-3 text-ui',
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
