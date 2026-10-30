import { join } from 'node:path';
import type { LearningConfig, RunManifest, SessionView, StartSessionRequest } from '@ferretry/protocol';
import { z } from 'zod';
import {
  applyMinerOutput,
  extractSession,
  type InboxSendLike,
  type LearningStorePort,
  type NormalizedRecordLike,
  parseJsonl,
  parseMinerOutput,
  type RawSessionInput,
  type SessionDigest,
} from '../../lib/learning/index.ts';
import type { FoundationPaths } from '../../lib/paths.ts';
import type { FileSystemPort } from '../../lib/ports.ts';
import type { SessionControlSubsystem } from '../../lib/runtime/mounts/session-control.ts';
import type { SessionDirectorySubsystem } from '../../lib/runtime/mounts/sessions.ts';
import type { SessionTranscriptReader } from '../../lib/session/transcript/reader.ts';
import { isOwnerMessage } from '../../lib/transcript/owner.ts';
import type { TranscriptEvent } from '../../lib/transcript/types.ts';

/**
 * A transcript event in the shape the extractor reads. The reader answers typed events (`kind`, `role`);
 * the extractor predates them and reads `chat.user` and `tool.result` records, so without this the
 * owner's own messages never reached a miner.
 */
export function normalizedRecord(event: TranscriptEvent): NormalizedRecordLike {
  const timestamp = event.timestamp === undefined ? {} : { timestamp: event.timestamp };
  if (isOwnerMessage(event)) return { type: 'chat.user', ...timestamp, data: { text: event.text } };
  if (event.kind === 'tool-result')
    return { type: 'tool.result', ...timestamp, data: { isError: event.result.isError } };
  return { type: event.kind, ...timestamp };
}

/** Label on miner sessions.  It is a correctness boundary: a miner must never mine itself. */
export const LEARNING_MINER_LABEL = 'ferretry-learning';

const TERMINAL = new Set(['completed', 'failed', 'stalled', 'stopped']);
const RECORD_CAP = 1_200;

/** The one field the miner reads from a session event; every other field passes through unread. */
const EventTypeSchema = z.object({ type: z.string().optional() });

/** The inbox fields a human message may carry; a line of another shape is not a message. */
const InboxEntrySchema = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  text: z.string().optional(),
  from: z.string().optional(),
  fromName: z.string().optional(),
  at: z.string().optional(),
});

/**
 * The IO orchestration around the pure extractor and aggregator.
 *
 * The daemon supplies sessions from its one opened state home, so this class can never scan a
 * different daemon.  A session without an exact, resolved transcript is skipped rather than mined
 * from turn files and inbox alone: those are useful context, not a substitute for provenance.
 */
export class LearningMiner {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
    private readonly store: LearningStorePort,
    private readonly sessions: SessionDirectorySubsystem,
    private readonly transcripts: SessionTranscriptReader,
    private readonly sessionControl: SessionControlSubsystem,
    private readonly config: () => LearningConfig,
    private readonly now: () => string,
  ) {}

  async run(spawn: boolean): Promise<RunManifest> {
    await this.ingest();
    if (!spawn)
      return (await this.store.latestRunManifest()) ?? this.emptyManifest('ingest-only run (no spawn requested)');

    const state = await this.store.loadState();
    const watermark = `${state.watermarkAt ?? ''} ${state.watermarkId ?? ''}`;
    const candidates = (await this.sessions.list())
      .filter(session => TERMINAL.has(session.state.status) && session.config.label !== LEARNING_MINER_LABEL)
      .filter(session => `${session.state.finishedAt ?? ''} ${session.config.id}` > watermark)
      .toSorted((left, right) =>
        `${left.state.finishedAt ?? ''} ${left.config.id}`.localeCompare(
          `${right.state.finishedAt ?? ''} ${right.config.id}`,
        ),
      )
      .slice(0, this.config().maxSessionsPerRun);
    const manifest = this.emptyManifest(undefined, candidates.length);
    if (candidates.length === 0) {
      const complete = { ...manifest, finishedAt: this.now(), message: 'no new terminal sessions to scan' };
      await this.store.writeRunManifest(complete);
      return complete;
    }

    const skipped: string[] = [];
    const digests: SessionDigest[] = [];
    for (const session of candidates) {
      const input = await this.input(session);
      if (input === undefined) {
        skipped.push(session.config.id);
        continue;
      }
      const digest = extractSession(input);
      if (digest.hasSignal) digests.push(digest);
    }
    const newest = candidates.at(-1)!;
    await this.store.saveState({
      ...state,
      watermarkAt: newest.state.finishedAt,
      watermarkId: newest.config.id,
      lastRunAt: this.now(),
      lastRunId: manifest.runId,
      ...(spawn ? { lastSpawnAt: this.now() } : {}),
    });
    if (digests.length === 0) {
      const complete = {
        ...manifest,
        finishedAt: this.now(),
        message:
          skipped.length === 0
            ? 'no human signal in the scanned batch'
            : `skipped ${skipped.length} session(s) with missing or unresolved transcript provenance; no complete conversations to mine`,
      };
      await this.store.writeRunManifest(complete);
      return complete;
    }

    const batch = digests.slice(0, this.config().batchSize);
    await this.writeDigests(manifest.runId, batch);
    const request: StartSessionRequest = {
      agent: this.config().agent,
      mode: 'auto',
      prompt: this.prompt(batch, this.outputPath(manifest.runId)),
      label: LEARNING_MINER_LABEL,
      name: 'Learning Miner',
      cwd: this.paths.home,
      ...(this.config().model === undefined ? {} : { model: this.config().model }),
    };
    const payload = JSON.stringify(request);
    const miner = await this.sessionControl.start(request, `learning:${manifest.runId}`, payload);
    const pending = {
      ...manifest,
      sessionsWithSignal: batch.length,
      minerSessions: [miner.config.id],
      ...(skipped.length === 0
        ? {}
        : { message: `skipped ${skipped.length} session(s) with missing or unresolved transcript provenance` }),
    };
    await this.store.writeRunManifest(pending);
    return pending;
  }

  private emptyManifest(message?: string, sessionsScanned = 0): RunManifest {
    return {
      runId: this.now().replace(/[:.]/g, '-'),
      startedAt: this.now(),
      sessionsScanned,
      sessionsWithSignal: 0,
      minerSessions: [],
      observationsProposed: 0,
      observationsVerified: 0,
      rejectedQuotes: 0,
      malformedFiles: 0,
      proposalsCreated: 0,
      proposalsStrengthened: 0,
      proposalsSuppressedByTombstone: 0,
      perHarness: { claude: 0, codex: 0 },
      ...(message === undefined ? {} : { message }),
    };
  }

  private runDirectory(runId: string): string {
    return join(this.paths.state, 'learning', 'runs', runId);
  }
  private outputPath(runId: string): string {
    return join(this.runDirectory(runId), 'observations.json');
  }
  private async writeDigests(runId: string, digests: readonly SessionDigest[]): Promise<void> {
    const directory = this.runDirectory(runId);
    await this.files.ensureDirectory(directory, 0o700);
    await this.files.writeTextAtomic(join(directory, 'digests.json'), `${JSON.stringify(digests, null, 2)}\n`);
  }

  private async input(session: SessionView): Promise<RawSessionInput | undefined> {
    // An undiscovered Codex transcript and an absent record are both absence of evidence, not an
    // empty conversation.  Do not let a miner quote a partial inbox under either condition.
    if (session.config.transcript?.file === undefined) return undefined;
    const records = await this.transcripts.tail(
      { sessionId: session.config.id, harness: session.config.harness },
      RECORD_CAP,
    );
    const turnTexts = await this.turnTexts(session.directory);
    const inbox = this.inbox(await this.files.readText(join(session.directory, 'channel', 'inbox.jsonl')));
    const events = parseJsonl(
      (await this.files.readText(join(session.directory, 'events.jsonl'))) ?? '',
      EventTypeSchema,
    );
    return {
      sessionId: session.config.id,
      ...(session.config.teammate === undefined ? {} : { teammate: session.config.teammate }),
      mode: session.config.mode,
      cwd: session.config.cwd,
      repo: session.config.cwd,
      harness: session.config.harness,
      status: session.state.status,
      ...(session.state.finishedAt === undefined ? {} : { finishedAt: session.state.finishedAt }),
      records: records.map(normalizedRecord),
      turnTexts,
      inbox,
      interrupts: events.filter(event => event.type === 'control.interrupted').length,
    };
  }

  private async turnTexts(directory: string): Promise<readonly string[]> {
    const turns = await this.files.listDirectory(join(directory, 'turns'));
    const names = turns
      .filter(entry => !entry.directory && /^turn-\d+\.md$/u.test(entry.name))
      .map(entry => entry.name)
      .toSorted();
    const texts = await Promise.all(names.map(async name => await this.files.readText(join(directory, 'turns', name))));
    return texts.filter((text): text is string => text !== undefined && text.trim() !== '');
  }

  private inbox(text: string | undefined): readonly InboxSendLike[] {
    return parseJsonl(text ?? '', InboxEntrySchema)
      .filter(entry => entry.type === undefined || entry.type === 'message')
      .map(entry => ({
        text: entry.message ?? entry.text ?? '',
        ...(entry.from === undefined ? {} : { from: entry.from }),
        ...(entry.fromName === undefined ? {} : { fromName: entry.fromName }),
        ...(entry.at === undefined ? {} : { at: entry.at }),
      }))
      .filter(entry => entry.text.trim() !== '');
  }

  private async ingest(): Promise<void> {
    const root = join(this.paths.state, 'learning', 'runs');
    for (const entry of await this.files.listDirectory(root)) {
      if (entry.directory) await this.ingestRun(entry.name);
    }
  }

  /** Folds one run's miner output into the board, once. Answers the manifest as it now stands. */
  private async ingestRun(name: string): Promise<RunManifest | undefined> {
    const directory = this.runDirectory(name);
    const manifest = await this.store.readRunManifest(name);
    if (manifest === undefined || manifest.finishedAt !== undefined) return manifest;
    const [digestsText, outputText] = await Promise.all([
      this.files.readText(join(directory, 'digests.json')),
      this.files.readText(join(directory, 'observations.json')),
    ]);
    if (digestsText === undefined || outputText === undefined) return manifest;
    try {
      const digests = JSON.parse(digestsText) as SessionDigest[];
      const output = parseMinerOutput(JSON.parse(outputText));
      if (!Array.isArray(digests) || output === undefined) throw new Error('invalid miner output');
      const result = applyMinerOutput(
        await this.store.loadProposals(),
        await this.store.loadTombstones(),
        output,
        new Map(digests.map(digest => [digest.sessionId, digest])),
        await this.store.observationsById(),
        name,
        this.now(),
      );
      await this.store.appendObservations(result.observations);
      await this.store.saveProposals(result.proposals);
      const finished = { ...manifest, ...result.stats, finishedAt: this.now() };
      await this.store.writeRunManifest(finished);
      return finished;
    } catch {
      const quarantined = {
        ...manifest,
        malformedFiles: 1,
        finishedAt: this.now(),
        message: 'miner output was not valid JSON — quarantined',
      };
      await this.store.writeRunManifest(quarantined);
      await this.files.removeFile(join(directory, 'observations.json'));
      return quarantined;
    }
  }

  // ── Scan: explicit, estimated, one miner per batch (`ScanMinerPort`) ─────────────────────────────

  /** One batch's run directory name: the scan's id and the batch's index. */
  private static batchRun(runId: string, batch: number): string {
    return `${runId}-b${String(batch)}`;
  }

  /** The digest a miner would read for one ferret, or `undefined` when there is nothing to mine. */
  private async digestOf(sessionId: string): Promise<SessionDigest | undefined> {
    const session = await this.sessions.get(sessionId);
    if (session === undefined || session.config.label === LEARNING_MINER_LABEL) return undefined;
    const input = await this.input(session);
    if (input === undefined) return undefined;
    const digest = extractSession(input);
    return digest.hasSignal ? digest : undefined;
  }

  async digestCharacters(sessionId: string): Promise<number | undefined> {
    return (await this.digestOf(sessionId))?.digest.length;
  }

  /** Starts one miner over the ferrets of a batch that have something to mine. */
  async start(
    runId: string,
    batch: number,
    sessionIds: readonly string[],
    agent: string,
    model: string | undefined,
  ): Promise<string | undefined> {
    const digests = (await Promise.all(sessionIds.map(async id => await this.digestOf(id)))).filter(
      (digest): digest is SessionDigest => digest !== undefined,
    );
    if (digests.length === 0) return undefined;
    const name = LearningMiner.batchRun(runId, batch);
    await this.writeDigests(name, digests);
    const request: StartSessionRequest = {
      agent,
      mode: 'auto',
      prompt: this.prompt(digests, this.outputPath(name)),
      label: LEARNING_MINER_LABEL,
      name: 'Lesson Scan',
      cwd: this.paths.home,
      ...(model === undefined ? {} : { model }),
    };
    const miner = await this.sessionControl.start(request, `learning:${name}`, JSON.stringify(request));
    await this.store.writeRunManifest({
      ...this.emptyManifest(undefined, sessionIds.length),
      runId: name,
      sessionsWithSignal: digests.length,
      minerSessions: [miner.config.id],
    });
    return miner.config.id;
  }

  /**
   * A batch's outcome: its stats once its output is folded in, `pending` while its miner still runs,
   * `failed` when the output was unusable or the miner ended without writing any.
   */
  async collect(
    runId: string,
    batch: number,
  ): Promise<{ readonly added: number; readonly merged: number } | 'pending' | 'failed'> {
    const name = LearningMiner.batchRun(runId, batch);
    const manifest = await this.ingestRun(name);
    if (manifest === undefined) return 'failed';
    if (manifest.finishedAt !== undefined) {
      return manifest.malformedFiles > 0
        ? 'failed'
        : { added: manifest.proposalsCreated, merged: manifest.proposalsStrengthened };
    }
    const miner = manifest.minerSessions[0];
    const session = miner === undefined ? undefined : await this.sessions.get(miner);
    if (session !== undefined && !TERMINAL.has(session.state.status)) return 'pending';
    await this.store.writeRunManifest({
      ...manifest,
      finishedAt: this.now(),
      malformedFiles: 1,
      message: 'the miner ended without writing its output',
    });
    return 'failed';
  }

  async stop(minerSessionId: string): Promise<void> {
    await this.sessionControl.stop(minerSessionId, 'lesson scan cancelled by the owner');
  }

  private prompt(batch: readonly SessionDigest[], outputPath: string): string {
    return [
      'You are a Ferretry lesson miner. Extract durable lessons about how the owner wants work done: their corrections, preferences, and recurring tooling failures.',
      'Every quote MUST be copied verbatim from the sessions below (300 chars max); unverified quotes are discarded. Lessons are suggestions only: the owner reviews each one, and nothing is applied automatically.',
      `Write JSON with observations and proposals to exactly: ${outputPath}`,
      'Use observation kinds correction, roadblock, preference, recurring_task, or tooling_failure. Give each proposal a "scope": "repo" when it is about the project its evidence came from, "global" when every ferret should follow it. If there is no lesson, write {"observations":[],"proposals":[]}.',
      ...batch.map(digest => `\n### ${digest.sessionId}\n${digest.digest}`),
    ].join('\n\n');
  }
}
