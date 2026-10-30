/**
 * WHAT THIS DAEMON CAN DO THAT AN OLDER ONE COULD NOT — the list the app reads before it relies on it.
 *
 * (These are the daemon's _features_; the per-device "capabilities" of `grants.ts` are a different thing.)
 *
 * ## The app ships first
 *
 * The PWA deploys from `main` the moment a change merges; a daemon changes only after the release cut
 * and `fy daemon update`. So a change that RAISES A LIMIT or ADDS A REQUEST FIELD reaches the owner's
 * browser days before it reaches their machine, and a new app talking to an old daemon is the normal
 * state of the world, not an edge case. Such a change must gate the app on a feature named here:
 * the daemon reports the list on `GET /v1/health`, the app enables the feature (or the raised limit)
 * only when the name is present, and otherwise keeps the old behaviour and says the machine needs an
 * update. `docs/standards/architecture/index.md` § "The app ships before the daemon" states the rule.
 *
 * ## Why a list and not a version comparison
 *
 * A version number says when something shipped only to a reader who knows the history. A name says what
 * it is for, survives a backport, and cannot be wrong about a build cut from a branch. A name the app
 * has never heard of is simply ignored, so the field is an open set of strings on the wire.
 */

/**
 * Every feature this daemon build offers, by name. Adding a name is the daemon-side half of a
 * gated change; the app-side half reads it back with {@link hasFeature}.
 */
export const DAEMON_FEATURES = {
  /** `idea` on a Pack clean-up request takes up to 4,000 characters (an older daemon refuses past 500). */
  packIdea4000: 'pack.idea.4000',
  /**
   * The agenda's wire names (docs/agenda.md § Compatibility): `/v1/sessions/:id/agenda`,
   * `/v1/sessions/:id/agenda/replies`, `/v1/warden/agenda` and `SessionState.agenda`, beside the older
   * `attention` spellings this daemon still answers.
   */
  agendaWire: 'agenda.wire.1',
  /**
   * An agenda add (`AddAgendaRequestSchema`) may name the board card it belongs to (`task`). A daemon
   * without this name refuses the whole add, because the request is strict: send `task` only when the
   * daemon advertises it, and otherwise raise the item without one.
   */
  agendaTask: 'agenda.task.1',
  /** The board's per-project lane sets: `GET /v1/board/projects` and `GET|POST /v1/board/projects/:projectId/lanes`. */
  boardLanes: 'board.lanes.1',
  /**
   * The agenda's parked items (docs/agenda.md § Parked items): `snooze` and `unsnooze` requests, and `now` on
   * `edit` and `surface`. A daemon without this name refuses them as an unknown action: the app offers the
   * clock only where the machine reports it, and otherwise says the machine needs an update.
   */
  agendaSnooze: 'agenda.snooze.1',
  /**
   * The owner's bulk "clear all from agent ferrets" (`POST /v1/agenda/clear-agents`, docs/agenda.md § Clearing
   * the agent ferrets' backlog). A daemon without this name answers 404: the app offers the button only where the
   * machine reports it, and otherwise says the machine needs an update.
   */
  agendaClearAgents: 'agenda.clear-agents.1',
  /**
   * A board move back (`move` or `reopen`) may carry `attachments` — files the owner sent with "Not good" —
   * which the daemon delivers to the card's ferret with the reopen and names in the card's history. A daemon
   * without this name refuses the field: the app offers the composer's attach only where the machine reports it.
   */
  boardReopenAttachments: 'board.reopen.attachments.1',
} as const;

export type DaemonFeature = (typeof DAEMON_FEATURES)[keyof typeof DAEMON_FEATURES];

/** The names a daemon of this build reports, in a stable order. */
export const daemonFeatureList = (): readonly DaemonFeature[] => Object.values(DAEMON_FEATURES).sort();

/**
 * Whether a daemon's health report offers a feature. A report with no list at all — a daemon from
 * before the list existed — offers nothing, which is the answer that keeps the older behaviour.
 */
export const hasFeature = (
  health: { readonly features?: readonly string[] | undefined },
  feature: DaemonFeature,
): boolean => health.features?.includes(feature) === true;
