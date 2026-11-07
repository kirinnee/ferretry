import {
  type FerretState,
  FerretIdSchema,
  FerretNameSchema,
  type FerretSummary,
  FerretTitleSchema,
  RuntimeNameSchema,
} from '../../../contract/ids.ts';
import { FerretProjectIdSchema } from '../../../contract/records.ts';
import type { Instant } from '@ferretry/std';
import type { SessionStatus } from '../protocol/session-base.ts';
import type { SessionView } from '../protocol/session.ts';

/**
 * A moved session, in the words the command line parses: a {@link FerretSummary}.
 *
 * The move works on the session documents and answers with the view those documents give (`SessionView`); the wire
 * answers a ferret's summary. This is the whole difference, as a pure function of the view, so the replay ledger keeps
 * the view and every replay of a move answers the same summary.
 *
 * WHAT THE SUMMARY DOES NOT CARRY of what the view carried (and so what a client of the move no longer reads back):
 *   * the configuration's launch record — `incarnation`, `runtimeGeneration`, `command`, `harnessFlags`, `retry`,
 *     the launch settings digest and the reasoning effort/fast launch facts, the intervals and thresholds;
 *   * the move record itself (`move`, `moves`) and the conversion lineage (`conversion`);
 *   * the whole state document: `turn`, `pid`, `health`, `openTools`, the question/permission/dialog the pane is parked
 *     on, the agenda summary, `needsHuman`, the observed model/effort/fast, the context percentage and the usage
 *     figures, `launchInstructions`;
 *   * the derived `revive`, `outdated` and `context` answers, `journalSequence`, and the session `directory`;
 *   * the callsign/title split is restated: the view's `teammate` is the summary's `name`, the view's `name` its `title`;
 *   * `focusTask`/`focusAnchor`/`boardSkip` (the card the summary shows is a START option, which a session document does
 *     not keep) and `pack`/`hypermedia`/`agenda` (booleans in the document, a pack id in the summary).
 */

/** The state a session's status reads as (§1 word table: starting, working, idle, stopped). */
export function ferretStateOf(status: SessionStatus): FerretState {
  switch (status) {
    case 'created':
    case 'starting':
      return 'starting';
    case 'running':
    case 'thinking':
    case 'tool_running':
    case 'retrying':
      return 'working';
    case 'completed':
    case 'failed':
    case 'stopped':
    case 'kill_failed':
      return 'stopped';
    case 'awaiting_question':
    case 'awaiting_user':
    case 'waiting':
    case 'interrupted':
    case 'rate_limited':
    case 'stalled':
      return 'idle';
  }
}

/** A name in the summary's spelling: the callsign when it already is one, else the session's name made into one. */
function ferretNameOf(candidates: readonly (string | undefined)[], fallback: string): string {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const whole = FerretNameSchema.safeParse(candidate);
    if (whole.success) return whole.data;
    const squeezed = FerretNameSchema.safeParse(
      candidate
        .trim()
        .replace(/[^A-Za-z0-9 ._-]+/gu, '-')
        .replace(/^[^A-Za-z0-9]+/u, '')
        .slice(0, 64),
    );
    if (squeezed.success) return squeezed.data;
  }
  return fallback.slice(0, 64);
}

export function ferretSummaryOfSessionView(view: SessionView): FerretSummary {
  const { config, state } = view;
  const id = FerretIdSchema.parse(config.id);
  const parent = FerretIdSchema.safeParse(config.parent);
  const title = FerretTitleSchema.safeParse(config.name);
  const runtime = RuntimeNameSchema.safeParse(config.agent);
  const project = FerretProjectIdSchema.safeParse(config.projectId);
  const conversation = config.transcript?.harnessSessionId;
  return {
    id,
    name: ferretNameOf([config.teammate, config.name], id),
    ...(parent.success ? { parent: parent.data } : {}),
    role: parent.success ? 'helper' : 'lead',
    mode: config.mode,
    harness: config.harness === 'codex' ? 'codex' : 'claude-code',
    runner: 'tmux',
    ...(runtime.success ? { runtime: runtime.data } : {}),
    folder: config.cwd,
    state: ferretStateOf(state.status),
    ...(conversation === undefined || conversation === '' || conversation.length > 256
      ? {}
      : { harnessConversation: conversation }),
    createdAt: config.createdAt as Instant,
    stateAt: (state.lastActivityAt ?? state.startedAt ?? config.updatedAt) as Instant,
    ...(config.provenance === undefined ? {} : { provenance: config.provenance }),
    ...(config.transferredFrom === undefined ? {} : { transferredFrom: config.transferredFrom }),
    ...(project.success ? { projectId: project.data } : {}),
    ...(config.transcript === undefined ? {} : { transcript: config.transcript }),
    ...(config.label === undefined || config.label === '' ? {} : { label: config.label }),
    ...(config.model === undefined || config.model === '' ? {} : { model: config.model }),
    ...(title.success && title.data !== config.teammate ? { title: title.data } : {}),
    ...(view.pinnedAt === undefined ? {} : { pinnedAt: view.pinnedAt as Instant }),
    ...(state.quota === undefined ? {} : { quota: state.quota }),
  };
}
