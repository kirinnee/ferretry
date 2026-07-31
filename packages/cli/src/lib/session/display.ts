import type { SessionConfig, SessionState, SessionView } from '@ferretry/protocol';

/** Statuses a session never leaves; `ps` hides them unless asked for everything. */
export const TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'stalled', 'stopped'];

type UsageState = Pick<SessionState, 'usage5hPercent' | 'usageWeeklyPercent' | 'usageAtLimit' | 'usageAuthOk'>;

/**
 * The model a session is actually running, for display.
 *
 * Precedence: what the harness reported > the configured model > the wrapper's declared hint.
 * The source carried a hardcoded table of one operator's account names to map wrapper → served
 * model; that belongs to the fleet manifest, not the CLI, so `modelHint` (published by the daemon)
 * is the fallback here.
 */
export function displayModel(
  config: Pick<SessionConfig, 'model' | 'modelHint'>,
  state: Pick<SessionState, 'observedModel'>,
): string {
  return state.observedModel?.trim() || config.model?.trim() || config.modelHint.trim() || 'default';
}

/** Long-form quota label for the detail view, or undefined when the daemon reported no usage. */
export function quotaLabel(state: UsageState): string | undefined {
  if (state.usageAuthOk === false) return 'AUTH REQUIRED';
  const parts = [
    state.usage5hPercent === undefined ? '' : `5h ${state.usage5hPercent}%`,
    state.usageWeeklyPercent === undefined ? '' : `wk ${state.usageWeeklyPercent}%`,
    state.usageAtLimit === true ? 'AT LIMIT' : '',
  ].filter(part => part !== '');
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** Fixed-width quota cell for the `ps` table. */
export function compactQuota(state: UsageState): string {
  if (state.usageAuthOk === false) return 'AUTH!';
  if (state.usage5hPercent === undefined && state.usageWeeklyPercent === undefined) return '—';
  const fiveHour = state.usage5hPercent === undefined ? '—' : `${state.usage5hPercent}%`;
  const weekly = state.usageWeeklyPercent === undefined ? '—' : `${state.usageWeeklyPercent}%`;
  return `${fiveHour}/${weekly}${state.usageAtLimit === true ? '!' : ''}`;
}

/**
 * Status cell, with a declared park made visible.
 *
 * A deliberate park and an unanswered question both report `waiting`, so the marker is the only way
 * a lead reading `ps` can tell "parked on purpose" from "stuck". A peer park names the peer.
 */
export function statusLabel(state: Pick<SessionState, 'status' | 'waiting'>): string {
  if (state.waiting === undefined) return state.status;
  const peer = state.waiting.peerName ?? state.waiting.peer;
  return `${state.status} PARKED${peer === undefined ? '' : `←${peer}`}`;
}

/** Seconds since an instant, clamped at zero; `-` when the daemon never observed it. */
export function ageLabel(nowMs: number, instant?: string): string {
  if (instant === undefined) return '-';
  const observedMs = Date.parse(instant);
  if (Number.isNaN(observedMs)) return '-';
  return `${Math.max(0, Math.floor((nowMs - observedMs) / 1000))}s`;
}

function headline(view: SessionView): string {
  const { config, state } = view;
  return [
    `${config.teammate ?? '-'} (${config.id})`,
    statusLabel(state),
    config.agent,
    `model=${displayModel(config, state)}`,
    config.label === undefined ? '' : `label=${config.label}`,
    config.parent === undefined ? '' : `parent=${config.parent}`,
    config.mode,
    `turn ${state.turn}`,
  ]
    .filter(part => part !== '')
    .join('  ');
}

function vitals(view: SessionView): string[] {
  const quota = quotaLabel(view.state);
  const parts = [
    view.state.contextPercent === undefined ? '' : `context ${view.state.contextPercent}% used`,
    quota === undefined ? '' : `quota ${quota}`,
    view.state.lastToolStartedAt === undefined ? '' : `last tool started ${view.state.lastToolStartedAt}`,
  ].filter(part => part !== '');
  return parts.length === 0 ? [] : [`  ${parts.join('  ')}`];
}

function liveness(view: SessionView, nowMs: number): string {
  const ledger = [
    `transcript ${ageLabel(nowMs, view.state.lastTranscriptAt)}`,
    `counters ${ageLabel(nowMs, view.state.lastCounterAdvanceAt)}`,
    `tokens ${ageLabel(nowMs, view.state.lastTokenAdvanceAt)}`,
    `subprocess ${ageLabel(nowMs, view.state.lastSubprocessAt)}`,
    `pane ${ageLabel(nowMs, view.state.lastPaneAt)}`,
  ];
  return `  liveness: ${ledger.join('  ')}${view.state.nudgedAt === undefined ? '' : '  ⚠ nudged'}`;
}

function declaredWait(view: SessionView): string[] {
  const waiting = view.state.waiting;
  if (waiting === undefined) return [];
  const peer = waiting.peerName ?? waiting.peer;
  const subject = peer === undefined ? (waiting.condition ?? 'external condition') : `reply from ${peer}`;
  const deadline = waiting.until === undefined ? ' (open-ended)' : ` until ${waiting.until}`;
  return [
    `  ⏸ DECLARED WAIT: ${subject}${deadline} — parked on purpose; the idle kill and the turn ceiling are suspended`,
  ];
}

function questions(view: SessionView): string[] {
  const lines: string[] = [];
  for (const question of view.state.pendingQuestion?.questions ?? []) {
    lines.push(`  question: ${question.question}`);
    if (question.options !== undefined && question.options.length > 0) {
      const labels = question.options.map(option => option.label).join(', ');
      lines.push(`  options: ${labels}${question.multiSelect === true ? ' (choose one or more)' : ''}`);
    }
  }
  return lines;
}

/** The single-session detail block printed by `status`, `start`, `send`, and the lifecycle verbs. */
export function renderSessionView(view: SessionView, nowMs: number): string[] {
  return [
    headline(view),
    `  ${view.config.cwd}`,
    ...vitals(view),
    liveness(view, nowMs),
    ...declaredWait(view),
    ...(view.state.needsHuman === undefined ? [] : [`  🚨 NEEDS HUMAN: ${view.state.needsHuman}`]),
    ...(view.state.reason === undefined ? [] : [`  ${view.state.reason}`]),
    ...questions(view),
    `  ${view.directory}`,
  ];
}

const TABLE_HEADER = ['TEAMMATE', 'ID', 'STATUS', 'MODEL', 'AGENT', 'MODE', 'QUOTA', 'TASK', 'LABEL'] as const;

/**
 * The `ps` table.
 *
 * Column widths are measured from the data — fixed widths misalign the moment a value outgrows
 * them — and the variable-length columns sit last, where the final one is never padded.
 */
export function renderSessionTable(views: readonly SessionView[]): string[] {
  const rows = views.map(view => [
    view.config.teammate ?? '-',
    view.config.id,
    statusLabel(view.state),
    displayModel(view.config, view.state),
    view.config.agent,
    view.config.mode,
    compactQuota(view.state),
    view.config.name,
    view.config.label ?? '-',
  ]);
  const widths = TABLE_HEADER.map((title, column) =>
    Math.max(title.length, ...rows.map(cells => (cells[column] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join('  ');
  return [render(TABLE_HEADER), ...rows.map(render)];
}
