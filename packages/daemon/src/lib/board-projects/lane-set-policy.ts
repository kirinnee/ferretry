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
 *   (`laneTargets`); an app that predates them never resets them.
 * - **confirm** is the owner's accept: the lanes and the version stay as they are.
 * - **merge the release lanes** ({@link mergeReleaseLanes}) folds a set's Released and To test lanes into one
 *   at boot: a release is what the owner tests, so the two were one step drawn twice.
 * - **add quick's To test lane** ({@link addQuickToTestLane}) at boot, to a `quick` set from before it.
 * - **stage the lanes** ({@link stageLanes}) at boot: every lane stored without a stage gets the one its
 *   compatibility fields already describe, written out.
 * - **what a change does to the gates** ({@link laneGateProblems}): removing, disarming, moving or skipping a gate,
 *   or sending cards into a closed lane, a new lane or past a gate. A ferret's change never goes live on a set
 *   that exists, so these are not refused: they are what the owner's Accept card says the proposal would do.
 */
import {
  type BoardResult,
  boardErr,
  boardOk,
  LANE_TEMPLATES,
  type Lane,
  laneEditProblems,
  type LaneSetActionRequest,
  type PendingLaneSet,
  type LaneLayoutValue,
  type LaneRenames,
  type BoardActorVia,
  type LaneSet,
  type LaneTemplateError,
  type LaneTemplateName,
  type LaneGateProblem,
  laneLayoutFromTemplate,
  laneStage,
  laneTargets,
  QUICK_TO_TEST_LANE,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';

/** Who is changing the lanes. */
export type LaneActor =
  /** `via: 'admin-token'`: the owner's authority on the host's token, recorded as the token (`confirmedVia`). */
  | { readonly kind: 'owner'; readonly via?: BoardActorVia }
  | { readonly kind: 'ferret'; readonly name: string; readonly sessionId: string };

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

/** Moved to the protocol, where the lane editor reads it too; re-exported so the board's imports keep working. */
export { type LaneGateProblem, laneGateProblems } from '@ferretry/protocol';

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
  /** Whether `actor` leads the session that proposed a waiting proposal, so it may replace that proposal. */
  leads: (proposerSession: string) => boolean = () => false,
): BoardResult<LaneSetDecision, LaneSetProblem> => {
  if (actor.kind === 'ferret' && request.action !== 'confirm' && current?.pending !== undefined) {
    const { proposerSession, version, proposedBy } = current.pending;
    const theirs = proposerSession !== undefined && proposerSession !== actor.sessionId && !leads(proposerSession);
    if (theirs) return boardErr({ code: 'proposal-waiting', version, proposedBy });
  }
  switch (request.action) {
    case 'propose': {
      const built = proposeLaneSet(projectId, current, request.template, request.renames, actorName(actor));
      if (!built.ok) return built;
      return actor.kind === 'ferret' && current !== null
        ? waitForOwner(current, built.value, {}, actor.sessionId)
        : boardOk({ next: built.value, change: 'live', relocate: {} });
    }
    case 'edit': {
      const built = editLaneSet(current, request, actor);
      if (!built.ok) return built;
      const relocate = definedMoves(request.relocate);
      return actor.kind === 'ferret' && current !== null
        ? waitForOwner(current, built.value, relocate, actor.sessionId)
        : boardOk({ next: built.value, change: 'live', relocate });
    }
    case 'confirm': {
      if (actor.kind !== 'owner') return boardErr({ code: 'owner-only' });
      if (current?.pending !== undefined && current.pending.version === request.version) {
        return acceptPendingLaneSet(current, actor.via);
      }
      const confirmed = confirmLaneSet(current, request.version, actor.via);
      return confirmed.ok ? boardOk({ next: confirmed.value, change: 'live', relocate: {} }) : confirmed;
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
): BoardResult<LaneSetDecision, LaneSetProblem> => {
  // A proposal that drops a lane says where its cards go, or the owner's Accept would strand them.
  const unplaced = laneEditProblems(current, { layout: built, relocate });
  if (unplaced.length > 0) return boardErr({ code: 'relocation-missing', laneIds: unplaced });
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
  return boardOk({ next: { ...current, pending }, change: 'pending', relocate: {} });
};

/**
 * The owner's Accept of the waiting proposal: it becomes the live set, confirmed, at its own version, and its
 * relocation is handed back to run as the owner's. A proposal made against a live set that has moved on since
 * (an owner's edit clears it; a boot migration drops it) is a version conflict.
 */
export const acceptPendingLaneSet = (
  current: LaneSet,
  via?: BoardActorVia,
): BoardResult<LaneSetDecision, LaneSetProblem> => {
  const { pending } = current;
  if (pending === undefined) return boardErr({ code: 'no-lane-set' });
  if (pending.baseVersion !== current.version) return boardErr({ code: 'version-conflict', current: current.version });
  const unplaced = laneEditProblems(current, { layout: pending, relocate: pending.relocate });
  if (unplaced.length > 0) return boardErr({ code: 'relocation-missing', laneIds: unplaced });
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
  return boardOk({ next, change: 'live', relocate: definedMoves(relocate) });
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
): BoardResult<LaneSet, LaneSetProblem> => {
  if (current?.confirmedBy === 'owner') return boardErr({ code: 'already-confirmed', version: current.version });
  const layout = laneLayoutFromTemplate(template, renames);
  if (!layout.ok) return layout;
  return boardOk({ projectId, version: nextLaneSetVersion(current), confirmedBy: null, proposedBy, ...layout.value });
};

export const editLaneSet = (
  current: LaneSet | null,
  edit: {
    readonly version: number;
    readonly layout: LaneLayoutValue;
    readonly relocate: Partial<Record<string, string>>;
  },
  actor: LaneActor,
): BoardResult<LaneSet, LaneSetProblem> => {
  if (current === null) return boardErr({ code: 'no-lane-set' });
  if (edit.version !== current.version) return boardErr({ code: 'version-conflict', current: current.version });
  const unplaced = laneEditProblems(current, edit);
  if (unplaced.length > 0) return boardErr({ code: 'relocation-missing', laneIds: unplaced });
  // A layout always has a closed and a backlog lane by now (the schema refused it otherwise), so it has targets.
  const targets = laneTargets(edit.layout, current) ?? { doneLane: current.doneLane, notGoodLane: current.notGoodLane };
  return boardOk({
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
): BoardResult<LaneSet, LaneSetProblem> => {
  if (current === null) return boardErr({ code: 'no-lane-set' });
  if (version !== current.version) return boardErr({ code: 'version-conflict', current: current.version });
  const { confirmedVia: _earlier, ...rest } = current;
  return boardOk({ ...rest, confirmedBy: 'owner', ...(via === undefined ? {} : { confirmedVia: via }) });
};

/** What a card-creating command says when a project has no lanes: the exact command to run next. */
export const noLaneSetMessage = (project: string, binary: string): string =>
  `${project} has no lanes yet. Propose them first: ${binary} board lanes propose --template ` +
  `${Object.keys(LANE_TEMPLATES).join('|')} --project ${project}`;

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

/** The merged lane's name: what the owner reads, whatever the two lanes were called. */
export const RELEASED_TO_TEST_NAME = 'Released · to test';

/** What merging a set's Released and To test lanes comes to: the set to store, and where cards move. */
export interface ReleaseLaneMerge {
  readonly next: LaneSet;
  /** The To test lane that is gone. */
  readonly from: string;
  /** The Released lane every card of both now sits in. */
  readonly into: string;
}

/**
 * Folds a set's Released lane (a `shipped` lane entered on `release.published`) and the To test lane right
 * after it (a `verify` lane entered on `release.running`) into one: the Released lane's id and place, named
 * {@link RELEASED_TO_TEST_NAME}, a `verify` lane entered on release, gated the way To test was. Variants
 * walk it where they walked either. The set's version rises and its confirmation stands: a merge is not a
 * new proposal, so the owner is asked nothing. `null` when there is nothing to merge, so it is idempotent.
 */
export const mergeReleaseLanes = (current: LaneSet): ReleaseLaneMerge | null => {
  const at = current.lanes.findIndex(
    (lane, index) =>
      lane.category === 'shipped' &&
      lane.enterOn?.includes('release.published') === true &&
      current.lanes[index + 1]?.category === 'verify' &&
      current.lanes[index + 1]?.enterOn?.includes('release.running') === true,
  );
  const released = current.lanes[at];
  const tested = current.lanes[at + 1];
  if (at === -1 || released === undefined || tested === undefined) return null;
  // Never empty: the Released lane was found by its `release.published`.
  const enterOn = [
    ...new Set(
      [...(released.enterOn ?? []), ...(tested.enterOn ?? [])].filter(trigger => trigger !== 'release.running'),
    ),
  ];
  const merged: Lane = {
    id: released.id,
    name: RELEASED_TO_TEST_NAME,
    category: 'verify',
    enterOn,
    ...(tested.ownerGate === undefined ? {} : { ownerGate: tested.ownerGate }),
    emphasis: 'action',
  };
  const lanes = current.lanes.flatMap((lane, index) => {
    if (index === at) return [merged];
    return index === at + 1 ? [] : [lane];
  });
  const variants = Object.fromEntries(
    Object.entries(current.variants).map(([workflow, ids]) => [
      workflow,
      [...new Set((ids ?? []).map(id => (id === tested.id ? released.id : id)))],
    ]),
  );
  const layout = { lanes, variants };
  const targets = laneTargets(layout, current) ?? { doneLane: current.doneLane, notGoodLane: current.notGoodLane };
  const { pending: _stale, ...live } = current;
  return {
    next: { ...live, version: nextLaneSetVersion(current), ...layout, ...targets },
    from: tested.id,
    into: released.id,
  };
};

/** The lanes, by id and category, of a `quick` set stored before it had To test. */
const OLD_QUICK_SHAPE: readonly (readonly [string, Lane['category']])[] = [
  ['todo', 'backlog'],
  ['doing', 'active'],
  ['closed', 'closed'],
];

/**
 * Gives a `quick` set from before To test its To test lane ({@link QUICK_TO_TEST_LANE}), between Doing and
 * Closed: quick work has no release step and facts never enter Closed, so a merged card had nowhere to go.
 * Every lane stays where it is and keeps its name, so no card moves; Closed becomes owner-gated (a set with
 * a `verify` lane closes only by the owner) and no longer entered on `signal.done`, which goes to To test.
 * Every variant walks To test where it walked Closed or Doing. The version rises and the confirmation
 * stands, so the owner is asked nothing. `null` for any other set, so it is idempotent.
 */
export const addQuickToTestLane = (current: LaneSet): LaneSet | null => {
  const shaped =
    current.lanes.length === OLD_QUICK_SHAPE.length &&
    current.lanes.every((lane, index) => {
      const [id, category] = OLD_QUICK_SHAPE[index] ?? [];
      return lane.id === id && lane.category === category;
    });
  if (!shaped) return null;
  const [todo, doing, closed] = current.lanes as [Lane, Lane, Lane];
  // The stage goes with the triggers it mirrored: Closed reads the stage its new fields describe.
  const { enterOn, stage: _stage, ...rest } = closed;
  const kept = enterOn?.filter(trigger => trigger !== 'signal.done') ?? [];
  const gated: Lane = { ...rest, ...(kept.length === 0 ? {} : { enterOn: kept }), ownerGate: true };
  const lanes = [todo, doing, QUICK_TO_TEST_LANE, gated];
  const variants = Object.fromEntries(
    Object.entries(current.variants).map(([workflow, ids]) => {
      const walked = ids ?? [];
      const walks = walked.includes(doing.id) || walked.includes(closed.id);
      return [
        workflow,
        lanes.map(lane => lane.id).filter(id => walked.includes(id) || (walks && id === QUICK_TO_TEST_LANE.id)),
      ];
    }),
  );
  const layout = { lanes, variants };
  const targets = laneTargets(layout, current) ?? { doneLane: current.doneLane, notGoodLane: current.notGoodLane };
  const { pending: _stale, ...live } = current;
  return { ...live, version: nextLaneSetVersion(current), ...layout, ...targets };
};

/**
 * Writes every lane's stage into a set stored before stages: each lane without one gets {@link laneStage}'s,
 * the stage its `enterOn` and `ownerGate` already describe, so nothing a reader decides changes and no card
 * moves. A lane that has a stage keeps it. The VERSION STAYS: the set means what it meant, so an edit made
 * against it still applies, and the Accept on a pending proposal's card still confirms it. The confirmation
 * stands and the owner is asked nothing. `null` when every lane has a stage already, so it is idempotent.
 */
export const stageLanes = (current: LaneSet): LaneSet | null => {
  if (current.lanes.every(lane => lane.stage !== undefined)) return null;
  const lanes = current.lanes.map(lane => (lane.stage === undefined ? { ...lane, stage: laneStage(lane) } : lane));
  return { ...current, lanes };
};
