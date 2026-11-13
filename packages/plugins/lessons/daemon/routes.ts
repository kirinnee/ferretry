import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type ConfigWriteOutcome,
  decodeParameter,
  jsonResponse,
  queryValue,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import {
  CAPABILITIES,
  OWNER_ONLY_CODE,
  STEP_UP_REQUIRED_CODE,
  ferretOf,
  grantRefusalCode,
  isFerretCall,
} from '@ferretry/core-gate/contract';
import type { StepUpRequiredBody } from '@ferretry/core-gate/contract';
import {
  AgentLessonToolCallSchema,
  type FerretLessonsPatchResult,
  LESSONS_APPLY_CONFLICT_CODE,
  LESSONS_MINER_GAP_CODE,
  type LessonsActionRequest,
  LessonsActionRequestSchema,
  LessonsApplyRequestSchema,
  type LessonsConfigPatch,
  LessonsConfigPatchSchema,
  type LessonsGlobalDocument,
  LessonsGlobalWriteSchema,
  type LessonsConfig,
  type LessonsConfigAnswer,
  LessonsRunRequestSchema,
  type LessonsPatchResponse,
  LessonsScanRequestSchema,
  type LessonsScanView,
  type LessonsStatus,
  FerretLessonsPatchSchema,
  type ProposalState,
  type ProposalView,
  RunManifestSchema,
} from '../contract/index.ts';
import { parseBody } from './lib/body.ts';
import {
  LessonsError,
  type LessonsService,
  type LessonsStorePort,
  type Observation,
  type Proposal,
  type SerialSection,
  type Tombstone,
  recomputeProposal,
  strengthOf,
  titleHash,
} from './lib/index.ts';

/** The lessons subsystem as the routes need it. The store is the DOMAIN port, not the adapter. */
export interface LessonsSubsystem {
  readonly store: LessonsStorePort;
  /** One read-decide-rewrite of the board as a single critical section. */
  readonly serial: SerialSection;
  /** The mining schedule, the agent that will perform it and the machine switch, all from `lessons.yaml`. */
  config(): Promise<LessonsConfig>;
  /** Writes the machine switch into `lessons.yaml` through the kernel's config write port (the one writer). */
  writeConfig(patch: LessonsConfigPatch): Promise<ConfigWriteOutcome>;
  /** Whether `lessons.yaml` holds an edit waiting for the owner (the kernel's file state). */
  configHeld(): boolean;
  /** The instant a verdict is stamped with. */
  now(): string;
  /** Runs an ingest pass and, when requested, starts a bounded miner batch. */
  run(spawn: boolean): Promise<import('../contract/index.ts').RunManifest>;
  /** Passive lessons, the per-ferret switch, Apply and the explicit scan. */
  readonly lessons: LessonsService;
  /** Tells the app the board changed. */
  changed(): void;
}

/** An instant the response schema will accept, or `undefined`. */
function instantOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** The lifecycle state a list may be narrowed to. An unknown one is refused rather than ignored. */
const PROPOSAL_STATES: readonly ProposalState[] = ['pending', 'accepted', 'applied', 'rejected'];

function requestedState(call: CallContext): ProposalState | undefined {
  for (const [name] of call.request.query) {
    if (name !== 'state') throw new ApiError(400, `unknown proposals parameter ${name}`, 'unknown_parameter');
  }
  const raw = queryValue(call.request, 'state');
  if (raw === undefined) return undefined;
  const known = PROPOSAL_STATES.find(state => state === raw);
  if (known === undefined) throw new ApiError(400, `unknown proposal state ${raw}`, 'invalid_state');
  return known;
}

/** A decoded path parameter. `decodeParameter` refuses a traversal or a separator. */
function pathParameter(call: CallContext, name: string, what: string, code: string): string {
  const decoded = decodeParameter(call.params.get(name) ?? '');
  if (decoded === undefined || decoded === '') throw new ApiError(400, `the ${what} in the path is not usable`, code);
  return decoded;
}
const pathProposalId = (call: CallContext): string => pathParameter(call, 'id', 'proposal id', 'invalid_proposal_id');

/**
 * One proposal with the evidence a human reads before judging it. Counters are RECOMPUTED from the observations that
 * still exist; `undefined` when not one quote survives.
 */
function proposalView(proposal: Proposal, observations: ReadonlyMap<string, Observation>): ProposalView | undefined {
  const recomputed = recomputeProposal(proposal, observations);
  const evidence = recomputed.observationIds
    .map(id => observations.get(id))
    .filter((observation): observation is Observation => observation !== undefined)
    .map(observation => ({
      observationId: observation.id,
      ferretId: observation.ferretId,
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
async function status(subsystem: LessonsSubsystem): Promise<ApiResponse> {
  const config = await subsystem.config();
  const [state, observations, proposals, tombstones, manifest] = await Promise.all([
    subsystem.store.loadState(),
    subsystem.store.readObservations(),
    subsystem.store.loadProposals(),
    subsystem.store.loadTombstones(),
    subsystem.store.latestRunManifest(),
  ]);
  const index = new Map(observations.map(entry => [entry.id, entry]));
  const pending = proposals.filter(entry => entry.state === 'pending').map(entry => recomputeProposal(entry, index));
  const strong = pending.filter(entry => strengthOf(entry.occurrences) === 'strong').length;
  const lastRun = manifest === undefined ? undefined : RunManifestSchema.safeParse(manifest).data;
  const response: LessonsStatus = {
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    ...(instantOrUndefined(state.watermarkAt) === undefined ? {} : { watermarkAt: state.watermarkAt as string }),
    ...(instantOrUndefined(state.lastRunAt) === undefined ? {} : { lastRunAt: state.lastRunAt as string }),
    pending: { total: pending.length, strong, weak: pending.length - strong },
    totals: { observations: observations.length, proposals: proposals.length, tombstones: tombstones.length },
    running: state.runningRunId !== undefined,
    ...(lastRun === undefined ? {} : { lastRun }),
    passiveDefault: config.passiveDefault,
  };
  return jsonResponse(response);
}

/** The proposal board, optionally narrowed to one lifecycle state. */
async function listProposals(subsystem: LessonsSubsystem, call: CallContext): Promise<ApiResponse> {
  const state = requestedState(call);
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

/** The document a human applies to their own guidance file: the RULE rendered, never the operator's file rewritten. */
function renderPatch(proposal: Proposal): LessonsPatchResponse {
  const anchor = proposal.target.anchor;
  const lines = [
    `<!-- ferretry lessons proposal ${proposal.id} -->`,
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

/**
 * A rejected rule's headstone. Both the stable identity and a hash of the title are recorded, because the next run may
 * propose the same rule under a reworded title.
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

/** The HTTP answer to each refusal the lessons domain raises. */
const LESSONS_REFUSALS: Readonly<Record<LessonsError['reason'], { readonly status: number; readonly code: string }>> = {
  'not-found': { status: 404, code: 'not-found' },
  invalid: { status: 400, code: 'invalid_request' },
  conflict: { status: 409, code: LESSONS_APPLY_CONFLICT_CODE },
  'not-accepted': { status: 409, code: 'not_accepted' },
  'scan-running': { status: 409, code: 'scan_running' },
  unavailable: { status: 503, code: LESSONS_MINER_GAP_CODE },
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

/** The proposal as the verdict leaves it, plus the tombstone a rejection adds. */
function decide(
  proposal: Proposal,
  request: LessonsActionRequest,
  at: string,
  lessons: LessonsService,
): { readonly next: Proposal; readonly tombstone?: Tombstone } {
  // A verdict is final. Re-judging a rejected rule would resurrect one the human already killed.
  if (proposal.state === 'rejected')
    throw new ApiError(409, `proposal ${proposal.id} was already rejected`, 'already-rejected');
  // An applied lesson is in its file: changing it here would make the inbox disagree with the file.
  if (proposal.state === 'applied')
    throw new ApiError(
      409,
      proposal.category === 'global'
        ? `lesson ${proposal.id} is already applied; change or remove it in the Global lessons document (Settings › Lessons, or fy lesson global)`
        : `lesson ${proposal.id} is already applied; edit ${proposal.applied?.path ?? 'its file'} instead`,
      'already-applied',
    );
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
 * Accept, reject or reword one proposal, in one transaction. An ACCEPT also records the rendered patch under the state
 * folder's `patches/`: the durable answer to "what did I agree to, and when".
 */
async function act(subsystem: LessonsSubsystem, call: CallContext): Promise<ApiResponse> {
  const id = pathProposalId(call);
  const request = await parseBody(call.request, LessonsActionRequestSchema);
  const at = subsystem.now();
  const next = await subsystem.serial.run(async () => {
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
  subsystem.changed();
  const view = proposalView(next, await subsystem.store.observationsById());
  if (view === undefined)
    throw new ApiError(409, `proposal ${next.id} has no surviving evidence to render`, 'evidence-missing');
  return jsonResponse(view);
}

/**
 * The caller must be a ferret and the ferret is the credential's: the call can name neither a ferret nor a quote, so a
 * ferret cannot file a lesson in another ferret's name or invent what the owner said.
 */
function callingFerret(call: CallContext): string {
  const ferret = ferretOf(call);
  if (ferret === undefined)
    throw new ApiError(
      403,
      'filing a lesson needs the credential Ferretry gives each ferret; run it from inside a ferret',
      'forbidden',
    );
  return ferret;
}

async function suggest(subsystem: LessonsSubsystem, call: CallContext): Promise<ApiResponse> {
  const ferret = callingFerret(call);
  const body = await parseBody(call.request, AgentLessonToolCallSchema);
  const result = await subsystem.serial
    .run(async () => await subsystem.lessons.suggest(ferret, body.rule, body.scope))
    .catch(lessonsRefusal);
  subsystem.changed();
  return jsonResponse(result);
}

/** `PATCH /v1/ferrets/:ferretId/lessons`: switch one ferret, re-instructing it if it is running. */
async function setPassive(subsystem: LessonsSubsystem, call: CallContext): Promise<ApiResponse> {
  const id = pathParameter(call, 'ferretId', 'ferret id', 'invalid_ferret_id');
  const request = await parseBody(call.request, FerretLessonsPatchSchema);
  const result = await subsystem.serial
    .run(async () => await subsystem.lessons.setPassive(id, request.passive))
    .catch(lessonsRefusal);
  return jsonResponse(result satisfies FerretLessonsPatchResult);
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
 * Whether this caller may write where the lesson goes: the Global lessons document (`fleet`), or a project's own
 * AGENTS.md / CLAUDE.md (`filesystem`), on the `configure` axis. A remote device writing into a project also takes a
 * fresh passkey proof for it, CLAIMED here before anything is written (never read from the admission snapshot and spent
 * after, so of two applies on one proof exactly one writes). Answers the refusal, or `undefined` when allowed.
 */
function applyRefusal(call: CallContext, capability: 'fleet' | 'filesystem'): ApiResponse | undefined {
  const governance = call.governance;
  if (governance === undefined)
    return jsonResponse(
      { error: 'this daemon cannot say whether this caller may write lessons', code: 'forbidden' },
      403,
    );
  const decision = governance.decide({ capability: capabilityRef(capability), axis: 'configure' });
  const where = capability === 'fleet' ? 'the global instructions' : "a project's instruction file";
  if (!decision.allowed) {
    if (decision.refusal === 'step-up-required')
      return stepUpRefusal(`writing a lesson into ${where} from this device needs a passkey confirmation`, capability);
    return jsonResponse(
      { error: `this device may not write a lesson into ${where}`, code: grantRefusalCode(decision.refusal) },
      403,
    );
  }
  if (capability === 'filesystem' && governance.governed && call.claimFreshStepUp?.() !== true)
    return stepUpRefusal(`writing a lesson into ${where} from this device needs a passkey confirmation`, capability);
  return undefined;
}

/**
 * `POST …/apply {etag}`: writes the lesson into its file, only if the file is still what the preview showed. Never for
 * a ferret: applying is the owner's act.
 */
async function apply(subsystem: LessonsSubsystem, call: CallContext): Promise<ApiResponse> {
  const id = pathProposalId(call);
  const request = await parseBody(call.request, LessonsApplyRequestSchema);
  if (isFerretCall(call)) throw new ApiError(403, 'a ferret cannot apply a lesson; the owner applies it', 'forbidden');
  const capability = await subsystem.lessons.applyCapability(id).catch(lessonsRefusal);
  const refused = applyRefusal(call, capability);
  if (refused !== undefined) return refused;
  const applied = await subsystem.serial
    .run(async () => await subsystem.lessons.apply(id, request.etag))
    .catch(lessonsRefusal);
  subsystem.changed();
  const view = proposalView(applied, await subsystem.store.observationsById());
  if (view === undefined)
    throw new ApiError(409, `lesson ${applied.id} has no surviving evidence to render`, 'evidence-missing');
  return jsonResponse(view);
}

async function scanView(subsystem: LessonsSubsystem): Promise<ApiResponse> {
  const scan = await subsystem.serial.run(async () => await subsystem.lessons.scanProgress());
  return jsonResponse((scan === undefined ? {} : { scan }) satisfies LessonsScanView);
}

/**
 * What `PATCH /v1/lessons/config` answers (today's: the settings IN EFFECT after the write). A change the kernel HELD for
 * the owner is not in effect, so the settings answered are still the ones in effect, and `held` says what waits. A
 * refusal names what was wrong by the kernel's own sentences, which never quote a value (a pasted secret goes no further
 * than its file).
 */
function configWritten(outcome: ConfigWriteOutcome, inEffect: LessonsConfig): ApiResponse {
  switch (outcome.kind) {
    case 'written':
      return jsonResponse(inEffect);
    case 'held':
      return jsonResponse({ ...inEffect, held: [...outcome.sentences] } satisfies LessonsConfigAnswer);
    case 'conflict':
      throw new ApiError(409, 'config/lessons.yaml changed while it was being written; try again', 'conflict');
    case 'refused': {
      const why = outcome.issues.map(issue => issue.message).join('; ');
      throw new ApiError(
        400,
        `config/lessons.yaml was not changed: ${why === '' ? outcome.reason : why}`,
        'invalid_request',
      );
    }
  }
}

/**
 * `lessons.yaml` already holds an edit waiting for the owner, so the save is refused before anything is written.
 *
 * DECLARED GAP: today the owner's own save is made to both versions and is in effect at once, the held edit kept
 * (docs/config-files.md rule 3). The kernel's ConfigPort offers no owner-acknowledged write, so a plain write would
 * patch the held disk text and wait behind it (or, were the held edit one a judge could confirm, put it into effect
 * with the owner's save); refusing says so instead, until the kernel offers that write.
 */
const LESSONS_CONFIG_HELD =
  'lessons.yaml has a change waiting for your approval; confirm or discard it first, then save again.';

/** The capability ref a demand names; Gate owns the vocabulary and these two are core names. */
function capabilityRef(name: 'fleet' | 'filesystem') {
  return CAPABILITIES[name];
}

/**
 * The route handlers, keyed by the manifest's route keys. `noStore` throughout (the manifest's flag): a cached board
 * shows a rule somebody has already judged.
 */
export function lessonsRoutes(subsystem: LessonsSubsystem) {
  const handlers = {
    'GET /v1/lessons/status': async () => await status(subsystem),
    'GET /v1/lessons/config': async () => jsonResponse(await subsystem.config()),
    'GET /v1/lessons/proposals': async call => await listProposals(subsystem, call),
    'POST /v1/lessons/proposals/:id': async call => await act(subsystem, call),
    'GET /v1/lessons/proposals/:id/patch': async call => {
      const proposal = locate(await subsystem.store.loadProposals(), pathProposalId(call));
      return jsonResponse(renderPatch(proposal));
    },
    'GET /v1/lessons/global': async () =>
      jsonResponse((await subsystem.lessons.globalDocument().catch(lessonsRefusal)) satisfies LessonsGlobalDocument),
    // A PERSON'S ACT (`fleet.configure`, Gate): the owner rewrites the Global document — edits or removes an applied rule.
    'PUT /v1/lessons/global': async call => {
      if (isFerretCall(call))
        throw new ApiError(403, 'a ferret cannot change the Global lessons; the owner does', 'forbidden');
      const request = await parseBody(call.request, LessonsGlobalWriteSchema);
      const written = await subsystem.serial
        .run(async () => await subsystem.lessons.writeGlobalDocument(request.text, request.etag))
        .catch(lessonsRefusal);
      subsystem.changed();
      return jsonResponse(written satisfies LessonsGlobalDocument);
    },
    'POST /v1/lessons/run': async call => {
      const { spawn } = await parseBody(call.request, LessonsRunRequestSchema);
      // A run that LAUNCHES miners starts ferrets with no parent, so only a person asks for one; a ferret may still ask
      // for the run's manifest. No ferret starts a ferret that is not its own child.
      if (spawn && isFerretCall(call))
        throw new ApiError(403, 'a ferret cannot launch lesson miners; ask the owner', OWNER_ONLY_CODE);
      return jsonResponse(await subsystem.serial.run(async () => await subsystem.run(spawn)).catch(lessonsRefusal));
    },
    // `lessons.yaml` is the one source of truth: the switch is written there, key by key, through the kernel's writer.
    'PATCH /v1/lessons/config': async call => {
      const patch = await parseBody(call.request, LessonsConfigPatchSchema);
      if (subsystem.configHeld()) throw new ApiError(409, LESSONS_CONFIG_HELD, 'config_held');
      const outcome = await subsystem.writeConfig(patch);
      return configWritten(outcome, await subsystem.config());
    },
    'GET /v1/lessons/proposals/:id/apply-preview': async call =>
      jsonResponse(await subsystem.lessons.applyPreview(pathProposalId(call)).catch(lessonsRefusal)),
    'POST /v1/lessons/proposals/:id/apply': async call => await apply(subsystem, call),
    'GET /v1/lessons/directory': async () => jsonResponse(await subsystem.lessons.directory()),
    'GET /v1/lessons/ferrets': async () => jsonResponse(await subsystem.lessons.ferretLessons()),
    'PATCH /v1/ferrets/:ferretId/lessons': async call => await setPassive(subsystem, call),
    'POST /v1/lessons/scan/estimate': async call =>
      jsonResponse(
        await subsystem.lessons.estimate(await parseBody(call.request, LessonsScanRequestSchema)).catch(lessonsRefusal),
      ),
    'POST /v1/lessons/scan/cancel': async () =>
      jsonResponse(await subsystem.serial.run(async () => await subsystem.lessons.cancelScan()).catch(lessonsRefusal)),
    'GET /v1/lessons/scan': async () => await scanView(subsystem),
    // A PERSON'S ACT: a scan launches one miner ferret per batch, each with no parent, on the agent and model the body
    // names.
    'POST /v1/lessons/scan': async call => {
      const request = await parseBody(call.request, LessonsScanRequestSchema);
      return jsonResponse(
        await subsystem.serial.run(async () => await subsystem.lessons.startScan(request)).catch(lessonsRefusal),
        201,
      );
    },
    'POST /v1/lessons/suggest': async call => await suggest(subsystem, call),
  } satisfies Record<string, RouteHandler>;
  return handlers;
}
