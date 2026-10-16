/**
 * SCAN FOR LESSONS — pick which ferrets, who reads them, see what it costs, then (and only then) start.
 *
 * The estimate is fetched whenever the scope, login or model changes, after a short pause, and Start is
 * enabled only while an estimate for exactly the request on screen is shown. A scan never starts by
 * itself. Once one runs, this shows its progress; closing does not stop it, and the hub keeps showing it.
 *
 * A dialog on a wide screen and a bottom sheet on a phone, from one element: the overlay anchors the
 * panel to the bottom edge until `sm`.
 */

import type {
  LearningScanEstimate,
  LearningScanRequest,
  LearningScanScope,
  SessionView,
} from '@ferretry/protocol';
import { ScanSearch, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import type { PickerAccount } from '../../lib/account-picker-catalog.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { FleetProject } from '../../lib/fleet-grouping.ts';
import { estimateLearningScan, learningErrorMessage } from '../../lib/learning-api.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import { Button } from '../../shell/primitives.tsx';
import {
  basename,
  estimateNotes,
  estimateParts,
  initialScanDraft,
  SCAN_SCOPES,
  type ScanDraft,
  scanPercent,
  scanReadingSentence,
  scanResultSentence,
  scopeFromDraft,
  sessionName,
  toggled,
} from './learning-model.ts';
import type { LearningScanControl } from './use-learning-scan.ts';

export const ESTIMATE_DELAY_MS = 400;

export interface ScanDialogProps {
  readonly connection: DaemonConnection;
  readonly fetcher: DaemonFetch;
  readonly control: LearningScanControl;
  readonly onClose: () => void;
  /** "View in Learning": the hub's To review tab, filtered to scan results. */
  readonly onView: () => void;
  /** A ferret's own "Scan this ferret" opens with `{ kind: 'sessions', sessionIds: [id] }`. */
  readonly initialScope?: LearningScanScope;
  readonly sessions: readonly SessionView[] | null;
  readonly projects: readonly FleetProject[];
  readonly accounts: readonly PickerAccount[] | null;
  /** The machine's `learning.yaml` agent, which a blank login means. */
  readonly defaultAgent?: string;
  /** Sessions instructed to learn, to mark the others "learning off". */
  readonly passive: ReadonlySet<string>;
  readonly now?: () => number;
  readonly estimateDelayMs?: number;
}

type EstimateState =
  | { readonly key: string; readonly estimate: LearningScanEstimate }
  | { readonly key: string; readonly error: string };

const requestFor = (scope: LearningScanScope, draft: ScanDraft): LearningScanRequest => ({
  scope,
  ...(draft.agent === '' ? {} : { agent: draft.agent }),
  ...(draft.model === '' ? {} : { model: draft.model }),
});

/** Registered projects, else the folders the fleet's ferrets run in. */
const projectChoices = (
  projects: readonly FleetProject[],
  sessions: readonly SessionView[],
): readonly { readonly path: string; readonly name: string }[] =>
  projects.length > 0
    ? projects.map(project => ({ path: project.path, name: project.name }))
    : [...new Set(sessions.map(view => view.config.cwd))].map(path => ({ path, name: basename(path) }));

export function ScanDialog(props: ScanDialogProps) {
  const { control, onClose, onView } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(true, panelRef, onClose);
  // The run this dialog has shown progress for, so its end is shown here rather than a fresh form.
  const [watching, setWatching] = useState<string | null>(null);
  const scan = control.scan;
  const running = scan?.state === 'running';
  useEffect(() => {
    if (running && scan !== null) setWatching(scan.runId);
  }, [running, scan]);

  const phase = running ? 'progress' : scan !== null && watching === scan.runId ? 'finished' : 'form';
  const title = phase === 'progress' ? 'Scanning for lessons' : phase === 'finished' ? 'Scan finished' : 'Scan for lessons';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-scrim sm:items-center sm:p-4"
      role="presentation"
    >
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-learning-scan-dialog={phase}
        className="kt-panel relative flex max-h-[min(92dvh,760px)] w-full max-w-[560px] flex-col overflow-hidden rounded-b-none p-0 shadow-popover focus:outline-none sm:rounded-b-[inherit]"
      >
        <header className="flex items-center gap-2 border-b border-border-soft px-4 py-2">
          <ScanSearch size={16} aria-hidden="true" className="shrink-0 text-accent" />
          <h2 id={titleId} className="m-0 min-w-0 flex-1 text-ui font-semibold">
            {title}
          </h2>
          <button type="button" aria-label="Close" className="kt-btn h-11 w-11 shrink-0 p-0" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {phase === 'progress' && scan !== null ? (
          <ScanProgressBody
            percent={scanPercent(scan)}
            sentence={scanReadingSentence(scan)}
            onHide={onClose}
            onCancel={control.cancel}
          />
        ) : phase === 'finished' && scan !== null ? (
          <ScanFinishedBody sentence={scanResultSentence(scan)} onClose={onClose} onView={onView} />
        ) : (
          <ScanForm {...props} />
        )}
      </div>
    </div>
  );
}

/** The determinate bar the hub and the dialog both draw. */
export function ScanProgressBar({ percent }: { readonly percent: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Scan progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

function ScanProgressBody({
  percent,
  sentence,
  onHide,
  onCancel,
}: {
  readonly percent: number;
  readonly sentence: string;
  readonly onHide: () => void;
  readonly onCancel: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <div className="flex flex-col gap-2 px-4 py-4">
        <ScanProgressBar percent={percent} />
        <p className="m-0 text-ui">
          {sentence} <span className="text-faint">{percent}%</span>
        </p>
        <p className="m-0 text-meta text-muted">You can close this; the scan keeps going and the Learning page shows it.</p>
        {error !== null && (
          <p role="alert" className="m-0 text-meta text-err">
            {error}
          </p>
        )}
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-border-soft px-4 py-3">
        <Button className="min-h-[44px]" onClick={onHide}>
          Hide
        </Button>
        <Button
          variant="danger"
          className="min-h-[44px]"
          onClick={() => void onCancel().catch((reason: unknown) => setError(learningErrorMessage(reason)))}
        >
          Cancel scan
        </Button>
      </footer>
    </>
  );
}

function ScanFinishedBody({
  sentence,
  onClose,
  onView,
}: {
  readonly sentence: string;
  readonly onClose: () => void;
  readonly onView: () => void;
}) {
  return (
    <>
      <p role="status" className="m-0 px-4 py-4 text-ui">
        {sentence} Lessons from a scan carry a <b>scan</b> chip and a Global or Repo type.
      </p>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-border-soft px-4 py-3">
        <Button className="min-h-[44px]" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" className="min-h-[44px]" onClick={onView}>
          View in Learning
        </Button>
      </footer>
    </>
  );
}

function ScanForm({
  connection,
  fetcher,
  control,
  onClose,
  initialScope,
  sessions,
  projects,
  accounts,
  defaultAgent,
  passive,
  now = Date.now,
  estimateDelayMs = ESTIMATE_DELAY_MS,
}: ScanDialogProps) {
  const [draft, setDraft] = useState<ScanDraft>(() => initialScanDraft(now(), initialScope));
  const [estimate, setEstimate] = useState<EstimateState | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const formId = useId();
  const fleet = sessions ?? [];
  const byId = useMemo(() => new Map(fleet.map(view => [view.config.id, view])), [fleet]);
  const agents = (accounts ?? []).filter(account => account.agent);
  const login = agents.find(account => account.wrapper === (draft.agent === '' ? defaultAgent : draft.agent));
  const models = login?.models.filter(model => model.available) ?? [];

  const scope = scopeFromDraft(draft);
  const request = typeof scope === 'string' ? null : requestFor(scope, draft);
  const key = request === null ? '' : JSON.stringify(request);

  useEffect(() => {
    if (key === '') return;
    let current = true;
    const timer = setTimeout(() => {
      estimateLearningScan(connection, JSON.parse(key) as LearningScanRequest, fetcher).then(
        next => {
          if (current) setEstimate({ key, estimate: next });
        },
        (reason: unknown) => {
          if (current) setEstimate({ key, error: learningErrorMessage(reason) });
        },
      );
    }, estimateDelayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [connection, fetcher, key, estimateDelayMs]);

  const shown = estimate !== null && estimate.key === key ? estimate : null;
  const ready = shown !== null && 'estimate' in shown && shown.estimate.sessions > 0;

  const start = async () => {
    if (request === null) return;
    setStarting(true);
    setStartError(null);
    try {
      await control.start(request);
    } catch (reason) {
      setStartError(learningErrorMessage(reason));
    } finally {
      setStarting(false);
    }
  };

  const update = (patch: Partial<ScanDraft>) => setDraft(current => ({ ...current, ...patch }));

  return (
    <>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-4">
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-meta font-semibold text-muted">Scope</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SCAN_SCOPES.map(option => (
              <label
                key={option.kind}
                className={cn(
                  'flex min-h-[44px] cursor-pointer items-start gap-2 rounded-control border px-3 py-2',
                  draft.kind === option.kind ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent',
                )}
              >
                <input
                  type="radio"
                  name={`${formId}-scope`}
                  value={option.kind}
                  className="mt-1"
                  checked={draft.kind === option.kind}
                  onChange={() => update({ kind: option.kind })}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-ui font-semibold">{option.label}</span>
                  {option.hint === undefined ? null : <span className="text-meta text-muted">{option.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {draft.kind === 'range' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
              From
              <input
                type="date"
                className="kt-input min-h-[44px]"
                value={draft.from}
                onChange={event => update({ from: event.target.value })}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
              To
              <input
                type="date"
                className="kt-input min-h-[44px]"
                value={draft.to}
                onChange={event => update({ to: event.target.value })}
              />
            </label>
          </div>
        )}
        {draft.kind === 'projects' && (
          <CheckList
            label="Projects"
            empty="No projects on this machine yet."
            items={projectChoices(projects, fleet).map(project => ({
              id: project.path,
              label: project.name,
              detail: project.path,
            }))}
            checked={draft.projects}
            onToggle={path => update({ projects: toggled(draft.projects, path) })}
          />
        )}
        {draft.kind === 'sessions' && (
          <CheckList
            label="Ferrets"
            empty="No ferrets on this machine."
            items={[...new Set([...draft.sessionIds, ...fleet.map(view => view.config.id)])].map(id => {
              const cwd = byId.get(id)?.config.cwd;
              return {
                id,
                label: sessionName(id, byId),
                detail: [cwd === undefined ? '' : basename(cwd), passive.has(id) ? '' : 'learning off']
                  .filter(part => part !== '')
                  .join(' · '),
              };
            })}
            checked={draft.sessionIds}
            onToggle={id => update({ sessionIds: toggled(draft.sessionIds, id) })}
          />
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
            Login
            <select
              className="kt-input min-h-[44px]"
              value={draft.agent}
              onChange={event => update({ agent: event.target.value, model: '' })}
            >
              <option value="">Machine default{defaultAgent === undefined ? '' : ` (${defaultAgent})`}</option>
              {agents.map(account => (
                <option key={account.id} value={account.wrapper} disabled={!account.available}>
                  {account.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
            Model
            <select
              className="kt-input min-h-[44px]"
              value={draft.model}
              onChange={event => update({ model: event.target.value })}
            >
              <option value="">
                Login’s default{login?.defaultModel ? ` (${login.defaultModel})` : ''}
              </option>
              {models.map(model => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ScanEstimate
          problem={typeof scope === 'string' ? scope : null}
          shown={shown}
          names={(id: string) => sessionName(id, byId)}
        />
        {startError !== null && (
          <p role="alert" className="m-0 text-meta text-err">
            {startError}
          </p>
        )}
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-border-soft px-4 py-3">
        <Button className="min-h-[44px]" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="min-h-[44px] items-center gap-1.5"
          disabled={!ready || starting}
          onClick={() => void start()}
        >
          <ScanSearch size={14} aria-hidden="true" />
          {starting ? 'Starting…' : 'Start scan'}
        </Button>
      </footer>
    </>
  );
}

function CheckList({
  label,
  empty,
  items,
  checked,
  onToggle,
}: {
  readonly label: string;
  readonly empty: string;
  readonly items: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
  readonly checked: readonly string[];
  readonly onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
      <legend className="mb-1 p-0 text-meta font-semibold text-muted">{label}</legend>
      {items.length === 0 ? (
        <p className="m-0 text-meta text-muted">{empty}</p>
      ) : (
        <div className="max-h-[200px] overflow-y-auto rounded-control border border-border-soft">
          {items.map(item => (
            <label
              key={item.id}
              className="flex min-h-[44px] cursor-pointer items-center gap-2 border-b border-border-soft px-3 last:border-b-0"
            >
              <input type="checkbox" checked={checked.includes(item.id)} onChange={() => onToggle(item.id)} />
              <span className="min-w-0 truncate text-ui">{item.label}</span>
              {item.detail === '' ? null : <span className="min-w-0 truncate text-meta text-faint">{item.detail}</span>}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

const IN_SCOPE_NAMES = 6;

function ScanEstimate({
  problem,
  shown,
  names,
}: {
  readonly problem: string | null;
  readonly shown: EstimateState | null;
  readonly names: (id: string) => string;
}) {
  if (problem !== null) return <p className="m-0 text-meta text-muted">{problem}</p>;
  if (shown === null)
    return (
      <p role="status" className="m-0 text-meta text-muted">
        Estimating…
      </p>
    );
  if ('error' in shown)
    return (
      <p role="alert" className="m-0 text-meta text-err">
        Could not estimate this scan: {shown.error}
      </p>
    );
  const { estimate } = shown;
  const inScope = estimate.sessionIds.slice(0, IN_SCOPE_NAMES).map(names);
  const more = estimate.sessionIds.length - inScope.length;
  return (
    <section
      aria-label="Estimate"
      role="status"
      className="flex flex-col gap-1 rounded-control border border-border-soft bg-surface-2 px-3 py-2"
      data-learning-estimate=""
    >
      <p className="m-0 text-ui">
        {estimateParts(estimate).map((part, index) => (
          <span key={part}>
            {index === 0 ? null : ' · '}
            <b>{part}</b>
          </span>
        ))}
      </p>
      {estimate.sessions === 0 ? (
        <p className="m-0 text-meta text-muted">Nothing to read in this scope.</p>
      ) : (
        <p className="m-0 text-meta text-muted">
          In scope: {inScope.join(', ')}
          {more > 0 ? `, and ${more} more` : ''}
        </p>
      )}
      {estimateNotes(estimate).map(note => (
        <p key={note} className="m-0 text-meta text-muted">
          {note}
        </p>
      ))}
      <p className="m-0 text-meta text-faint">
        An estimate, run by {estimate.agent}
        {estimate.model === undefined ? '' : ` on ${estimate.model}`}. Nothing runs until you press Start.
      </p>
    </section>
  );
}
