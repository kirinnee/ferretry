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
   * Whether a project uses the board (`GET|PUT /v1/board/projects/:projectId/switch`, docs/board.md § The board is
   * opt-in). A daemon without this name answers 404: the app offers the 'Use the board' switch only where the
   * machine reports it, and otherwise says the machine needs an update.
   */
  boardSwitch: 'board.switch.1',
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
  /**
   * An agenda add may carry `offerClose`, and an item may come back with it: the app then offers "Done · closes
   * &F12" beside the answers. A daemon without this name refuses the add, so the app and the CLI send it only
   * where the machine reports it.
   */
  agendaOfferClose: 'agenda.offer-close.1',
  /**
   * `GET /v1/sessions/:id/messages` reads backward: `?tail=1` and `?through=<cursor>`, answered with `previousCursor`.
   * A daemon without this name ignores both and serves the FIRST page forward, so the app asks only where the
   * machine reports it and otherwise walks the conversation forward as before.
   */
  messagesTail: 'messages.tail.1',
  /**
   * Login spend budgets (docs/budgets.md): `budget` in a login's file and `timeZone` in machine.yaml, metered and
   * enforced. A daemon without this name refuses both keys as unknown, so the app offers the budget editor only
   * where the machine reports it and otherwise says the machine needs an update.
   */
  loginBudget: 'login.budget.1',
  /**
   * One search over cards and agenda items (`GET /v1/search`, `POST /v1/search/related`, docs/work-search.md). A
   * daemon without this name answers 404: the app keeps searching what it already loaded and the CLI files without
   * the related check.
   */
  workSearch: 'work.search.1',
  /**
   * Accounts and sign-ins (docs/input-requests.md, "Accounts and sign-ins"): `/v1/accounts*`, a card offer's
   * `signIn`/`primary`/`why`, a deliver's `signIn` and a `si_` `secretHint` that orders the card. The app reads an
   * offer's `primary`/`why` and sends a deliver's `signIn` whenever the offer carries one, with or without this name
   * (only a daemon that understands sign-ins sends either); a daemon that takes a deliver's `signIn` refuses one that is
   * not of the deliver's account, with nothing typed.
   * REPORTED SINCE THE APP DRAWS THE SCREEN (Settings › Accounts): a daemon without this name keeps today's saved-logins
   * surface, and that is all the name chooses.
   */
  accountsSignIns: 'accounts.signins.1',
  /**
   * 2FA keys (docs/input-requests.md, "Accounts and sign-ins"): an account's `factors` routes, saving a seed with an
   * `add-2fa-key` passkey bound to its stage, a code card titled from its keys and "Use code from Ferretry" per key
   * (a deliver's `factor`). A daemon without this name may lack these routes or refuse a deliver naming a key, so the
   * app offers neither and keeps today's one-seed surface.
   * REPORTED SINCE THE APP DRAWS THE KEYS (the code card, the "Set up automatic codes" panel and Settings › Accounts ›
   * 2FA keys).
   */
  twoFactorKeys: 'accounts.2fa-keys.1',
  /**
   * Approve on your phone (docs/input-requests.md, "Approve on your phone"): `push: true` on a request tool, an
   * `info` card with a `phoneApproval` ref, and `input_wait` on its `pa_` id. A daemon without this name refuses
   * `push: true`, and an app without the card shows the item as a plain info card with the daemon's subject.
   * REPORTED SINCE THE APP DRAWS THE CARD (the agenda's approve-on-phone card, the push, and "Not me — stop"): the daemon
   * offers `push: true` only while this name is in {@link daemonFeatureList}.
   */
  phoneApproval: 'input.phone-approval.1',
  /**
   * A ferret session's own credential is a bearer class (docs/agent-tools.md § "The ferret session
   * credential"): `Authorization: Bearer fys_…` names its session, and `x-ferretry-session-id` may only
   * agree. A client that sees this name presents that credential and NEVER falls back to the host's admin
   * token, whatever the answer — a refusal from this daemon is the answer, not a sign it is old.
   *
   * REPORTED SINCE EVERY ROUTE TAKES IT: a route declares `caller: 'person' | 'any'`, the credential is the
   * caller's own on every `any` route a ferret's `fy` and MCP tools need (send, notify, the board, its
   * agenda, signals, input requests, reads), and a `person` route refuses it with `403 owner_only` before
   * anything is read.
   */
  sessionCredential: 'session.credential.1',
  /**
   * Task plans (docs/secure-copy.md, "Task plans"): `task.plan`, a plan card with sign-in, terminal sign-in and paste
   * lines, approving a sign-in line with an `approve-task-plan` passkey bound to its staged selection, and Ferretry
   * filling a covered sign-in itself. The input request and its outcome carry a `plan` actor and a `preapproval` note,
   * which an older app's strict parse refuses, so the daemon fills under a plan only while it reports this name.
   * REPORTED SINCE THE APP SHOWS THE PLAN CARD: an app that cannot show it keeps the copy-plan card.
   */
  taskPlan: 'task-plan.1',
  /**
   * Standing sign-in rules (sign-in-rules.ts, docs/input-requests.md): the owner's passkey-signed permission, kept on
   * disk, for Ferretry to fill one page sign-in for any ferret until it expires. The input request and its outcome
   * carry a `sign-in-rule` actor and a `preapproval` note by rule, which an older app's strict parse refuses, so the
   * daemon fills under a rule only while it reports this name.
   * NAMED BUT NOT YET REPORTED ({@link NOT_YET_REPORTED}): the rule service and the app's sheet ship first.
   */
  signInRules: 'sign-in-rules.1',
} as const;

export type DaemonFeature = (typeof DAEMON_FEATURES)[keyof typeof DAEMON_FEATURES];

/**
 * Names whose app-side half may land first: the app can already gate on them, but no daemon of this build reports
 * them, because the daemon-side half is not built yet. Removing a name from here is how the daemon starts to offer it.
 */
const NOT_YET_REPORTED: ReadonlySet<DaemonFeature> = new Set<DaemonFeature>([DAEMON_FEATURES.signInRules]);

/** The names a daemon of this build reports, in a stable order. */
export const daemonFeatureList = (): readonly DaemonFeature[] =>
  Object.values(DAEMON_FEATURES)
    .filter(feature => !NOT_YET_REPORTED.has(feature))
    .sort();

/**
 * Whether a daemon's health report offers a feature. A report with no list at all — a daemon from
 * before the list existed — offers nothing, which is the answer that keeps the older behaviour.
 */
export const hasFeature = (
  health: { readonly features?: readonly string[] | undefined },
  feature: DaemonFeature,
): boolean => health.features?.includes(feature) === true;
