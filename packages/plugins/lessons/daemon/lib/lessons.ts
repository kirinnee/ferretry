import { LESSONS_INSTRUCTION } from './instruction.ts';
import type {
  LessonsApplyPreview,
  LessonsConfig,
  LessonsScanEstimate,
  LessonsScanProgress,
  LessonsScanRequest,
  Proposal,
  ProposalCategory,
  FerretLessons,
  LessonsFerret,
} from '../../contract/index.ts';
import type { AgentLessonToolResult, LessonsGlobalDocument } from '../../contract/index.ts';
import { GLOBAL_LESSONS_DOCUMENT } from '../../contract/index.ts';
import { insertLesson, lessonFileEtag, repoInstructionsFileName, unifiedDiff } from './apply.ts';
import { batchesOf, estimateScan, scanProgress, selectScanSessions } from './scan.ts';
import type { LessonsStorePort } from './store.ts';
import { fileSuggestion, lessonTarget } from './suggest.ts';
import type { ScanRecord, StoredFerretLessons } from './types.ts';

/**
 * LESSONS — passive suggestions, the per-ferret switch, Apply and the explicit scan, over ports.
 *
 * The route layer authenticates and authorizes; this decides. Every port is the composition root's:
 * the sessions it reads, the files it writes, the queued send it re-instructs a ferret with, the miner
 * a scan runs on and the price list an estimate reads.
 */

/** One ferret as lessons need it. */
export interface LessonSessionFacts {
  readonly ferretId: string;
  readonly cwd: string;
  readonly harness: 'claude' | 'codex';
  readonly mode: 'interactive' | 'auto';
  readonly teammate?: string | undefined;
  readonly label?: string | undefined;
  readonly createdAt: string;
  /** Its pane is up, so a queued message reaches it. */
  readonly running: boolean;
  /** The daemon recorded where its transcript is. */
  readonly hasTranscript: boolean;
}

/** The owner's latest message in a session, read from its own transcript, and the turn it was on. */
export interface OwnerMessage {
  readonly text: string;
  readonly at: string;
  readonly turn: number;
}

export interface LessonSessionsPort {
  facts(ferretId: string): Promise<LessonSessionFacts | undefined>;
  list(): Promise<readonly LessonSessionFacts[]>;
  latestOwnerMessage(ferretId: string): Promise<OwnerMessage | undefined>;
}

/** Instruction files outside the state home: read, and written only by an Apply. */
export interface LessonFilesPort {
  /** The project a working folder belongs to: its git root, else the folder itself. */
  projectRoot(cwd: string): Promise<string>;
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  join(directory: string, name: string): string;
}

/** The fleet's global lessons component (`components/instructions/lessons.yaml`) and its document. */
export interface GlobalLessonsPort {
  /** The document's absolute path, and what the owner should know (e.g. no profile includes it). */
  locate(): Promise<{ readonly path: string; readonly notes: readonly string[] }>;
  /** Writes the component file when it is missing, so a profile can include it. */
  ensureComponent(): Promise<void>;
}

/** How a ferret's passive switch reaches it: its launch environment, and a queued message. */
export interface PassiveChannelPort {
  setEnvironment(ferretId: string, passive: boolean): Promise<void>;
  /** Queues `message` without interrupting the ferret; answers the send id. */
  reinstruct(ferretId: string, message: string): Promise<string>;
}

/** The miner a scan runs on. */
export interface ScanMinerPort {
  /** The digest length a miner would be handed for this ferret, or `undefined` when it has no signal. */
  digestCharacters(ferretId: string): Promise<number | undefined>;
  /** Starts one miner over `ferretIds`; `undefined` when none of them has anything to mine. */
  start(
    runId: string,
    batch: number,
    ferretIds: readonly string[],
    agent: string,
    model: string | undefined,
  ): Promise<string | undefined>;
  /** Folds a finished miner's output into the board; `pending` while it is still writing. */
  collect(
    runId: string,
    batch: number,
  ): Promise<{ readonly added: number; readonly merged: number } | 'pending' | 'failed'>;
  stop(minerFerretId: string): Promise<void>;
}

/** What a model costs, from the daemon's price list; `undefined` when it is not priced. */
export interface PricePort {
  usd(model: string, inputTokens: number, outputTokens: number): Promise<number | undefined>;
}

export interface LessonsDependencies {
  readonly store: LessonsStorePort;
  readonly sessions: LessonSessionsPort;
  readonly files: LessonFilesPort;
  readonly global: GlobalLessonsPort;
  readonly passive: PassiveChannelPort;
  readonly miner: ScanMinerPort;
  readonly prices: PricePort;
  readonly config: () => LessonsConfig;
  readonly now: () => string;
  /** The `fy` name the teaching tells a ferret to run. */
  readonly binaryName: string;
  /** The miner's session label: a scan never reads a miner. */
  readonly minerLabel: string;
}

/** A refusal in this domain's own words; the route restates it in HTTP. */
export class LessonsError extends Error {
  constructor(
    readonly reason: 'not-found' | 'invalid' | 'conflict' | 'not-accepted' | 'scan-running' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'LessonsError';
  }
}

/** Where an Apply writes, decided from the lesson and the files that are there. */
interface ApplyTarget {
  readonly path: string;
  readonly capability: 'fleet' | 'filesystem';
  readonly notes: readonly string[];
}

/** Re-instruction messages. The ON one carries the teaching itself, since the environment is fixed. */
export function reinstructionMessage(passive: boolean, binaryName: string): string {
  return passive
    ? `Passive learning is now ON for you (the owner switched it on). ${LESSONS_INSTRUCTION(binaryName)} No reply is needed; carry on with your work.`
    : `Passive learning is now OFF for you (the owner switched it off): stop filing lessons with \`${binaryName} lesson suggest\` unless the owner asks for one. No reply is needed; carry on with your work.`;
}

export class LessonsService {
  constructor(private readonly deps: LessonsDependencies) {}

  // ── Passive switch ─────────────────────────────────────────────────────────────────────────────

  /** The ferrets a view names. */
  async directory(): Promise<readonly LessonsFerret[]> {
    return (await this.deps.sessions.list()).map(fact => ({
      ferretId: fact.ferretId,
      ...(fact.teammate === undefined ? {} : { name: fact.teammate }),
      folder: fact.cwd,
    }));
  }

  /** Every ferret's switch, as recorded. A ferret with no record is not instructed. */
  async ferretLessons(): Promise<readonly FerretLessons[]> {
    return [...(await this.deps.store.loadFerretLessons())];
  }

  /**
   * A new ferret takes the machine default. Called by the start, after the record exists and before the
   * pane launches, so the launch environment already says whether it is instructed.
   */
  async adopt(ferretId: string): Promise<FerretLessons> {
    const record: StoredFerretLessons = {
      ferretId,
      passive: this.deps.config().passiveDefault,
      since: this.deps.now(),
      setBy: 'default',
    };
    await this.save(record);
    await this.deps.passive.setEnvironment(ferretId, record.passive);
    return record;
  }

  /**
   * The owner switches one ferret. Its environment is updated for every later launch, and a RUNNING
   * ferret is told now with a queued message that does not interrupt it — which costs it one turn.
   */
  async setPassive(
    ferretId: string,
    passive: boolean,
  ): Promise<{
    readonly lessons: FerretLessons;
    readonly reinstructed: boolean;
    readonly sendId?: string;
    readonly note: string;
  }> {
    const facts = await this.deps.sessions.facts(ferretId);
    if (facts === undefined) throw new LessonsError('not-found', `no session ${ferretId}`);
    const previous = (await this.deps.store.loadFerretLessons()).find(entry => entry.ferretId === ferretId);
    const record: StoredFerretLessons = { ferretId, passive, since: this.deps.now(), setBy: 'owner' };
    await this.save(record);
    await this.deps.passive.setEnvironment(ferretId, passive);
    const unchanged = (previous?.passive ?? false) === passive;
    if (unchanged) {
      return { lessons: record, reinstructed: false, note: `Passive learning was already ${passive ? 'on' : 'off'}.` };
    }
    if (!facts.running) {
      return {
        lessons: record,
        reinstructed: false,
        note: `Passive learning is ${passive ? 'on' : 'off'}; this ferret is not running, so it learns that at its next launch.`,
      };
    }
    const sendId = await this.deps.passive.reinstruct(ferretId, reinstructionMessage(passive, this.deps.binaryName));
    return {
      lessons: record,
      reinstructed: true,
      sendId,
      note: `Passive learning is ${passive ? 'on' : 'off'}. The ferret was told with a queued message that does not interrupt it; reading it costs one turn.`,
    };
  }

  private async save(record: StoredFerretLessons): Promise<void> {
    const records = await this.deps.store.loadFerretLessons();
    await this.deps.store.saveFerretLessons([...records.filter(entry => entry.ferretId !== record.ferretId), record]);
  }

  // ── Suggest ────────────────────────────────────────────────────────────────────────────────────

  /**
   * A ferret files a lesson. `ferretId` comes from the caller's credential, never from the call; the
   * evidence is the owner's latest message in that session, read here.
   */
  async suggest(ferretId: string, rule: string, scope: ProposalCategory): Promise<AgentLessonToolResult> {
    const facts = await this.deps.sessions.facts(ferretId);
    if (facts === undefined) throw new LessonsError('not-found', `no session ${ferretId}`);
    const [owner, project] = await Promise.all([
      this.deps.sessions.latestOwnerMessage(ferretId),
      this.deps.files.projectRoot(facts.cwd),
    ]);
    const at = this.deps.now();
    const result = fileSuggestion(await this.deps.store.loadProposals(), await this.deps.store.loadTombstones(), {
      rule,
      scope,
      ferretId,
      teammate: facts.teammate,
      mode: facts.mode,
      cwd: facts.cwd,
      project,
      evidence:
        owner === undefined
          ? { quote: rule, source: 'teammate', at }
          : { quote: owner.text, source: 'human', at: owner.at, turn: owner.turn },
      at,
    });
    if (result.outcome === 'previously-rejected') {
      return {
        outcome: 'previously-rejected',
        summary: 'The owner already rejected this lesson, so it was not filed again.',
      };
    }
    if (result.observation !== undefined) await this.deps.store.appendObservations([result.observation]);
    await this.deps.store.saveProposals(result.proposals);
    const proposal = result.proposal as Proposal;
    return {
      outcome: result.outcome,
      proposalId: proposal.id,
      count: proposal.count,
      summary:
        result.outcome === 'filed'
          ? `Filed a new ${scope === 'global' ? 'Global' : 'Repo'} lesson for the owner to review.`
          : `This matches a lesson already filed; it is now ${String(proposal.count)}×.`,
    };
  }

  // ── Apply ──────────────────────────────────────────────────────────────────────────────────────

  private async target(proposal: Proposal): Promise<ApplyTarget> {
    if (proposal.category === 'global') {
      const located = await this.deps.global.locate();
      return { path: located.path, capability: 'fleet', notes: located.notes };
    }
    const root = proposal.project;
    if (root === undefined) throw new LessonsError('invalid', `lesson ${proposal.id} has no project to write to`);
    const agents = this.deps.files.join(root, 'AGENTS.md');
    const claude = this.deps.files.join(root, 'CLAUDE.md');
    const [agentsText, claudeText, harness] = await Promise.all([
      this.deps.files.read(agents),
      this.deps.files.read(claude),
      this.harnessOf(proposal),
    ]);
    const name = repoInstructionsFileName(
      { agents: agentsText !== undefined, claude: claudeText !== undefined },
      harness,
    );
    return { path: this.deps.files.join(root, name), capability: 'filesystem', notes: [] };
  }

  /** The CLI of the ferret that filed the lesson, which decides the file a new repo lesson creates. */
  private async harnessOf(proposal: Proposal): Promise<'claude' | 'codex'> {
    const ferretId = (await this.deps.store.observationsById()).get(proposal.observationIds[0] ?? '')?.ferretId;
    const facts = ferretId === undefined ? undefined : await this.deps.sessions.facts(ferretId);
    return facts?.harness ?? 'claude';
  }

  private async accepted(id: string): Promise<Proposal> {
    const proposal = (await this.deps.store.loadProposals()).find(entry => entry.id === id || entry.identity === id);
    if (proposal === undefined) throw new LessonsError('not-found', `no lesson ${id}`);
    if (proposal.state !== 'accepted')
      throw new LessonsError(
        'not-accepted',
        `lesson ${proposal.id} is ${proposal.state}; accept it before applying it`,
      );
    return proposal;
  }

  /** Exactly what Apply would write, and the etag that pins it. Reads; writes nothing. */
  async applyPreview(id: string): Promise<LessonsApplyPreview> {
    const proposal = await this.accepted(id);
    const target = await this.target(proposal);
    const before = await this.deps.files.read(target.path);
    return {
      proposalId: proposal.id,
      category: proposal.category,
      path: target.path,
      exists: before !== undefined,
      etag: lessonFileEtag(before),
      diff: unifiedDiff(target.path, before, insertLesson(before, proposal.ruleText)),
      capability: target.capability,
      notes: [...target.notes],
    };
  }

  /** Where `id` would be written and the grant that write needs, for the route to authorize first. */
  async applyCapability(id: string): Promise<'fleet' | 'filesystem'> {
    return (await this.target(await this.accepted(id))).capability;
  }

  /**
   * Writes the lesson, only if the file still has the content the owner saw (`etag`), and marks it
   * applied. A global lesson also makes sure its component exists, so a profile can include it.
   */
  async apply(id: string, etag: string): Promise<Proposal> {
    const proposal = await this.accepted(id);
    const target = await this.target(proposal);
    const before = await this.deps.files.read(target.path);
    if (lessonFileEtag(before) !== etag)
      throw new LessonsError(
        'conflict',
        `${target.path} changed since the preview; look at the new diff and apply again`,
      );
    if (proposal.category === 'global') await this.deps.global.ensureComponent();
    await this.deps.files.write(target.path, insertLesson(before, proposal.ruleText));
    const at = this.deps.now();
    const applied: Proposal = {
      ...proposal,
      state: 'applied',
      applied: { at, path: target.path },
      history: [...proposal.history, { at, event: 'applied', by: 'user', note: target.path }],
    };
    const proposals = await this.deps.store.loadProposals();
    await this.deps.store.saveProposals(proposals.map(entry => (entry.id === proposal.id ? applied : entry)));
    return applied;
  }

  // ── The Global document: the owner reads it and rewrites it (today: the file in any editor) ──────

  /** The Global document as it is now, with the etag a rewrite must name. Empty before the first Apply. */
  async globalDocument(): Promise<LessonsGlobalDocument> {
    const located = await this.deps.global.locate();
    const text = await this.deps.files.read(located.path);
    return { name: GLOBAL_LESSONS_DOCUMENT, text: text ?? '', etag: lessonFileEtag(text), notes: [...located.notes] };
  }

  /**
   * The owner's whole new Global document — how an applied Global lesson is changed or removed. Written only if the
   * document still has the etag the owner read; every later launch reads the new text.
   */
  async writeGlobalDocument(text: string, etag: string): Promise<LessonsGlobalDocument> {
    const located = await this.deps.global.locate();
    if (lessonFileEtag(await this.deps.files.read(located.path)) !== etag)
      throw new LessonsError(
        'conflict',
        `the ${GLOBAL_LESSONS_DOCUMENT} changed since you read it; read it again and make your change there`,
      );
    await this.deps.files.write(located.path, text);
    return { name: GLOBAL_LESSONS_DOCUMENT, text, etag: lessonFileEtag(text), notes: [...located.notes] };
  }

  /** Changes where a lesson goes. A repo lesson needs the project it came from. */
  categorize(proposal: Proposal, category: ProposalCategory): Proposal {
    if (proposal.state === 'applied')
      throw new LessonsError('conflict', `lesson ${proposal.id} is already applied; its type no longer changes`);
    if (category === 'repo' && proposal.project === undefined)
      throw new LessonsError('invalid', `lesson ${proposal.id} came from no single project, so it can only be Global`);
    return { ...proposal, category, target: lessonTarget(category, proposal.project) };
  }

  // ── Scan ───────────────────────────────────────────────────────────────────────────────────────

  private async selection(request: LessonsScanRequest) {
    const [facts, learning] = await Promise.all([this.deps.sessions.list(), this.deps.store.loadFerretLessons()]);
    const passive = new Set(learning.filter(entry => entry.passive).map(entry => entry.ferretId));
    const selected = selectScanSessions(
      facts.map(fact => ({
        ferretId: fact.ferretId,
        cwd: fact.cwd,
        createdAt: fact.createdAt,
        label: fact.label,
        hasTranscript: fact.hasTranscript,
        passive: passive.has(fact.ferretId),
      })),
      request.scope,
      this.deps.minerLabel,
    );
    const limit = this.deps.config().maxFerretsPerRun;
    return {
      ferretIds: selected.ferretIds.slice(0, limit),
      skipped: selected.skipped,
      beyondLimit: Math.max(0, selected.ferretIds.length - limit),
    };
  }

  /** What a scan would read and cost. Spends nothing: it measures digests and reads the price list. */
  async estimate(request: LessonsScanRequest): Promise<LessonsScanEstimate> {
    const config = this.deps.config();
    const selection = await this.selection(request);
    const characters = (
      await Promise.all(selection.ferretIds.map(async id => await this.deps.miner.digestCharacters(id)))
    ).filter((value): value is number => value !== undefined);
    const cost = estimateScan(characters, config.batchSize);
    const model = request.model ?? config.model;
    const usd =
      cost.miners === 0
        ? 0
        : model === undefined
          ? undefined
          : await this.deps.prices.usd(model, cost.inputTokens, cost.outputTokens);
    return {
      ferrets: selection.ferretIds.length,
      ferretIds: [...selection.ferretIds],
      skipped: selection.skipped,
      beyondLimit: selection.beyondLimit,
      tokens: cost.inputTokens + cost.outputTokens,
      ...(usd === undefined ? {} : { usd }),
      miners: cost.miners,
      agent: request.agent ?? config.agent,
      ...(model === undefined ? {} : { model }),
    };
  }

  /** Starts a scan the owner asked for. One at a time. */
  async startScan(request: LessonsScanRequest): Promise<LessonsScanProgress> {
    const state = await this.deps.store.loadState();
    if (state.scan?.state === 'running') throw new LessonsError('scan-running', 'a scan is already running');
    const config = this.deps.config();
    const selection = await this.selection(request);
    const at = this.deps.now();
    const runId = `scan-${at.replace(/[:.]/gu, '-')}`;
    const batches = batchesOf(selection.ferretIds, config.batchSize);
    const started: ScanRecord['batches'][number][] = [];
    for (const [index, ferretIds] of batches.entries()) {
      const miner = await this.deps.miner.start(
        runId,
        index,
        ferretIds,
        request.agent ?? config.agent,
        request.model ?? config.model,
      );
      started.push({ ...(miner === undefined ? {} : { minerFerretId: miner }), ferretIds: [...ferretIds] });
    }
    // A batch with nothing to mine started no miner, so it is read already.
    const done = started.filter(batch => batch.minerFerretId === undefined).reduce((n, b) => n + b.ferretIds.length, 0);
    const finished = started.every(batch => batch.minerFerretId === undefined);
    const record: ScanRecord = {
      runId,
      state: finished ? 'finished' : 'running',
      ferretIds: [...selection.ferretIds],
      batches: started,
      startedAt: at,
      ...(finished ? { finishedAt: at } : {}),
      done,
      added: 0,
      merged: 0,
      ...(selection.ferretIds.length === 0 ? { message: 'no ferrets in this scope have a transcript to read' } : {}),
    };
    await this.deps.store.saveState({ ...state, scan: record });
    return scanProgress(record);
  }

  /**
   * The newest scan, after folding in every miner that has finished. Reading progress is what moves
   * it: a miner's output is ingested the first time someone looks after it lands.
   */
  async scanProgress(): Promise<LessonsScanProgress | undefined> {
    const state = await this.deps.store.loadState();
    const record = state.scan;
    if (record === undefined) return undefined;
    if (record.state !== 'running') return scanProgress(record);
    let { done, added, merged } = record;
    let failed = false;
    const batches = [];
    for (const [index, batch] of record.batches.entries()) {
      if (batch.minerFerretId === undefined) {
        batches.push(batch);
        continue;
      }
      const collected = await this.deps.miner.collect(record.runId, index);
      if (collected === 'pending') {
        batches.push(batch);
        continue;
      }
      done += batch.ferretIds.length;
      if (collected === 'failed') failed = true;
      else {
        added += collected.added;
        merged += collected.merged;
      }
      batches.push({ ferretIds: batch.ferretIds });
    }
    const running = batches.some(batch => batch.minerFerretId !== undefined);
    const at = this.deps.now();
    const next: ScanRecord = {
      ...record,
      batches,
      done,
      added,
      merged,
      state: running ? 'running' : failed ? 'failed' : 'finished',
      ...(running ? {} : { finishedAt: at }),
      ...(failed ? { message: 'a miner wrote output that was not valid; its ferrets were skipped' } : {}),
    };
    await this.deps.store.saveState({ ...state, scan: next });
    return scanProgress(next);
  }

  /** Stops every miner still running. What already landed stays in the inbox. */
  async cancelScan(): Promise<LessonsScanProgress> {
    const state = await this.deps.store.loadState();
    const record = state.scan;
    if (record === undefined) throw new LessonsError('not-found', 'no scan has run');
    if (record.state !== 'running') return scanProgress(record);
    for (const batch of record.batches) {
      if (batch.minerFerretId !== undefined) await this.deps.miner.stop(batch.minerFerretId);
    }
    const next: ScanRecord = {
      ...record,
      batches: record.batches.map(batch => ({ ferretIds: batch.ferretIds })),
      state: 'cancelled',
      finishedAt: this.deps.now(),
      message: 'cancelled by the owner',
    };
    await this.deps.store.saveState({ ...state, scan: next });
    return scanProgress(next);
  }
}
