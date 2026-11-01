import {
  AgentLessonToolCallSchema,
  LEARNING_APPLY_CONFLICT_CODE,
  LearningActionRequestSchema,
  type LearningActionRequest,
  LearningApplyRequestSchema,
  type LearningConfig,
  LearningConfigPatchSchema,
  LearningRunRequestSchema,
  type LearningPatchResponse,
  LearningScanRequestSchema,
  type LearningScanView,
  type LearningStatus,
  type ProposalState,
  type ProposalView,
  RunManifestSchema,
  STEP_UP_REQUIRED_CODE,
  SessionLearningPatchSchema,
  type SessionLearningPatchResult,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import type { AgentIdentityResolver } from '../../agent-tools/types.ts';
import { isAgentCaller, OWNER_ONLY_CODE } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import { grantRefusalCode } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiRequest, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  recomputeProposal,
  strengthOf,
  titleHash,
  LessonsError,
  type LessonsService,
  type LearningStorePort,
  type Observation,
  type Proposal,
  type Tombstone,
} from '../../learning/index.ts';
import { presentedSessionCapability, TWO_SESSION_CREDENTIALS } from './agent-tools.ts';

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
 * THE OPERATOR'S GUIDANCE FILE. Accepting a proposal does NOT edit it: an accepted rule is rendered as a
 * patch DOCUMENT and recorded under `learning/patches/`, inside the state home. APPLY is the one write
 * outside it, and it is a separate act with its own guard (docs/learning.md): `GET …/apply-preview`
 * shows the exact diff and an etag of the file as it is, and `POST …/apply {etag}` writes exactly that,
 * only if the file has not moved since. A Global lesson goes into the fleet's `instructions/lessons`
 * component (`fleet.configure`); a Repo lesson into that project's AGENTS.md / CLAUDE.md
 * (`filesystem.configure`, and a remote device proves a passkey for it). A ferret can never apply one.
 *
 * PASSIVE LESSONS. A ferret instructed to learn files `fy lesson suggest` through `POST /v1/agent/lessons`,
 * authenticated by its session credential alone; the daemon attaches the evidence from that session
 * itself. `PATCH /v1/sessions/:sessionId/learning` switches the instruction for one ferret and tells a
 * running one with a queued, non-interrupting message. A SCAN is estimated first and started only by
 * an explicit request (`/v1/learning/scan/*`).
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
  /** Passive lessons, the per-ferret switch, Apply and the explicit scan. */
  readonly lessons: LessonsService;
  /** Turns the session credential an agent presents into the session it was minted for. */
  readonly identities: AgentIdentityResolver;
  /** Writes `passiveDefault` into `learning.yaml`, keeping the owner's comments; answers what is in effect. */
  writeConfig(patch: { readonly passiveDefault: boolean }): Promise<LearningConfig>;
}

/** An instant the response schema will accept, or `undefined`. The state document is decoded from
 *  JSON without validation, so a torn or hand-edited file must not become an invalid response. */
function instantOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** The lifecycle state a list may be narrowed to. An unknown one is refused rather than ignored:
 *  answering a narrowed request with the whole board looks like a board that matched everything. */
const PROPOSAL_STATES: readonly ProposalState[] = ['pending', 'accepted', 'applied', 'rejected'];

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
      ...(observation.turn === undefined ? {} : { turn: observation.turn }),
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
    passiveDefault: config.passiveDefault,
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
  lessons: LessonsService,
): { readonly next: Proposal; readonly tombstone?: Tombstone } {
  // A verdict is final. Re-judging a rejected rule would resurrect one the human already killed, and
  // the state it is in is the board's answer rather than the caller's mistake — so 409, not 400.
  if (proposal.state === 'rejected')
    throw new ApiError(409, `proposal ${proposal.id} was already rejected`, 'already-rejected');
  // An applied lesson is in its file: changing it here would make the inbox disagree with the file.
  if (proposal.state === 'applied')
    throw new ApiError(409, `lesson ${proposal.id} is already applied; edit its file instead`, 'already-applied');
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
  if (request.action === 'reopen') return { next: { ...proposal, state: 'pending', history: history('reopened') } };
  if (request.action === 'categorize') {
    const moved = refuseLessons(() => lessons.categorize(proposal, request.category));
    return { next: { ...moved, history: history(`categorized:${request.category}`) } };
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
    const decision = decide(current, request, at, subsystem.lessons);
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

// ── Lessons: passive suggestions, the per-ferret switch, Apply and the explicit scan ───────────────

/** The HTTP answer to each refusal the lessons domain raises. */
const LESSONS_REFUSALS: Readonly<Record<LessonsError['reason'], { readonly status: number; readonly code: string }>> = {
  'not-found': { status: 404, code: 'not-found' },
  invalid: { status: 400, code: 'invalid_request' },
  conflict: { status: 409, code: LEARNING_APPLY_CONFLICT_CODE },
  'not-accepted': { status: 409, code: 'not_accepted' },
  'scan-running': { status: 409, code: 'scan_running' },
};

/** Restates a lessons refusal in the HTTP vocabulary; anything else is rethrown untouched. */
function lessonsRefusal(error: unknown): never {
  if (error instanceof LessonsError) {
    const refusal = LESSONS_REFUSALS[error.reason];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/** Runs a synchronous lessons decision, restating its refusal. */
function refuseLessons<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    return lessonsRefusal(error);
  }
}

/**
 * `POST /v1/agent/lessons` — a ferret files a lesson. Authenticated by the session credential ALONE:
 * the session is the credential's, and the evidence is read from that session by the daemon, so the
 * call can name neither.
 */
async function agentSuggest(subsystem: LearningSubsystem, context: RouteContext): Promise<ApiResponse> {
  // A `fys_` bearer or the older header, exactly as the agent tools take it.
  const presented = presentedSessionCapability(context.request);
  if (presented.kind === 'two-different') throw new ApiError(401, TWO_SESSION_CREDENTIALS, 'unauthorized');
  const capability = presented.kind === 'one' ? presented.capability : '';
  const identity = capability === '' ? undefined : await subsystem.identities.resolve(capability);
  if (identity === undefined) {
    const missing = capability === '';
    const message =
      'filing a lesson needs the session credential Ferretry gives each ferret; run it from inside a ferret';
    throw new ApiError(missing ? 401 : 403, message, missing ? 'missing_capability' : 'forbidden');
  }
  const call = await parseBody(context.request, AgentLessonToolCallSchema);
  const result = await subsystem
    .transaction(async () => await subsystem.lessons.suggest(identity.sessionId, call.rule, call.scope))
    .catch(lessonsRefusal);
  return jsonResponse(result);
}

/** The session id in a `/v1/sessions/:sessionId/...` path. */
function pathSessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** `PATCH /v1/sessions/:sessionId/learning` — switch one ferret, re-instructing it if it is running. */
async function setPassive(subsystem: LearningSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = pathSessionId(context);
  const request = await parseBody(context.request, SessionLearningPatchSchema);
  const result = await subsystem
    .transaction(async () => await subsystem.lessons.setPassive(id, request.passive))
    .catch(lessonsRefusal);
  return jsonResponse(result satisfies SessionLearningPatchResult);
}

/** The `403 grant_step_up_required` body for a write into a project's own files. */
function stepUpRefusal(message: string, capability: 'fleet' | 'filesystem'): ApiResponse {
  return jsonResponse(
    {
      error: message,
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability, axis: 'configure' },
    } satisfies StepUpRequiredBody,
    403,
  );
}

/**
 * Whether this caller may write where the lesson goes: the fleet's global instructions (`fleet`), or a
 * project's own AGENTS.md / CLAUDE.md (`filesystem`), on the `configure` axis. A remote device writing
 * into a project also proves a passkey for it. Answers the refusal, or `undefined` when allowed.
 */
function applyRefusal(context: RouteContext, capability: 'fleet' | 'filesystem'): ApiResponse | undefined {
  const governance = context.governance;
  if (governance === undefined)
    return jsonResponse(
      { error: 'this daemon cannot say whether this caller may write lessons', code: 'forbidden' },
      403,
    );
  const decision = governance.decide({ capability, axis: 'configure' });
  const where = capability === 'fleet' ? 'the global instructions' : "a project's instruction file";
  if (!decision.allowed) {
    if (decision.refusal === 'step-up-required')
      return stepUpRefusal(`writing a lesson into ${where} from this device needs a passkey confirmation`, capability);
    return jsonResponse(
      { error: `this device may not write a lesson into ${where}`, code: grantRefusalCode(decision.refusal) },
      403,
    );
  }
  if (capability === 'filesystem' && governance.governed && context.presentation?.freshStepUp !== true)
    return stepUpRefusal(`writing a lesson into ${where} from this device needs a passkey confirmation`, capability);
  return undefined;
}

/** `GET …/apply-preview` — the diff and the etag. Reads only. */
async function applyPreview(subsystem: LearningSubsystem, context: RouteContext): Promise<ApiResponse> {
  return jsonResponse(await subsystem.lessons.applyPreview(pathProposalId(context)).catch(lessonsRefusal));
}

/**
 * `POST …/apply {etag}` — writes the lesson into its file, only if the file is still what the preview
 * showed. Never for an agent: applying is the owner's act.
 */
async function apply(subsystem: LearningSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = pathProposalId(context);
  const request = await parseBody(context.request, LearningApplyRequestSchema);
  if (isAgentCaller(context))
    throw new ApiError(403, 'a ferret cannot apply a lesson; the owner applies it', 'forbidden');
  const capability = await subsystem.lessons.applyCapability(id).catch(lessonsRefusal);
  const refused = applyRefusal(context, capability);
  if (refused !== undefined) return refused;
  const applied = await subsystem
    .transaction(async () => await subsystem.lessons.apply(id, request.etag))
    .catch(lessonsRefusal);
  if (capability === 'filesystem' && context.governance?.governed === true) context.spendFreshStepUp?.();
  const view = proposalView(applied, await subsystem.store.observationsById());
  if (view === undefined)
    throw new ApiError(409, `lesson ${applied.id} has no surviving evidence to render`, 'evidence-missing');
  return jsonResponse(view);
}

/** `GET /v1/learning/scan` — the newest scan, after folding in every miner that has finished. */
async function scanView(subsystem: LearningSubsystem): Promise<ApiResponse> {
  const scan = await subsystem.transaction(async () => await subsystem.lessons.scanProgress());
  return jsonResponse((scan === undefined ? {} : { scan }) satisfies LearningScanView);
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
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async () => await status(subsystem),
    },
    {
      method: 'GET',
      path: '/v1/learning/config',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async () => jsonResponse(subsystem.config()),
    },
    {
      method: 'GET',
      path: '/v1/learning/proposals',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await listProposals(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/learning/proposals/:id',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await act(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/learning/proposals/:id/patch',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await patch(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/learning/run',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const { spawn } = await parseBody(context.request, LearningRunRequestSchema);
        // A run that LAUNCHES miners starts sessions with no parent, so only a person asks for one; a ferret may
        // still ask for the run's manifest. No ferret starts a session that is not its own child.
        if (spawn && isAgentCaller(context))
          throw new ApiError(403, 'a ferret cannot launch learning miners; ask the owner', OWNER_ONLY_CODE);
        return jsonResponse(await subsystem.transaction(async () => await subsystem.run(spawn)));
      },
    },
    {
      method: 'PATCH',
      path: '/v1/learning/config',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'fleet', axis: 'configure' },
      noStore: true,
      handle: async context =>
        jsonResponse(await subsystem.writeConfig(await parseBody(context.request, LearningConfigPatchSchema))),
    },
    {
      method: 'GET',
      path: '/v1/learning/proposals/:id/apply-preview',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await applyPreview(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/learning/proposals/:id/apply',
      minimum: 'operator',
      caller: 'person',
      // Reached as `fleet.use`; the handler then asks for the TARGET's own grant on `configure`.
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async context => await apply(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/learning/sessions',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async () => jsonResponse(await subsystem.lessons.sessionLearning()),
    },
    {
      method: 'PATCH',
      path: '/v1/sessions/:sessionId/learning',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await setPassive(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/learning/scan/estimate',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context =>
        jsonResponse(
          await subsystem.lessons
            .estimate(await parseBody(context.request, LearningScanRequestSchema))
            .catch(lessonsRefusal),
        ),
    },
    {
      method: 'POST',
      path: '/v1/learning/scan/cancel',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async () =>
        jsonResponse(
          await subsystem.transaction(async () => await subsystem.lessons.cancelScan()).catch(lessonsRefusal),
        ),
    },
    {
      method: 'GET',
      path: '/v1/learning/scan',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async () => await scanView(subsystem),
    },
    // A PERSON'S ACT: a scan launches one miner session per batch, each with no parent, on the agent and model the
    // body names. No ferret starts a session that is not its own child; it may still read the estimate.
    {
      method: 'POST',
      path: '/v1/learning/scan',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, LearningScanRequestSchema);
        return jsonResponse(
          await subsystem.transaction(async () => await subsystem.lessons.startScan(request)).catch(lessonsRefusal),
          201,
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/agent/lessons',
      minimum: 'none',
      caller: 'any',
      privilegedOnly: true,
      noStore: true,
      handle: async context => await agentSuggest(subsystem, context),
    },
  ];
}
