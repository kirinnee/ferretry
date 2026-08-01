import { join } from 'node:path';
import type { LearningConfig, RunManifest, SessionView, StartSessionRequest } from '@ferretry/protocol';
import {
  applyMinerOutput,
  extractSession,
  parseJsonl,
  type InboxSendLike,
  type LearningStorePort,
  type MinerOutput,
  type NormalizedRecordLike,
  type RawSessionInput,
  type SessionDigest,
} from '../../lib/learning/index.ts';
import type { FoundationPaths } from '../../lib/paths.ts';
import type { FileSystemPort } from '../../lib/ports.ts';
import type { SessionDirectorySubsystem } from '../../lib/runtime/mounts/sessions.ts';
import type { SessionControlSubsystem } from '../../lib/runtime/mounts/session-control.ts';
import type { SessionTranscriptReader } from '../../lib/session/transcript/reader.ts';

/** Label on miner sessions.  It is a correctness boundary: a miner must never mine itself. */
export const LEARNING_MINER_LABEL = 'ferretry-learning';

const TERMINAL = new Set(['completed', 'failed', 'stalled', 'stopped']);
const RECORD_CAP = 1_200;

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
      boardAccess: 'none',
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
    const events = parseJsonl<{ type?: string }>(
      (await this.files.readText(join(session.directory, 'events.jsonl'))) ?? '',
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
      records: records as readonly NormalizedRecordLike[],
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
    return parseJsonl<{
      type?: string;
      message?: string;
      text?: string;
      from?: string;
      fromName?: string;
      at?: string;
    }>(text ?? '')
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
      if (!entry.directory) continue;
      const manifest = await this.store.readRunManifest(entry.name);
      if (manifest === undefined || manifest.finishedAt !== undefined) continue;
      const [digestsText, outputText] = await Promise.all([
        this.files.readText(join(root, entry.name, 'digests.json')),
        this.files.readText(join(root, entry.name, 'observations.json')),
      ]);
      if (digestsText === undefined || outputText === undefined) continue;
      try {
        const digests = JSON.parse(digestsText) as SessionDigest[];
        const output = JSON.parse(outputText) as MinerOutput;
        if (!Array.isArray(digests) || typeof output !== 'object' || output === null)
          throw new Error('invalid miner output');
        const result = applyMinerOutput(
          await this.store.loadProposals(),
          await this.store.loadTombstones(),
          output,
          new Map(digests.map(digest => [digest.sessionId, digest])),
          await this.store.observationsById(),
          entry.name,
          this.now(),
        );
        await this.store.appendObservations(result.observations);
        await this.store.saveProposals(result.proposals);
        await this.store.writeRunManifest({ ...manifest, ...result.stats, finishedAt: this.now() });
      } catch {
        await this.store.writeRunManifest({
          ...manifest,
          malformedFiles: 1,
          finishedAt: this.now(),
          message: 'miner output was not valid JSON — quarantined',
        });
        await this.files.removeFile(join(root, entry.name, 'observations.json'));
      }
    }
  }

  private prompt(batch: readonly SessionDigest[], outputPath: string): string {
    return [
      'You are a Ferretry learning miner. Extract only cross-repository lessons about human preferences, corrections, and recurring tooling failures.',
      'Every quote MUST be copied verbatim from the sessions below (300 chars max); unverified quotes are discarded. Proposals are suggestions only and are never applied automatically.',
      `Write JSON with observations and proposals to exactly: ${outputPath}`,
      'Use observation kinds correction, roadblock, preference, recurring_task, or tooling_failure. If there is no lesson, write {"observations":[],"proposals":[]}.',
      ...batch.map(digest => `\n### ${digest.sessionId}\n${digest.digest}`),
    ].join('\n\n');
  }
}
