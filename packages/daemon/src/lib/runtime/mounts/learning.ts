import {
  LearningActionRequestSchema,
  type LearningActionRequest,
  type LearningConfig,
  LearningRunRequestSchema,
  type LearningPatchResponse,
  type LearningStatus,
  type ProposalState,
  type ProposalView,
  RunManifestSchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiRequest, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  recomputeProposal,
  strengthOf,
  titleHash,
  type LearningStorePort,
  type Observation,
  type Proposal,
  type Tombstone,
} from '../../learning/index.ts';

/**
 * The learning subsystem's REVIEW surface: what evidence the daemon holds, which rules that evidence
 * proposes, and a human's verdict on each one.
 *
 * This is the route table `fy learning` already speaks — `/v1/learning/status`, `/v1/learning/config`,
 * `/v1/learning/proposals`, `/v1/learning/proposals/:id` and `/v1/learning/proposals/:id/patch` — so
 * mounting it turns the shipped command group from 404s into a working capability. `FileLearningStore`
 * and the policy behind it were built and fully tested by PR #13 and nothing constructed them.
 *
 * MINING IS MOUNTED THROUGH THE SUBSYSTEM. It reads only terminal sessions from this daemon's opened
 * state home, requires each session's exact transcript provenance, combines that transcript with the
 * durable send inbox, and starts a bounded, self-excluding miner. Its output is aggregated only after
 * every quote is verified against the saved human corpus. Missing or unresolved provenance is reported
 * in the run manifest and is never treated as an empty conversation.
 *
 * THE OPERATOR'S GUIDANCE FILE. Accepting a proposal does NOT edit it. The daemon writes only inside
 * its own state home: an accepted rule is rendered as a patch DOCUMENT and recorded under
 * `learning/patches/`, and `GET .../patch` hands the same document back for the human to apply
 * themselves. Editing a file outside the state home from a guess at the operator's layout is exactly
 * the mistake this boundary exists to prevent.
 *
 * WHY A REVIEW SURFACE OVER A STORE NOTHING FILLS IS STILL A CAPABILITY. The evidence files are the
 * durable contract, and the daemon is not their only writer — the same shape the warden report reader
 * already serves. Accept, reject and edit are state changes the daemon fully owns: they move a
 * proposal's lifecycle, append its history and write the tombstone that stops a rejected rule from
 * ever being proposed again. Those work today, on real durable state, whoever produced the evidence.
 */

/**
 * The learning subsystem as the routes need it.
 *
 * The store is the DOMAIN port, not the adapter: `FileLearningStore` satisfies it structurally, so
 * the composition root hands one over with no wrapper and `src/lib` never sees a filesystem.
 */
export interface LearningSubsystem {
  readonly store: LearningStorePort;
  /**
   * Runs one read-decide-rewrite of the proposal board as a single critical section.
   *
   * The board is one JSON snapshot rewritten whole, so two concurrent verdicts that both read before
   * either wrote would silently lose one. The composition root supplies the serialization because the
   * lock belongs with the file, not with the route.
   */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /** The mining schedule and the agent that will perform it. See the header for why `enabled` is a
   *  fact about the build rather than a setting. */
  config(): LearningConfig;
  /** The instant a verdict is stamped with. */
  now(): string;
  /** Runs an ingest pass and, when requested, starts a bounded miner batch. */
  run(spawn: boolean): Promise<import('@ferretry/protocol').RunManifest>;
}

/** An instant the response schema will accept, or `undefined`. The state document is decoded from
 *  JSON without validation, so a torn or hand-edited file must not become an invalid response. */
function instantOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** The lifecycle state a list may be narrowed to. An unknown one is refused rather than ignored:
 *  answering a narrowed request with the whole board looks like a board that matched everything. */
const PROPOSAL_STATES: readonly ProposalState[] = ['pending', 'accepted', 'rejected'];

function requestedState(request: ApiRequest): ProposalState | undefined {
  for (const [name] of request.query) {
    if (name !== 'state') throw new ApiError(400, `unknown proposals parameter ${name}`, 'unknown_parameter');
  }
  const raw = request.query.get('state')?.[0];
  if (raw === undefined) return undefined;
  const known = PROPOSAL_STATES.find(state => state === raw);
  if (known === undefined) throw new ApiError(400, `unknown proposal state ${raw}`, 'invalid_state');
  return known;
}

/** A decoded path parameter. `decodeParameter` refuses a traversal or a separator, so a crafted id
 *  can never address anything outside the board. */
function pathProposalId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('id') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the proposal id in the path is not usable', 'invalid_proposal_id');
  return decoded;
}

/**
 * One proposal with the evidence a human reads before judging it.
 *
 * Counters are RECOMPUTED from the observations that still exist rather than trusted from the file:
 * a proposal claiming five occurrences whose evidence has since been pruned would put a number on the
 * board that nothing supports.
 *
 * `undefined` when not one quote survives. The view's own contract demands at least one, and a rule
 * with no evidence left is not something a human can judge — so it is omitted rather than rendered
 * with an empty quote list.
 */
function proposalView(proposal: Proposal, observations: ReadonlyMap<string, Observation>): ProposalView | undefined {
  const recomputed = recomputeProposal(proposal, observations);
  const evidence = recomputed.observationIds
    .map(id => observations.get(id))
    .filter((observation): observation is Observation => observation !== undefined)
    .map(observation => ({
      observationId: observation.id,
      sessionId: observation.sessionId,
      ...(observation.teammate === undefined ? {} : { teammate: observation.teammate }),
      repo: observation.repo,
      at: observation.at,
      quote: observation.quote,
      source: observation.source,
      kind: observation.kind,
    }));
  return evidence.length === 0 ? undefined : { ...recomputed, evidence };
}

/** Whether mining is enabled, what is waiting for a verdict, and how the last run went. */
async function status(subsystem: LearningSubsystem): Promise<ApiResponse> {
  const config = subsystem.config();
  const [state, observations, proposals, tombstones, manifest] = await Promise.all([
    subsystem.store.loadState(),
    subsystem.store.readObservations(),
    subsystem.store.loadProposals(),
    subsystem.store.loadTombstones(),
    subsystem.store.latestRunManifest(),
  ]);
  // RECOMPUTED against the surviving evidence, exactly as the board read is. Splitting on the stored
  // counter instead would let the summary call a proposal strong while the board it summarises shows
  // two quotes — one number, measured once, in both places.
  const index = new Map(observations.map(entry => [entry.id, entry]));
  const pending = proposals.filter(entry => entry.state === 'pending').map(entry => recomputeProposal(entry, index));
  // The pool's own strength rule, so the split a human sees is the one the policy makes. The schema
  // demands two buckets that sum to the total, so anything not `strong` is reported as weak.
  const strong = pending.filter(entry => strengthOf(entry.occurrences) === 'strong').length;
  // A manifest the schema rejects is a damaged file, not a run to report.
  const lastRun = manifest === undefined ? undefined : RunManifestSchema.safeParse(manifest).data;
  const response: LearningStatus = {
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    ...(instantOrUndefined(state.watermarkAt) === undefined ? {} : { watermarkAt: state.watermarkAt }),
    ...(instantOrUndefined(state.lastRunAt) === undefined ? {} : { lastRunAt: state.lastRunAt }),
    pending: { total: pending.length, strong, weak: pending.length - strong },
    totals: { observations: observations.length, proposals: proposals.length, tombstones: tombstones.length },
    // A spawned miner outlives this request. `runningRunId` is retained as the durable extension
    // point for a scheduler; the manual runner returns a pending manifest until ingestion completes.
    running: state.runningRunId !== undefined,
    ...(lastRun === undefined ? {} : { lastRun }),
  };
  return jsonResponse(response);
}

/** The proposal board, optionally narrowed to one lifecycle state. */
async function listProposals(subsystem: LearningSubsystem, context: RouteContext): Promise<ApiResponse> {
  const state = requestedState(context.request);
  const [proposals, observations] = await Promise.all([
    subsystem.store.loadProposals(),
    subsystem.store.observationsById(),
  ]);
  const views = proposals
    .filter(proposal => state === undefined || proposal.state === state)
    .map(proposal => proposalView(proposal, observations))
    .filter((view): view is ProposalView => view !== undefined);
  return jsonResponse(views);
}

/** The proposal the id names, or a 404 that says so. */
function locate(proposals: readonly Proposal[], id: string): Proposal {
  const found = proposals.find(proposal => proposal.id === id || proposal.identity === id);
  if (found === undefined) throw new ApiError(404, `no proposal ${id}`, 'not-found');
  return found;
}

/**
 * The document a human applies to their own guidance file.
 *
 * `path` is the target the proposal names; `contents` is the RULE rendered as a document, never the
 * operator's file rewritten. The daemon has not read that file and must not: it lives outside the
 * state home, and reconstructing someone's guidance from a guess at its layout would corrupt it.
 */
function renderPatch(proposal: Proposal): LearningPatchResponse {
  const anchor = proposal.target.anchor;
  const lines = [
    `<!-- ferretry learning proposal ${proposal.id} -->`,
    `# ${proposal.title}`,
    '',
    ...(anchor === undefined ? [] : [`Apply under: ${anchor}`, '']),
    proposal.ruleText.trim(),
    '',
    `Evidence: ${proposal.occurrences} session(s) across ${proposal.crossRepoCount} repo(s), ${proposal.firstSeen} to ${proposal.lastSeen}.`,
    '',
  ];
  return { path: proposal.target.path, contents: lines.join('\n') };
}

/** The rendered patch for one proposal. A GET, so it renders and writes nothing. */
async function patch(subsystem: LearningSubsystem, context: RouteContext): Promise<ApiResponse> {
  const proposal = locate(await subsystem.store.loadProposals(), pathProposalId(context));
  return jsonResponse(renderPatch(proposal));
}

/**
 * A rejected rule's headstone.
 *
 * Both the stable identity and a hash of the title are recorded, because the next run may propose the
 * same rule under a reworded title — matching on identity alone would let it back in.
 */
function tombstoneFor(proposal: Proposal, at: string, note: string | undefined): Tombstone {
  return {
    identity: proposal.identity,
    titleHash: titleHash(proposal.title),
    ruleGist: proposal.ruleText.trim().slice(0, 200),
    rejectedAt: at,
    ...(note === undefined ? {} : { note }),
  };
}

/** The proposal as the verdict leaves it, plus the tombstone a rejection adds. */
function decide(
  proposal: Proposal,
  request: LearningActionRequest,
  at: string,
): { readonly next: Proposal; readonly tombstone?: Tombstone } {
  // A verdict is final. Re-judging a rejected rule would resurrect one the human already killed, and
  // the state it is in is the board's answer rather than the caller's mistake — so 409, not 400.
  if (proposal.state === 'rejected')
    throw new ApiError(409, `proposal ${proposal.id} was already rejected`, 'already-rejected');
  const history = (event: string, note?: string) => [
    ...proposal.history,
    { at, event, by: 'user' as const, ...(note === undefined ? {} : { note }) },
  ];
  if (request.action === 'accept') return { next: { ...proposal, state: 'accepted', history: history('accepted') } };
  if (request.action === 'reject') {
    return {
      next: { ...proposal, state: 'rejected', history: history('rejected', request.note) },
      tombstone: tombstoneFor(proposal, at, request.note),
    };
  }
  return { next: { ...proposal, ruleText: request.ruleText, history: history('edited') } };
}

/**
 * Accept, reject or reword one proposal.
 *
 * The whole read-decide-rewrite runs inside one transaction: the board is a single snapshot rewritten
 * whole, so two verdicts landing together must not lose one.
 *
 * An ACCEPT also records the rendered patch under the state home's `learning/patches/`, which is the
 * durable answer to "what did I agree to, and when" — the only thing the daemon writes on a human's
 * behalf, and it writes it inside its own home.
 */
async function act(subsystem: LearningSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = pathProposalId(context);
  const request = await parseBody(context.request, LearningActionRequestSchema);
  const at = subsystem.now();
  const next = await subsystem.transaction(async () => {
    const proposals = await subsystem.store.loadProposals();
    const current = locate(proposals, id);
    const decision = decide(current, request, at);
    await subsystem.store.saveProposals(proposals.map(entry => (entry === current ? decision.next : entry)));
    if (decision.tombstone !== undefined) {
      await subsystem.store.saveTombstones([...(await subsystem.store.loadTombstones()), decision.tombstone]);
    }
    if (request.action === 'accept')
      await subsystem.store.writePatch(current.identity, renderPatch(decision.next).contents);
    return decision.next;
  });
  const view = proposalView(next, await subsystem.store.observationsById());
  // The verdict landed either way; what cannot be produced is the RESPONSE, because the view demands
  // a surviving quote. Saying so beats answering with a shape the client will refuse to parse.
  if (view === undefined)
    throw new ApiError(409, `proposal ${next.id} has no surviving evidence to render`, 'evidence-missing');
  return jsonResponse(view);
}

/**
 * The routes, all `admin`: evidence carries verbatim quotes of what a human typed into a session, and
 * a verdict edits durable state.
 *
 * `noStore` throughout — a cached proposal board shows a rule somebody has already judged.
 *
 * The literal `/v1/learning/proposals` is registered before the `:id` pattern, matching the ordering
 * rule the rest of the surface follows.
 */
export function learningRoutes(subsystem: LearningSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/learning/status',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async () => await status(subsystem),
    },
    {
      method: 'GET',
      path: '/v1/learning/config',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async () => jsonResponse(subsystem.config()),
    },
    {
      method: 'GET',
      path: '/v1/learning/proposals',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context => await listProposals(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/learning/proposals/:id',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context => await act(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/learning/proposals/:id/patch',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context => await patch(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/learning/run',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context =>
        jsonResponse(
          await subsystem.transaction(
            async () => await subsystem.run((await parseBody(context.request, LearningRunRequestSchema)).spawn),
          ),
        ),
    },
  ];
}
