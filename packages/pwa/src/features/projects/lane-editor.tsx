import {
  type BoardProject,
  LANE_CATEGORIES,
  LANE_TEMPLATES,
  type LaneCategory,
  laneChangeLines,
  type LaneTemplateName,
  type LaneTrigger,
  LaneTriggerSchema,
  MAX_BOARD_LANES,
  type TaskWorkflow,
} from '@ferretry/protocol';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useBoardActions, useBoardProjects } from '../../hooks/use-board.ts';
import type { BoardActions } from '../../lib/board-actions.ts';
import { type FerretNames, ferretNamer } from '../../lib/board-present.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import {
  addLane,
  CATEGORY_LABELS,
  deleteLane,
  draftChanged,
  draftFromLaneSet,
  draftProblems,
  draftToEdit,
  type LaneDraft,
  laneWriteMessage,
  moveLane,
  renameLane,
  setLaneCategory,
  setLaneOwnerGate,
  setLaneStaleAfter,
  setLaneTriggers,
  setWorkflowLane,
  TEMPLATE_LABELS,
  TRIGGER_LABELS,
  WORKFLOWS,
  workflowLanes,
} from '../../lib/lane-editor-model.ts';
import { daemonProjectPath, daemonProjectsPath } from '../../lib/pages/routes.ts';
import { useRouter } from '../../lib/router.tsx';
import { useAppStore } from '../../lib/store.tsx';

const TEMPLATE_ORDER = Object.keys(LANE_TEMPLATES) as LaneTemplateName[];

const fieldClass =
  'h-control min-w-0 rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg focus-visible:outline-focus focus-visible:outline-offset-focus disabled:cursor-not-allowed disabled:opacity-60';

const chipClass = 'rounded-control border border-border bg-surface-2 px-xs py-0.5 text-2xs text-fg';

/** A chip the owner switches on and off: on reads as chosen, off is dimmed and struck through. */
const toggleChipClass = (on: boolean): string =>
  on
    ? 'rounded-control border border-accent-border bg-accent-soft px-xs py-0.5 text-2xs font-medium text-accent'
    : 'rounded-control border border-border bg-surface-2 px-xs py-0.5 text-2xs text-muted line-through';

type LaneEditorActions = Pick<BoardActions, 'acceptLanes' | 'saveLanes' | 'adoptTemplate'>;

/** A chip row that previews a layout's lanes in order. */
function LaneChips({ names, label }: { readonly names: readonly string[]; readonly label: string }) {
  return (
    <ol className="m-0 flex list-none flex-wrap items-center gap-xs p-0" aria-label={label}>
      {names.map((name, index) => (
        <li className={chipClass} key={`${name}-${String(index)}`}>
          {name}
        </li>
      ))}
    </ol>
  );
}

/** The six templates, previewed as chips, for a project that has no lanes yet. */
function TemplatePicker({
  busy,
  onPick,
}: {
  readonly busy: boolean;
  readonly onPick: (template: LaneTemplateName) => void;
}) {
  return (
    <section className="grid gap-sm" aria-label="Lane templates" data-lane-templates="">
      <p className="m-0 text-ui text-muted">
        This project has no lanes yet. Pick a template to start from; you can change every lane afterwards.
      </p>
      <ul className="m-0 grid list-none gap-xs p-0 md:grid-cols-2">
        {TEMPLATE_ORDER.map(template => (
          <li
            className="grid gap-xs rounded-control border border-border-strong bg-surface-2 p-control-x"
            key={template}
            data-lane-template={template}
          >
            <div className="flex items-center justify-between gap-sm">
              <span className="text-ui font-medium text-fg">{TEMPLATE_LABELS[template]}</span>
              <button className="kt-btn kt-btn--sm" type="button" disabled={busy} onClick={() => onPick(template)}>
                Use {TEMPLATE_LABELS[template]}
              </button>
            </div>
            <LaneChips
              label={`${TEMPLATE_LABELS[template]} lanes`}
              names={LANE_TEMPLATES[template].lanes.map(lane => lane.name)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function LaneRow({
  draft,
  index,
  problems,
  busy,
  onChange,
  onRequestDelete,
}: {
  readonly draft: LaneDraft;
  readonly index: number;
  readonly problems: readonly string[];
  readonly busy: boolean;
  readonly onChange: (next: LaneDraft) => void;
  readonly onRequestDelete: (id: string) => void;
}) {
  const lane = draft.lanes[index];
  const base = useId();
  if (lane === undefined) return null;
  const triggers = lane.enterOn ?? [];
  const toggleTrigger = (trigger: LaneTrigger) =>
    onChange(
      setLaneTriggers(
        draft,
        lane.id,
        triggers.includes(trigger) ? triggers.filter(entry => entry !== trigger) : [...triggers, trigger],
      ),
    );
  return (
    <li
      className="grid gap-xs rounded-control border border-border-strong bg-surface-2 p-control-x"
      data-lane-row={lane.id}
    >
      <div className="flex flex-wrap items-center gap-xs">
        <input
          className={`${fieldClass} w-40 grow`}
          aria-label={`Name of lane ${lane.id}`}
          aria-invalid={problems.length > 0}
          value={lane.name}
          disabled={busy}
          onChange={event => onChange(renameLane(draft, lane.id, event.currentTarget.value))}
        />
        <select
          className={fieldClass}
          aria-label={`Category of ${lane.name}`}
          value={lane.category}
          disabled={busy}
          onChange={event => onChange(setLaneCategory(draft, lane.id, event.currentTarget.value as LaneCategory))}
        >
          {LANE_CATEGORIES.map(category => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
        <label
          className="flex items-center gap-xs text-meta text-muted"
          htmlFor={`${base}-gate`}
          title={
            lane.category === 'closed'
              ? 'The owner must move cards into this lane.'
              : 'The owner must move cards out of this lane.'
          }
        >
          <input
            id={`${base}-gate`}
            type="checkbox"
            checked={lane.ownerGate === true}
            disabled={busy}
            onChange={event => onChange(setLaneOwnerGate(draft, lane.id, event.currentTarget.checked))}
          />
          Only you move it on
        </label>
        <label className="ml-sm flex items-center gap-xs text-meta text-muted">
          Stale after
          <input
            className={`${fieldClass} w-20`}
            aria-label={`Stale after for ${lane.name}`}
            placeholder="never"
            aria-invalid={problems.some(message => message.includes('duration'))}
            value={lane.staleAfter ?? ''}
            disabled={busy}
            onChange={event => onChange(setLaneStaleAfter(draft, lane.id, event.currentTarget.value))}
          />
        </label>
        <span className="ml-auto flex items-center gap-xs">
          <button
            className="kt-btn kt-btn--sm"
            type="button"
            aria-label={`Move ${lane.name} up`}
            disabled={busy || index === 0}
            onClick={() => onChange(moveLane(draft, lane.id, -1))}
          >
            <ArrowUp size={12} aria-hidden="true" />
          </button>
          <button
            className="kt-btn kt-btn--sm"
            type="button"
            aria-label={`Move ${lane.name} down`}
            disabled={busy || index === draft.lanes.length - 1}
            onClick={() => onChange(moveLane(draft, lane.id, 1))}
          >
            <ArrowDown size={12} aria-hidden="true" />
          </button>
          <button
            className="kt-btn kt-btn--sm hover:border-err-border hover:text-err focus-visible:text-err"
            type="button"
            aria-label={`Delete ${lane.name}`}
            disabled={busy || draft.lanes.length === 1}
            onClick={() => onRequestDelete(lane.id)}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </span>
      </div>
      <details data-lane-triggers={lane.id}>
        <summary className="cursor-pointer text-meta text-muted">
          Moves a card in when:{' '}
          {triggers.length === 0
            ? 'nothing (you move it by hand)'
            : triggers.map(trigger => TRIGGER_LABELS[trigger]).join(', ')}
        </summary>
        <div className="mt-xs flex flex-wrap gap-xs">
          {LaneTriggerSchema.options.map(trigger => (
            <button
              className={toggleChipClass(triggers.includes(trigger))}
              key={trigger}
              type="button"
              aria-pressed={triggers.includes(trigger)}
              data-on={triggers.includes(trigger)}
              disabled={busy}
              onClick={() => toggleTrigger(trigger)}
            >
              {TRIGGER_LABELS[trigger]}
            </button>
          ))}
        </div>
      </details>
    </li>
  );
}

function DeletePrompt({
  draft,
  laneId,
  onDelete,
  onCancel,
}: {
  readonly draft: LaneDraft;
  readonly laneId: string;
  readonly onDelete: (target: string) => void;
  readonly onCancel: () => void;
}) {
  const [target, setTarget] = useState('');
  const lane = draft.lanes.find(entry => entry.id === laneId);
  const others = draft.lanes.filter(entry => entry.id !== laneId);
  return (
    <section
      className="flex flex-wrap items-center gap-xs rounded-control border border-warn bg-surface-2 p-control-x"
      aria-label={`Delete ${lane?.name ?? laneId}`}
      data-lane-delete={laneId}
    >
      <span className="text-ui text-fg">Delete “{lane?.name ?? laneId}”. Its cards go to</span>
      <select
        className={fieldClass}
        aria-label="Where its cards go"
        value={target}
        onChange={event => setTarget(event.currentTarget.value)}
      >
        <option value="">Choose a lane…</option>
        {others.map(entry => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
      <button
        className="kt-btn kt-btn--sm"
        data-variant="danger"
        type="button"
        disabled={target === ''}
        onClick={() => onDelete(target)}
      >
        Delete lane
      </button>
      <button className="kt-btn kt-btn--sm" type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

function WorkflowVariants({
  draft,
  busy,
  onChange,
}: {
  readonly draft: LaneDraft;
  readonly busy: boolean;
  readonly onChange: (next: LaneDraft) => void;
}) {
  return (
    <section className="grid gap-xs" aria-label="Workflow variants" data-lane-variants="">
      <h2 className="m-0 text-title font-semibold text-fg">Workflows</h2>
      <p className="m-0 text-meta text-muted">The lanes each kind of work walks. A card skips the lanes left out.</p>
      {WORKFLOWS.map((workflow: TaskWorkflow) => {
        const walked = workflowLanes(draft, workflow);
        return (
          <div className="flex flex-wrap items-center gap-xs" key={workflow} data-lane-workflow={workflow}>
            <span className="mono w-28 text-meta text-muted">{workflow}</span>
            {draft.lanes.map(lane => (
              <button
                className={toggleChipClass(walked.includes(lane.id))}
                key={lane.id}
                type="button"
                aria-pressed={walked.includes(lane.id)}
                aria-label={`${workflow} walks ${lane.name}`}
                data-on={walked.includes(lane.id)}
                disabled={busy}
                onClick={() => onChange(setWorkflowLane(draft, workflow, lane.id, !walked.includes(lane.id)))}
              >
                {lane.name}
              </button>
            ))}
          </div>
        );
      })}
    </section>
  );
}

/** The editor for a project that has lanes. Keyed by the lane set's version, so a saved set starts a fresh draft. */
function LaneSetEditor({
  project,
  laneSet,
  daemonId,
  actions,
  names,
  onReload,
}: {
  readonly project: BoardProject;
  readonly laneSet: NonNullable<BoardProject['laneSet']>;
  readonly daemonId: DaemonId;
  readonly actions: LaneEditorActions;
  readonly names: FerretNames;
  readonly onReload: () => void;
}) {
  const [draft, setDraft] = useState<LaneDraft>(() => draftFromLaneSet(laneSet));
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly message: string; readonly code: string | null } | null>(null);
  const problems = useMemo(() => draftProblems(laneSet, draft), [laneSet, draft]);
  const changed = draftChanged(laneSet, draft);
  const proposed = laneSet.confirmedBy === null;
  // A ferret's change to these lanes, waiting for the owner: not the board's lanes until it is accepted.
  const { pending } = laneSet;
  // What accepting it would do that is the owner's to decide: the agenda card's words, from the same function.
  const warnings = pending === undefined ? [] : laneChangeLines(laneSet, pending, pending.relocate);
  // An Accept that would change a gate or move cards takes a second, deliberate tap.
  const [confirming, setConfirming] = useState(false);

  const change = (next: LaneDraft) => {
    setFailure(null);
    setDraft(next);
  };
  const run = async (write: () => ReturnType<LaneEditorActions['saveLanes']>) => {
    setBusy(true);
    setFailure(null);
    const result = await write();
    setBusy(false);
    if (!result.ok) setFailure({ message: laneWriteMessage(result.error), code: result.error.code });
  };

  return (
    <div className="grid gap-sm" data-lane-editor={project.id}>
      {proposed && (
        <section
          className="flex flex-wrap items-center justify-between gap-sm rounded-control border border-border-strong bg-surface-2 p-control-x"
          role="status"
          data-lane-banner="unconfirmed"
        >
          <span className="text-ui text-fg">Proposed by {names(laneSet.proposedBy)} · not confirmed yet</span>
          <button
            className="kt-btn kt-btn--sm"
            data-variant="primary"
            type="button"
            disabled={busy || changed}
            title={changed ? 'Save or discard your edits first' : undefined}
            onClick={() => void run(() => actions.acceptLanes(daemonId, project.id, laneSet.version))}
          >
            Accept
          </button>
        </section>
      )}

      {pending !== undefined && (
        <section
          className="flex flex-wrap items-center justify-between gap-sm rounded-control border border-border-strong bg-surface-2 p-control-x"
          role="status"
          data-lane-banner="pending"
        >
          <span className="grid gap-xs">
            <span className="text-ui text-fg">Proposed by {names(pending.proposedBy)}, waiting for you</span>
            <span className="text-meta text-muted">
              {pending.lanes.map(lane => lane.name).join(' → ')} · the board keeps the lanes below until you accept
            </span>
            {warnings.length > 0 && (
              <ul className="m-0 grid list-disc gap-xs pl-panel text-meta text-warn" data-lane-warnings="">
                {warnings.map(warning => (
                  <li key={warning}>Accepting it {warning}</li>
                ))}
              </ul>
            )}
            {confirming && (
              <span className="text-meta text-fg" role="alert" data-lane-confirm="">
                Accepting does every change above now, as you: cards move and may close.
              </span>
            )}
          </span>
          <span className="flex flex-wrap gap-xs">
            {confirming && (
              <button className="kt-btn kt-btn--sm" type="button" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            )}
            <button
              className="kt-btn kt-btn--sm"
              data-variant="primary"
              type="button"
              disabled={busy || changed}
              title={changed ? 'Save or discard your edits first' : undefined}
              onClick={() =>
                warnings.length > 0 && !confirming
                  ? setConfirming(true)
                  : void run(() => actions.acceptLanes(daemonId, project.id, pending.version))
              }
            >
              {confirming ? 'Accept these changes' : 'Accept'}
            </button>
          </span>
        </section>
      )}

      <ol className="m-0 grid list-none gap-xs p-0" aria-label="Lanes">
        {draft.lanes.map((lane, index) => (
          <LaneRow
            key={lane.id}
            draft={draft}
            index={index}
            busy={busy}
            problems={problems.filter(problem => problem.laneId === lane.id).map(problem => problem.message)}
            onChange={change}
            onRequestDelete={setDeleting}
          />
        ))}
      </ol>
      {deleting !== null && (
        <DeletePrompt
          draft={draft}
          laneId={deleting}
          onCancel={() => setDeleting(null)}
          onDelete={target => {
            const removed = deleteLane(draft, deleting, target);
            if (removed.ok) change(removed.value);
            setDeleting(null);
          }}
        />
      )}
      <div>
        <button
          className="kt-btn kt-btn--sm"
          type="button"
          disabled={busy || draft.lanes.length >= MAX_BOARD_LANES}
          onClick={() => change(addLane(draft))}
        >
          <Plus size={12} aria-hidden="true" /> Add lane
        </button>
      </div>

      <WorkflowVariants draft={draft} busy={busy} onChange={change} />

      {problems.length > 0 && (
        <ul className="m-0 grid list-none gap-0.5 p-0 text-meta text-err" aria-label="Problems" data-lane-problems="">
          {problems.map(problem => (
            <li key={`${problem.laneId ?? 'set'}-${problem.message}`}>{problem.message}</li>
          ))}
        </ul>
      )}
      {failure !== null && (
        <p className="m-0 flex flex-wrap items-center gap-xs text-meta text-err" role="alert" data-lane-failure="">
          {failure.message}
          {failure.code === 'version-conflict' && (
            <button className="kt-btn kt-btn--sm" type="button" onClick={onReload}>
              Reload
            </button>
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-xs">
        <button
          className="kt-btn"
          data-variant="primary"
          type="button"
          disabled={busy || !changed || problems.length > 0}
          onClick={() => void run(() => actions.saveLanes(daemonId, project.id, draftToEdit(laneSet, draft)))}
        >
          Save lanes
        </button>
        <button
          className="kt-btn"
          type="button"
          disabled={busy || !changed}
          onClick={() => {
            setDeleting(null);
            change(draftFromLaneSet(laneSet));
          }}
        >
          Discard changes
        </button>
        <span className="text-meta text-muted">
          Version {laneSet.version} · {proposed ? 'proposed' : 'confirmed'}
        </span>
      </div>
    </div>
  );
}

/**
 * One board project's lanes: the template picker when it has none, otherwise the editor with the unconfirmed
 * banner. Takes the project and the verbs rather than reading them, so a suite drives it with plain data.
 */
export function LaneEditor({
  project,
  daemonId,
  actions,
  names,
  onReload,
}: {
  readonly project: BoardProject;
  readonly daemonId: DaemonId;
  readonly actions: LaneEditorActions;
  /** Names a ferret by its callsign; the banner says who proposed the set. */
  readonly names: FerretNames;
  readonly onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (project.laneSet === null) {
    return (
      <div className="grid gap-sm" data-lane-editor={project.id}>
        <TemplatePicker
          busy={busy}
          onPick={template => {
            setBusy(true);
            setFailure(null);
            void actions.adoptTemplate(daemonId, project.id, template).then(result => {
              setBusy(false);
              if (!result.ok) setFailure(laneWriteMessage(result.error));
            });
          }}
        />
        {failure !== null && (
          <p className="m-0 text-meta text-err" role="alert" data-lane-failure="">
            {failure}
          </p>
        )}
      </div>
    );
  }
  return (
    <LaneSetEditor
      key={`${project.id}:${String(project.laneSet.version)}:${String(project.laneSet.confirmedBy)}:${String(project.laneSet.pending?.version ?? 0)}`}
      project={project}
      laneSet={project.laneSet}
      daemonId={daemonId}
      actions={actions}
      names={names}
      onReload={onReload}
    />
  );
}

/** Route-bound lane editor: reads the machine's board projects and finds this one. */
export function LaneEditorPage({
  connection,
  projectId,
  callsigns,
}: {
  readonly connection: DaemonConnection;
  readonly projectId: string;
  /** Ferret callsigns by session id; a ferret not listed is named by the start of its id. */
  readonly callsigns: ReadonlyMap<string, string>;
}) {
  const store = useAppStore();
  const { back } = useRouter();
  const machines = useMemo(() => [connection], [connection]);
  const states = useBoardProjects(store.board, machines);
  const actions = useBoardActions(store.board, store.attention, machines);
  const names = useMemo(() => ferretNamer(callsigns), [callsigns]);
  const state = states.get(connection.daemonId);
  // A card's Accept answered elsewhere (the agenda) changes the set behind this page; reading again on mount
  // is what shows it.
  useEffect(() => {
    void store.board.refreshProjects(connection);
  }, [store.board, connection]);
  const project = state?.projects?.find(entry => entry.id === projectId);
  const home =
    projectId === 'unfiled'
      ? daemonProjectsPath(connection.daemonId)
      : daemonProjectPath(connection.daemonId, projectId);

  return (
    <main className="grid h-full min-h-0 content-start gap-panel overflow-y-auto p-panel" data-lane-page={projectId}>
      <div className="grid gap-xs border-b border-border-strong pb-panel">
        <button className="w-fit text-meta text-muted hover:text-fg" type="button" onClick={() => back(home)}>
          <ArrowLeft size={14} aria-hidden="true" /> Back
        </button>
        <h1 className="m-0 font-display text-display font-bold tracking-display">
          Lanes{project === undefined ? '' : ` · ${project.name}`}
        </h1>
      </div>
      {state === undefined || state.projects === null ? (
        state?.status === 'error' ? (
          <p className="m-0 text-ui text-err" role="alert">
            Could not read this machine’s lanes: {state.error ?? 'the read failed'}
          </p>
        ) : state?.served === false ? (
          <p className="m-0 text-ui text-muted" role="status">
            This machine does not serve board lanes yet.
          </p>
        ) : (
          <p className="m-0 text-ui text-muted" aria-busy="true">
            Loading lanes…
          </p>
        )
      ) : project === undefined ? (
        <p className="m-0 text-ui text-muted" role="status" data-lane-page-missing="">
          This machine has no board project with that id.
        </p>
      ) : (
        <LaneEditor
          project={project}
          daemonId={connection.daemonId}
          actions={actions}
          names={names}
          onReload={() => void store.board.refreshProjects(connection)}
        />
      )}
    </main>
  );
}
