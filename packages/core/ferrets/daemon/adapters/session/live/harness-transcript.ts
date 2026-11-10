import type {
  FerretId,
  Harness,
  HarnessKey,
  HarnessTailRecord,
  HarnessTranscriptStamp,
} from '../../../../contract/index.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { SessionTranscriptTail, TranscriptTailResult } from '../../../lib/session/peers/reads.ts';
import type { TranscriptEvent, TranscriptHarness } from '../../../lib/session/peers/transcript.ts';
import type { LiveActivityReads } from './storage-live-activity.ts';

/** The harness behind a ferret, or `undefined` when none answers for it (the registry and the hook decide). */
export type HarnessOf = (ferret: FerretId) => Harness | undefined;

const harnessName = (key: HarnessKey): TranscriptHarness => (key === 'codex' ? 'codex' : 'claude');

/**
 * One tail record as the normalized event the turn fold and the live readout read. A record carries no text (the
 * contract's `HarnessTailRecord` has none), so every text field here is empty: nothing a harness wrote can reach a frame
 * through this mapping, and the only sentence is a usage-limit `notice`, which the harness masked and bounded.
 */
export function eventOfRecord(harness: TranscriptHarness, record: HarnessTailRecord): TranscriptEvent {
  const base = { harness, ...(record.at === undefined ? {} : { timestamp: record.at }) };
  switch (record.kind) {
    case 'message':
      return {
        ...base,
        kind: 'message',
        role: record.role,
        text: '',
        ...(record.inputSource === undefined ? {} : { inputSource: record.inputSource }),
      };
    case 'work':
      return { ...base, kind: 'reasoning', role: 'assistant', text: '', format: 'thinking' };
    case 'turn':
      return { ...base, kind: 'turn', role: 'system', state: record.state };
    case 'usage':
      return {
        ...base,
        kind: 'usage',
        role: 'system',
        ...(record.call === undefined ? {} : { messageId: record.call }),
        usage: {
          ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }),
          ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens }),
          ...(record.cachedInputTokens === undefined ? {} : { cachedInputTokens: record.cachedInputTokens }),
          ...(record.cacheCreationInputTokens === undefined
            ? {}
            : { cacheCreationInputTokens: record.cacheCreationInputTokens }),
          ...(record.contextTokens === undefined ? {} : { contextTokens: record.contextTokens }),
        },
      };
    case 'compaction':
      return {
        ...base,
        kind: 'compaction',
        role: 'system',
        ...(record.trigger === undefined ? {} : { trigger: record.trigger }),
        ...(record.tokensBefore === undefined ? {} : { tokensBefore: record.tokensBefore }),
        ...(record.tokensAfter === undefined ? {} : { tokensAfter: record.tokensAfter }),
      };
    case 'error':
      return {
        ...base,
        kind: 'error',
        role: 'system',
        error: {
          message: record.notice ?? '',
          ...(record.code === undefined ? {} : { code: record.code }),
          recoverable: false,
        },
      };
  }
}

/** What one read of a ferret's tail answered, and the stamp of the file it was read from. */
interface CachedTail {
  readonly file: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** The `limit` the read asked for: a later ask for no more than this is answered from it. */
  readonly limit: number;
  readonly events: readonly TranscriptEvent[];
}

/**
 * A ferret's transcript as the harness that wrote it offers it (U5): the proof of WHICH file is the ferret's is the
 * harness's, so Ferrets neither names nor opens a transcript path. It asks `Harness.transcriptStamp` (one stamp) and
 * `Harness.transcriptTail` (records without text); a harness that offers neither proves no transcript, and the turn is
 * decided from the pane alone.
 *
 * The tail is cached by the file's stamp, one entry per ferret (dropped by {@link forget}): the turn watch asks for it on
 * every look and the live source on every sample, and a transcript that has not moved is neither read nor parsed again,
 * as today's daemon-wide tail cache did. A moved stamp, a larger window asked for, or a harness that gives no stamp reads
 * afresh.
 *
 * Both halves of the live readout and the transcript-change signal read through here: {@link tail} is the
 * `SessionTranscriptTail`, {@link reads} is the transcript half of `LiveActivityReads`.
 */
export class HarnessTranscript {
  /** Which ferret a proved file belongs to, so a later stat of that file asks the right harness. Replaced per ferret. */
  readonly #owners = new Map<string, FerretId>();
  readonly #files = new Map<FerretId, string>();
  /** The stamp the last `transcriptFile` took, kept for the `transcriptStat` that follows it (one stamp per sample). */
  readonly #sampled = new Map<FerretId, HarnessTranscriptStamp>();
  readonly #tails = new Map<FerretId, CachedTail>();

  constructor(
    private readonly harnessOf: HarnessOf,
    /** The harness whose records the ferret's transcript holds. */
    private readonly keyOf: (ferret: FerretId) => HarnessKey | undefined,
  ) {}

  /** The proved transcript's stamp, remembering which ferret owns its file. */
  async stamp(id: SessionId): Promise<HarnessTranscriptStamp | undefined> {
    const ferret = id as unknown as FerretId;
    const stamp = await this.harnessOf(ferret)
      ?.transcriptStamp?.(ferret)
      .catch(() => undefined);
    const known = this.#files.get(ferret);
    if (stamp === undefined) {
      if (known !== undefined) this.#owners.delete(known);
      this.#files.delete(ferret);
      this.#tails.delete(ferret);
      return undefined;
    }
    if (known !== undefined && known !== stamp.file) this.#owners.delete(known);
    this.#files.set(ferret, stamp.file);
    this.#owners.set(stamp.file, ferret);
    return stamp;
  }

  /** Drops what is remembered about a ferret that is gone. */
  forget(ferret: FerretId): void {
    const known = this.#files.get(ferret);
    if (known !== undefined) this.#owners.delete(known);
    this.#files.delete(ferret);
    this.#sampled.delete(ferret);
    this.#tails.delete(ferret);
  }

  readonly tail: SessionTranscriptTail = {
    tail: async (sessionId, limit): Promise<TranscriptTailResult> => {
      const ferret = sessionId as unknown as FerretId;
      const harness = this.harnessOf(ferret);
      const key = this.keyOf(ferret);
      if (harness?.transcriptTail === undefined || key === undefined) return { kind: 'unresolved' };
      const stamp = harness.transcriptStamp === undefined ? undefined : await this.stamp(sessionId as SessionId);
      const cached = this.#tails.get(ferret);
      if (
        stamp !== undefined &&
        cached?.file === stamp.file &&
        cached.size === stamp.size &&
        cached.mtimeMs === stamp.mtimeMs &&
        cached.limit >= limit
      )
        return { kind: 'read', events: cached.events.slice(-limit) };
      const read = await harness.transcriptTail(ferret, limit).catch(() => undefined);
      if (read === undefined) return { kind: 'unreadable' };
      if (read.kind !== 'read') return read;
      const name = harnessName(key);
      const events = read.records.slice(-limit).map(record => eventOfRecord(name, record));
      // Taken BEFORE the read: a file that grew meanwhile is read again at the next look, never served stale.
      if (stamp === undefined) this.#tails.delete(ferret);
      else this.#tails.set(ferret, { file: stamp.file, size: stamp.size, mtimeMs: stamp.mtimeMs, limit, events });
      return { kind: 'read', events };
    },
  };

  readonly reads: Pick<LiveActivityReads, 'transcriptFile' | 'transcriptStat'> = {
    transcriptFile: async id => {
      const stamp = await this.stamp(id);
      const ferret = id as unknown as FerretId;
      if (stamp === undefined) this.#sampled.delete(ferret);
      else this.#sampled.set(ferret, stamp);
      return stamp?.file;
    },
    // The stamp `transcriptFile` just took, used once: a sample costs one stamp, not two.
    transcriptStat: async file => {
      const owner = this.#owners.get(file);
      if (owner === undefined) return undefined;
      const taken = this.#sampled.get(owner);
      this.#sampled.delete(owner);
      const stamp = taken ?? (await this.stamp(owner as unknown as SessionId));
      return stamp?.file === file ? { size: stamp.size, mtimeMs: stamp.mtimeMs } : undefined;
    },
  };
}
