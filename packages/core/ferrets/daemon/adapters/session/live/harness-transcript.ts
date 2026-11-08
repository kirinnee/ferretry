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

/**
 * A ferret's transcript as the harness that wrote it offers it (U5): the proof of WHICH file is the ferret's is the
 * harness's, so Ferrets neither names nor opens a transcript path. It asks `Harness.transcriptStamp` (one stat) and
 * `Harness.transcriptTail` (records without text); a harness that offers neither proves no transcript, and the turn is
 * decided from the pane alone.
 *
 * Both halves of the live readout and the transcript-change signal read through here: {@link tail} is the
 * `SessionTranscriptTail`, {@link reads} is the transcript half of `LiveActivityReads`.
 */
export class HarnessTranscript {
  /** Which ferret a proved file belongs to, so a later stat of that file asks the right harness. Replaced per ferret. */
  readonly #owners = new Map<string, FerretId>();
  readonly #files = new Map<FerretId, string>();

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
  }

  readonly tail: SessionTranscriptTail = {
    tail: async (sessionId, limit): Promise<TranscriptTailResult> => {
      const ferret = sessionId as unknown as FerretId;
      const harness = this.harnessOf(ferret);
      const key = this.keyOf(ferret);
      if (harness?.transcriptTail === undefined || key === undefined) return { kind: 'unresolved' };
      const read = await harness.transcriptTail(ferret, limit).catch(() => undefined);
      if (read === undefined) return { kind: 'unreadable' };
      if (read.kind !== 'read') return read;
      const name = harnessName(key);
      return { kind: 'read', events: read.records.slice(-limit).map(record => eventOfRecord(name, record)) };
    },
  };

  readonly reads: Pick<LiveActivityReads, 'transcriptFile' | 'transcriptStat'> = {
    transcriptFile: async id => (await this.stamp(id))?.file,
    transcriptStat: async file => {
      const owner = this.#owners.get(file);
      if (owner === undefined) return undefined;
      const stamp = await this.stamp(owner as unknown as SessionId);
      return stamp?.file === file ? { size: stamp.size, mtimeMs: stamp.mtimeMs } : undefined;
    },
  };
}
