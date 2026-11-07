/**
 * HOW A PROJECT'S LANE SET CHANGES (`board-design.md` §2.3). Pure and total: every function returns a
 * {@link BoardResult}, and the storage and the agenda are somebody else's.
 *
 * - **propose** stores an UNCONFIRMED set that is live at once on a project with no lanes. It is refused once
 *   the owner has confirmed a set: from then on lanes change by an edit against the version the editor saw.
 * - **edit** is checked against that version. Lanes it removes must say where their cards go, and a lane
 *   that stays keeps its id however it is renamed. An edit by the owner confirms the set.
 * - **A ferret's change waits for the owner** ({@link decideLaneChange}): a ferret's propose or edit of a project
 *   that HAS lanes is stored as the set's `pending` proposal, and the live set stays in force, so no gate
 *   changes and no card moves. The owner's confirm of that proposal's version makes it live, and only then do
 *   its cards move, as the owner's. Only a project with no lanes takes a ferret's proposal live: there is
 *   nothing on it to protect yet, and no card to move.
 * - **A relocation that is not the owner's** ({@link relocationProblems}) never closes a card, never lets one
 *   out of a gate and never carries one past a gate.
 * - An edit keeps the set's Done and Not good lanes while they still fit, unless it names its own
 *   (`laneTargets`); an edit that names none never resets them.
 * - **confirm** is the owner's accept: the lanes and the version stay as they are.
 * - **what a change does to the gates** ({@link laneGateProblems}): removing, disarming, moving or skipping a gate,
 *   or sending cards into a closed lane, a new lane or past a gate. A ferret's change never goes live on a set
 *   that exists, so these are not refused: they are what the owner's Accept card says the proposal would do.
 */
import { err, ok, type Result } from '@ferretry/std';
import { UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import {
  type BoardActorVia,
  LANE_TEMPLATES,
  type Lane,
  type LaneGateProblem,
  type LaneLayoutValue,
  type LaneRenames,
  type LaneSet,
  type LaneSetActionRequest,
  type LaneTemplateError,
  type LaneTemplateName,
  type PendingLaneSet,
  laneEditProblems,
  laneLayoutFromTemplate,
  laneStage,
  laneTargets,
} from './model.ts';

/** Who is changing the lanes. */
export type LaneActor =
  /** `via: 'admin-token'`: the owner's authority on the host's token, recorded as the token (`confirmedVia`). */
  | { readonly kind: 'owner'; readonly via?: BoardActorVia }
  | { readonly kind: 'ferret'; readonly name: string; readonly ferretId: string };

export type LaneSetProblem =
  | LaneTemplateError
  | { readonly code: 'version-conflict'; readonly current: number }
  | { readonly code: 'no-lane-set' }
  | { readonly code: 'owner-only' }
  | { readonly code: 'already-confirmed'; readonly version: number }
  | { readonly code: 'relocation-missing'; readonly laneIds: readonly string[] }
  | { readonly code: 'owner-gate'; readonly problems: readonly LaneGateProblem[] }
  /** Another ferret's proposal waits for the owner: only it, a lead above it or the owner replaces it. */
  | { readonly code: 'proposal-waiting'; readonly version: number; readonly proposedBy: string };

export { type LaneGateProblem, laneGateProblems } from './model.ts';

/** What a lane change decided ({@link decideLaneChange}): the set to store, and the cards that move. */
export interface LaneSetDecision {
  readonly next: LaneSet;
  /** `live`: the board's lanes are `next`'s now. `pending`: a proposal waits for the owner; the board is unchanged. */
  readonly change: 'live' | 'pending';
  /** Removed lane → kept lane, moved after `next` is stored. Always empty for a pending proposal. */
  readonly relocate: Readonly<Record<string, string>>;
}

/**
 * The number a set's next version takes: above the live set AND any proposal waiting on it, so a number is
 * never used twice and the Accept of an older card can never name a newer proposal.
 */
export const nextLaneSetVersion = (current: Pick<LaneSet, 'version' | 'pending'> | null): number =>
  Math.max(current?.version ?? 0, current?.pending?.version ?? 0) + 1;

/**
 * Decides a propose, edit or confirm (`docs/board.md` § A ferret's lane change waits for the owner). The owner's
 * own propose and edit are live at once, as before; a ferret's on a project that has lanes waits as the set's
 * `pending` proposal; a confirm of the waiting proposal's version is the owner accepting it.
 */
export const decideLaneChange = (
  projectId: LaneSet['projectId'],
  current: LaneSet | null,
  request: LaneSetActionRequest,
  actor: LaneActor,
  /** Whether `actor` leads the ferret that proposed a waiting proposal, so it may replace that proposal. */
  leads: (proposerSession: string) => boolean = () => false,
): Result<LaneSetDecision, LaneSetProblem> => {
  if (actor.kind === 'ferret' && request.action !== 'confirm' && current?.pending !== undefined) {
    const { proposerSession, version, proposedBy } = current.pending;
    const theirs = proposerSession !== undefined && proposerSession !== actor.ferretId && !leads(proposerSession);
    if (theirs) return err({ code: 'proposal-waiting', version, proposedBy });
  }
  switch (request.action) {
    case 'propose': {
      const built = proposeLaneSet(projectId, current, request.template, request.renames, actorName(actor));
      if (!built.ok) return built;
      return actor.kind === 'ferret' && current !== null
        ? waitForOwner(current, built.value, {}, actor.ferretId)
        : ok({ next: built.value, change: 'live', relocate: {} });
    }
    case 'edit': {
      const built = editLaneSet(current, request, actor);
      if (!built.ok) return built;
      const relocate = definedMoves(request.relocate);
      return actor.kind === 'ferret' && current !== null
        ? waitForOwner(current, built.value, relocate, actor.ferretId)
        : ok({ next: built.value, change: 'live', relocate });
    }
    case 'confirm': {
      if (actor.kind !== 'owner') return err({ code: 'owner-only' });
      if (current?.pending !== undefined && current.pending.version === request.version) {
        return acceptPendingLaneSet(current, actor.via);
      }
      const confirmed = confirmLaneSet(current, request.version, actor.via);
      return confirmed.ok ? ok({ next: confirmed.value, change: 'live', relocate: {} }) : confirmed;
    }
  }
};

const definedMoves = (relocate: Partial<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(relocate).filter((entry): entry is [string, string] => entry[1] !== undefined));

/** A ferret's change, kept beside the live set for the owner: the live set itself is untouched. */
const waitForOwner = (
  current: LaneSet,
  built: LaneSet,
  relocate: Readonly<Record<string, string>>,
  proposerSession: string,
): Result<LaneSetDecision, LaneSetProblem> => {
  // A proposal that drops a lane says where its cards go, or the owner's Accept would strand them.
  const unplaced = laneEditProblems(current, { layout: built, relocate });
  if (unplaced.length > 0) return err({ code: 'relocation-missing', laneIds: unplaced });
  const pending: PendingLaneSet = {
    version: built.version,
    baseVersion: current.version,
    proposedBy: built.proposedBy,
    proposerSession,
    lanes: built.lanes,
    variants: built.variants,
    doneLane: built.doneLane,
    notGoodLane: built.notGoodLane,
    relocate,
  };
  return ok({ next: { ...current, pending }, change: 'pending', relocate: {} });
};

/**
 * The owner's Accept of the waiting proposal: it becomes the live set, confirmed, at its own version, and its
 * relocation is handed back to run as the owner's. A proposal made against a live set that has moved on since
 * (an owner's edit clears it) is a version conflict.
 */
export const acceptPendingLaneSet = (
  current: LaneSet,
  via?: BoardActorVia,
): Result<LaneSetDecision, LaneSetProblem> => {
  const { pending } = current;
  if (pending === undefined) return err({ code: 'no-lane-set' });
  if (pending.baseVersion !== current.version) return err({ code: 'version-conflict', current: current.version });
  const unplaced = laneEditProblems(current, { layout: pending, relocate: pending.relocate });
  if (unplaced.length > 0) return err({ code: 'relocation-missing', laneIds: unplaced });
  const { version, proposedBy, lanes, variants, doneLane, notGoodLane, relocate } = pending;
  const next: LaneSet = {
    projectId: current.projectId,
    version,
    confirmedBy: 'owner',
    ...(via === undefined ? {} : { confirmedVia: via }),
    proposedBy,
    lanes,
    variants,
    doneLane,
    notGoodLane,
  };
  return ok({ next, change: 'live', relocate: definedMoves(relocate) });
};

/** Why a relocation is the owner's alone: it closes the cards, lets them out of a gate, or carries them past one. */
export interface RelocationProblem {
  readonly from: string;
  readonly to: string;
  readonly why: 'closes' | 'leaves-gate' | 'passes-gate' | 'no-such-lane';
  /** The gate it leaves or passes; absent otherwise. */
  readonly gate?: string;
}

type Layout = Pick<LaneSet, 'lanes'>;

/**
 * What a relocation that is NOT the owner's may not do, as one owner-less move may not: put a card in a closed
 * lane, take it forward out of a gate (even into another gate: that skips the owner's answer), or carry it forward
 * past a gate. A
 * removed lane has no place in `after`, so it is placed before the first lane that followed it in `before` and
 * survives; a target before that place is a move back. Every lane counts, whatever a card's variant walks: a
 * relocation moves a lane's cards, not one card. Empty when every move is one the daemon may make.
 */
export const relocationProblems = (
  before: Layout,
  after: Layout,
  moves: Readonly<Record<string, string>>,
): readonly RelocationProblem[] => {
  const isGate = (lane: Lane | undefined): boolean => lane !== undefined && laneStage(lane).kind === 'gate';
  const problems: RelocationProblem[] = [];
  for (const [from, to] of Object.entries(moves)) {
    if (from === to) continue;
    const target = after.lanes.find(lane => lane.id === to);
    if (target === undefined) {
      problems.push({ from, to, why: 'no-such-lane' });
      continue;
    }
    if (target.category === 'closed') {
      problems.push({ from, to, why: 'closes' });
      continue;
    }
    const at = before.lanes.findIndex(lane => lane.id === from);
    const anchor = placeOf(before, after, at);
    const targetAt = after.lanes.indexOf(target);
    if (targetAt < anchor) continue;
    if (isGate(before.lanes[at])) {
      problems.push({ from, to, why: 'leaves-gate', gate: from });
      continue;
    }
    const passed = after.lanes.slice(anchor, targetAt).find(isGate);
    if (passed !== undefined) problems.push({ from, to, why: 'passes-gate', gate: passed.id });
  }
  return problems;
};

/** Where lane `at` of `before` would sit in `after`: the index of the first later lane of `before` that survives. */
const placeOf = (before: Layout, after: Layout, at: number): number => {
  if (at === -1) return 0;
  const ids = after.lanes.map(lane => lane.id);
  for (const lane of before.lanes.slice(at)) {
    const found = ids.indexOf(lane.id);
    if (found !== -1) return found;
  }
  return after.lanes.length;
};

/** A relocation problem in words a person or a ferret can act on. */
export const describeRelocationProblem = (problem: RelocationProblem): string => {
  switch (problem.why) {
    case 'closes':
      return `would close the cards of ${problem.from} in ${problem.to}, which only the owner does`;
    case 'leaves-gate':
      return `would take the cards of ${problem.from} out of a gate the owner has not answered, into ${problem.to}`;
    case 'passes-gate':
      return `would carry the cards of ${problem.from} past ${problem.gate ?? 'a gate'}, which waits for the owner, into ${problem.to}`;
    case 'no-such-lane':
      return `would move the cards of ${problem.from} into ${problem.to}, which the lanes do not have`;
  }
};

export const actorName = (actor: LaneActor): string => (actor.kind === 'owner' ? 'owner' : actor.name);

/** The Unfiled board's lanes until the owner edits them: the `quick` template, already confirmed. */
export const unfiledLaneSet = (): LaneSet => ({
  projectId: UNFILED_PROJECT_ID,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: 'ferretry',
  ...LANE_TEMPLATES.quick,
});

export const proposeLaneSet = (
  projectId: LaneSet['projectId'],
  current: LaneSet | null,
  template: LaneTemplateName,
  renames: LaneRenames,
  proposedBy: string,
): Result<LaneSet, LaneSetProblem> => {
  if (current?.confirmedBy === 'owner') return err({ code: 'already-confirmed', version: current.version });
  const layout = laneLayoutFromTemplate(template, renames);
  if (!layout.ok) return layout;
  return ok({ projectId, version: nextLaneSetVersion(current), confirmedBy: null, proposedBy, ...layout.value });
};

export const editLaneSet = (
  current: LaneSet | null,
  edit: {
    readonly version: number;
    readonly layout: LaneLayoutValue;
    readonly relocate: Partial<Record<string, string>>;
  },
  actor: LaneActor,
): Result<LaneSet, LaneSetProblem> => {
  if (current === null) return err({ code: 'no-lane-set' });
  if (edit.version !== current.version) return err({ code: 'version-conflict', current: current.version });
  const unplaced = laneEditProblems(current, edit);
  if (unplaced.length > 0) return err({ code: 'relocation-missing', laneIds: unplaced });
  // A layout always has a closed and a backlog lane by now (the schema refused it otherwise), so it has targets.
  const targets = laneTargets(edit.layout, current) ?? { doneLane: current.doneLane, notGoodLane: current.notGoodLane };
  return ok({
    projectId: current.projectId,
    version: nextLaneSetVersion(current),
    confirmedBy: actor.kind === 'owner' ? 'owner' : null,
    ...(actor.kind === 'owner' && actor.via !== undefined ? { confirmedVia: actor.via } : {}),
    proposedBy: actor.kind === 'owner' ? current.proposedBy : actor.name,
    // Picked, never spread: nothing a layout carries besides its lanes may stand in for the set's own fields.
    lanes: edit.layout.lanes,
    variants: edit.layout.variants,
    ...targets,
  });
};

export const confirmLaneSet = (
  current: LaneSet | null,
  version: number,
  via?: BoardActorVia,
): Result<LaneSet, LaneSetProblem> => {
  if (current === null) return err({ code: 'no-lane-set' });
  if (version !== current.version) return err({ code: 'version-conflict', current: current.version });
  const { confirmedVia: _earlier, ...rest } = current;
  return ok({ ...rest, confirmedBy: 'owner', ...(via === undefined ? {} : { confirmedVia: via }) });
};

/** A refusal in words a person or a ferret can act on. */
export const describeLaneSetFailure = (
  failure: LaneSetProblem | { readonly code: 'not-found'; readonly projectId: string },
): string => {
  switch (failure.code) {
    case 'not-found':
      return `no board for project ${failure.projectId}`;
    case 'unknown-lane':
      return `the template has no lane ${failure.laneId}, so it cannot be renamed`;
    case 'relocation-missing':
      return `lanes ${failure.laneIds.join(', ')} are removed without saying where their cards go`;
    case 'version-conflict':
      return `the lanes are at version ${String(failure.current)} now; read them again and retry`;
    case 'already-confirmed':
      return `the owner already confirmed these lanes (version ${String(failure.version)}); edit them instead of proposing`;
    case 'no-lane-set':
      return 'this project has no lanes yet; propose them first';
    case 'owner-only':
      return 'only the owner confirms lanes';
    case 'proposal-waiting':
      return `${failure.proposedBy}'s lane proposal (version ${String(failure.version)}) is waiting for the owner; only they, a lead above them or the owner may replace it`;
    case 'owner-gate':
      return `only the owner may change these gates: this change ${failure.problems.map(problem => problem.why).join('; ')}`;
  }
};
