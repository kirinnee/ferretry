import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { FerretId, FerretSummary, FerretsApi, HarnessKey } from '@ferretry/core-ferrets/contract';
import type { RootsPort } from '@ferretry/kernel/contract';
import type { LessonsConfig, RunManifest } from '../../contract/index.ts';
import {
  applyMinerOutput,
  extractSession,
  type InboxSendLike,
  type NormalizedRecordLike,
  parseMinerOutput,
  type RawSessionInput,
  type ScanMinerPort,
  type SessionDigest,
} from '../lib/index.ts';
import type { LessonsStorePort } from '../lib/store.ts';
import { LESSONS_MINER_NAME, lessonSessionFacts } from './ferret-sessions.ts';

const RECORD_CAP = 1_200;

/** Where a miner writes its answer: a dotfile in its own folder, read and removed by the ingest. */
export function minerOutputPath(folder: string, run: string): string {
  return `${folder.replace(/\/+$/u, '')}/.fy-lessons-${run}.json`;
}

/** The harness a configured agent names; any other name is a login on the Claude harness. */
function startFor(agent: string): { readonly harness: HarnessKey; readonly login?: string } {
  if (agent === 'claude' || agent === 'claude-code') return { harness: 'claude-code' };
  if (agent === 'codex') return { harness: 'codex' };
  return { harness: 'claude-code', login: agent };
}

export interface MinerDependencies {
  readonly store: LessonsStorePort;
  readonly ferrets: Pick<FerretsApi, 'get' | 'list' | 'start' | 'stop'>;
  readonly conversation: Pick<ConversationApi, 'transcript' | 'sends'>;
  readonly roots: Pick<RootsPort, 'root'>;
  readonly config: () => LessonsConfig;
  readonly now: () => string;
}

/**
 * The orchestration around the pure extractor and aggregator.
 *
 * Ferrets come from Ferrets and their words from Conversation, so this can never read a different daemon's. A ferret
 * with no readable transcript is skipped rather than mined from partial evidence: absence of provenance is reported, never
 * treated as an empty conversation.
 */
export class LessonsMiner implements ScanMinerPort {
  constructor(private readonly deps: MinerDependencies) {}

  async run(spawn: boolean): Promise<RunManifest> {
    const { store, config, now } = this.deps;
    await this.ingest();
    if (!spawn) return (await store.latestRunManifest()) ?? this.emptyManifest('ingest-only run (no spawn requested)');

    const state = await store.loadState();
    const watermark = `${state.watermarkAt ?? ''} ${state.watermarkId ?? ''}`;
    const candidates = (await this.deps.ferrets.list())
      .filter(ferret => ferret.state === 'stopped' && ferret.name !== LESSONS_MINER_NAME)
      .filter(ferret => `${ferret.stateAt} ${ferret.id}` > watermark)
      .toSorted((left, right) => `${left.stateAt} ${left.id}`.localeCompare(`${right.stateAt} ${right.id}`))
      .slice(0, config().maxFerretsPerRun);
    const manifest = this.emptyManifest(undefined, candidates.length);
    if (candidates.length === 0) {
      const complete = { ...manifest, finishedAt: now(), message: 'no new stopped ferrets to scan' };
      await store.writeRunManifest(complete);
      return complete;
    }

    const skipped: string[] = [];
    const digests: SessionDigest[] = [];
    for (const ferret of candidates) {
      const input = await this.input(ferret);
      if (input === undefined) {
        skipped.push(ferret.id);
        continue;
      }
      const digest = extractSession(input);
      if (digest.hasSignal) digests.push(digest);
    }
    const newest = candidates.at(-1) as FerretSummary;
    await store.saveState({
      ...state,
      watermarkAt: newest.stateAt,
      watermarkId: newest.id,
      lastRunAt: now(),
      lastRunId: manifest.runId,
      lastSpawnAt: now(),
    });
    if (digests.length === 0) {
      const complete = {
        ...manifest,
        finishedAt: now(),
        message:
          skipped.length === 0
            ? 'no human signal in the scanned batch'
            : `skipped ${skipped.length} ferret(s) with missing or unreadable transcripts; no complete conversations to mine`,
      };
      await store.writeRunManifest(complete);
      return complete;
    }

    const batch = digests.slice(0, config().batchSize);
    const started = await this.launch(manifest.runId, batch, config().agent, candidates);
    const pending = {
      ...manifest,
      ferretsWithSignal: batch.length,
      minerFerrets: [started],
      ...(skipped.length === 0
        ? {}
        : { message: `skipped ${skipped.length} ferret(s) with missing or unreadable transcripts` }),
    };
    await store.writeRunManifest(pending);
    return pending;
  }

  private emptyManifest(message?: string, ferretsScanned = 0): RunManifest {
    const now = this.deps.now();
    return {
      runId: now.replace(/[:.]/g, '-'),
      startedAt: now,
      ferretsScanned,
      ferretsWithSignal: 0,
      minerFerrets: [],
      observationsProposed: 0,
      observationsVerified: 0,
      rejectedQuotes: 0,
      malformedFiles: 0,
      proposalsCreated: 0,
      proposalsStrengthened: 0,
      proposalsSuppressedByTombstone: 0,
      perHarness: { 'claude-code': 0, codex: 0 },
      ...(message === undefined ? {} : { message }),
    };
  }

  /** One ferret's words as the extractor reads them; `undefined` when no transcript can be read. */
  private async input(ferret: FerretSummary): Promise<RawSessionInput | undefined> {
    const page = await this.deps.conversation.transcript(ferret.id, { limit: RECORD_CAP });
    if (!page.ok) return undefined;
    const records: NormalizedRecordLike[] = page.value.messages.map(message => ({
      type: message.role === 'user' ? 'chat.user' : 'message',
      ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      ...(message.role === 'user' ? { data: { text: message.text } } : {}),
    }));
    const sends = await this.deps.conversation.sends(ferret.id);
    const inbox: InboxSendLike[] = sends.sends
      .filter(send => send.message.trim() !== '')
      .map(send => ({
        text: send.message,
        ...(send.from === undefined ? {} : { from: send.from }),
        ...(send.fromName === undefined ? {} : { fromName: send.fromName }),
        at: send.acceptedAt,
      }));
    const facts = lessonSessionFacts(ferret);
    return {
      ferretId: ferret.id,
      ...(facts.teammate === undefined ? {} : { teammate: facts.teammate }),
      mode: facts.mode,
      cwd: ferret.folder,
      repo: ferret.folder,
      harness: facts.harness,
      status: ferret.state,
      finishedAt: ferret.stateAt,
      records,
      turnTexts: [],
      inbox,
      interrupts: 0,
    };
  }

  /** Starts one miner ferret over `digests`, writing its brief; answers the miner's id. */
  private async launch(
    run: string,
    digests: readonly SessionDigest[],
    agent: string,
    near: readonly FerretSummary[],
  ): Promise<string> {
    const { store, ferrets } = this.deps;
    const folder =
      near.find(ferret => digests.some(digest => digest.ferretId === ferret.id))?.folder ?? near[0]?.folder;
    if (folder === undefined) throw new Error('a lesson miner needs a ferret folder to run in');
    await store.writeDigests(run, digests);
    const started = await ferrets.start({
      name: LESSONS_MINER_NAME,
      ...startFor(agent),
      role: 'lead',
      folder,
      prompt: this.prompt(digests, minerOutputPath(folder, run)),
      by: 'owner',
    });
    if (!started.ok) throw new Error(`the lesson miner could not start: ${started.error.reason}`);
    return started.value;
  }

  // ── Ingest: fold a finished miner's output into the board, once ─────────────────────────────────

  private async ingest(): Promise<void> {
    for (const name of await this.deps.store.runIds()) await this.ingestRun(name);
  }

  /** Reads and removes a miner's answer from the miner's own folder; `undefined` when it has written none. */
  private async takeOutput(manifest: RunManifest, run: string): Promise<string | undefined> {
    const miner = manifest.minerFerrets[0];
    if (miner === undefined) return undefined;
    const summary = await this.deps.ferrets.get(miner as FerretId);
    if (summary === undefined) return undefined;
    const root = this.deps.roots.root('work', { ferret: summary.id });
    const fenced = root.resolve(minerOutputPath(summary.folder, run));
    if (!fenced.ok || (await root.stat(fenced.value).catch(() => undefined)) === undefined) return undefined;
    const text = await root.readText(fenced.value);
    await root.remove(fenced.value);
    return text;
  }

  /** Folds one run's miner output into the board, once. Answers the manifest as it now stands. */
  private async ingestRun(name: string): Promise<RunManifest | undefined> {
    const { store, now } = this.deps;
    const manifest = await store.readRunManifest(name);
    if (manifest === undefined || manifest.finishedAt !== undefined) return manifest;
    const [digests, outputText] = await Promise.all([store.readDigests(name), this.takeOutput(manifest, name)]);
    if (digests === undefined || outputText === undefined) return manifest;
    try {
      const output = parseMinerOutput(JSON.parse(outputText));
      if (output === undefined) throw new Error('invalid miner output');
      const result = applyMinerOutput(
        await store.loadProposals(),
        await store.loadTombstones(),
        output,
        new Map(digests.map(digest => [digest.ferretId, digest as SessionDigest])),
        await store.observationsById(),
        name,
        now(),
      );
      await store.appendObservations(result.observations);
      await store.saveProposals(result.proposals);
      const finished = { ...manifest, ...result.stats, finishedAt: now() };
      await store.writeRunManifest(finished);
      return finished;
    } catch {
      const quarantined = {
        ...manifest,
        malformedFiles: 1,
        finishedAt: now(),
        message: 'miner output was not valid JSON — quarantined',
      };
      await store.writeRunManifest(quarantined);
      return quarantined;
    }
  }

  // ── Scan: explicit, estimated, one miner per batch (`ScanMinerPort`) ─────────────────────────────

  /** One batch's run name: the scan's id and the batch's index. */
  private static batchRun(runId: string, batch: number): string {
    return `${runId}-b${String(batch)}`;
  }

  /** The digest a miner would read for one ferret, or `undefined` when there is nothing to mine. */
  private async digestOf(ferretId: string): Promise<SessionDigest | undefined> {
    const ferret = await this.deps.ferrets.get(ferretId as FerretId);
    if (ferret === undefined || ferret.name === LESSONS_MINER_NAME) return undefined;
    const input = await this.input(ferret);
    if (input === undefined) return undefined;
    const digest = extractSession(input);
    return digest.hasSignal ? digest : undefined;
  }

  async digestCharacters(ferretId: string): Promise<number | undefined> {
    return (await this.digestOf(ferretId))?.digest.length;
  }

  /** Starts one miner over the ferrets of a batch that have something to mine. */
  async start(
    runId: string,
    batch: number,
    ferretIds: readonly string[],
    agent: string,
    _model: string | undefined,
  ): Promise<string | undefined> {
    const digests = (await Promise.all(ferretIds.map(async id => await this.digestOf(id)))).filter(
      (digest): digest is SessionDigest => digest !== undefined,
    );
    if (digests.length === 0) return undefined;
    const name = LessonsMiner.batchRun(runId, batch);
    const near = (await this.deps.ferrets.list()).filter(ferret => ferretIds.includes(ferret.id));
    const miner = await this.launch(name, digests, agent, near);
    await this.deps.store.writeRunManifest({
      ...this.emptyManifest(undefined, ferretIds.length),
      runId: name,
      ferretsWithSignal: digests.length,
      minerFerrets: [miner],
    });
    return miner;
  }

  /**
   * A batch's outcome: its stats once its output is folded in, `pending` while its miner still runs, `failed` when the
   * output was unusable or the miner ended without writing any.
   */
  async collect(
    runId: string,
    batch: number,
  ): Promise<{ readonly added: number; readonly merged: number } | 'pending' | 'failed'> {
    const name = LessonsMiner.batchRun(runId, batch);
    const manifest = await this.ingestRun(name);
    if (manifest === undefined) return 'failed';
    if (manifest.finishedAt !== undefined) {
      return manifest.malformedFiles > 0
        ? 'failed'
        : { added: manifest.proposalsCreated, merged: manifest.proposalsStrengthened };
    }
    const miner = manifest.minerFerrets[0];
    const summary = miner === undefined ? undefined : await this.deps.ferrets.get(miner as FerretId);
    if (summary !== undefined && summary.state !== 'stopped') return 'pending';
    await this.deps.store.writeRunManifest({
      ...manifest,
      finishedAt: this.deps.now(),
      malformedFiles: 1,
      message: 'the miner ended without writing its output',
    });
    return 'failed';
  }

  async stop(minerFerretId: string): Promise<void> {
    await this.deps.ferrets.stop(minerFerretId as FerretId, 'polite');
  }

  private prompt(batch: readonly SessionDigest[], outputPath: string): string {
    return [
      'You are a Ferretry lesson miner. Extract durable lessons about how the owner wants work done: their corrections, preferences, and recurring tooling failures.',
      'Every quote MUST be copied verbatim from the ferrets below (300 chars max); unverified quotes are discarded. Lessons are suggestions only: the owner reviews each one, and nothing is applied automatically.',
      `Write JSON with observations and proposals to exactly: ${outputPath}`,
      'Use observation kinds correction, roadblock, preference, recurring_task, or tooling_failure. Give each proposal a "scope": "repo" when it is about the project its evidence came from, "global" when every ferret should follow it. If there is no lesson, write {"observations":[],"proposals":[]}.',
      ...batch.map(digest => `\n### ${digest.ferretId}\n${digest.digest}`),
    ].join('\n\n');
  }
}
