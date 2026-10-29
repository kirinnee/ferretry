import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  isOwnerMessage,
  type TranscriptEvent,
  type TranscriptHarness,
  type PacedTranscriptParser,
} from '../transcript/index.ts';
import { spokenText } from './conversation-text.ts';

/** A filesystem entry deliberately narrowed to what read-only discovery needs. */
export interface ForeignHistoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'other';
}

/**
 * The importer has no write primitive.  Keeping its port read-only makes modifying a person's
 * harness home impossible by construction, rather than a convention a future implementation can
 * accidentally break.
 */
export interface ForeignHistoryFiles {
  entries(directory: string): Promise<readonly ForeignHistoryEntry[]>;
  /** A regular file's size in bytes, or `undefined` when it is not one. */
  size(file: string): Promise<number | undefined>;
  text(file: string): Promise<string | undefined>;
}

/**
 * The largest transcript this index reads. Every listing reads every file whole — it reports how many
 * events each holds and refuses a damaged one — so a file past this is skipped, and says so, rather
 * than held in memory whole: transcripts grow without limit, and one adopted conversation was 200 MB.
 */
export const FOREIGN_HISTORY_READ_MAX_BYTES = 32 * 1024 * 1024;

export interface ForeignHistoryRoots {
  readonly claudeProjects: string;
  readonly codexSessions: string;
}

export interface ImportedConversation {
  /** Opaque, daemon-local route key. It is not a harness session id and cannot be resumed. */
  readonly id: string;
  readonly harness: TranscriptHarness;
  readonly title: string;
  readonly source: string;
  readonly eventCount: number;
  readonly startedAt?: string;
  readonly readOnly: true;
}

export interface SkippedForeignTranscript {
  readonly harness: TranscriptHarness;
  readonly source: string;
  readonly reason: string;
}

export interface ForeignHistoryListing {
  readonly conversations: readonly ImportedConversation[];
  readonly skipped: readonly SkippedForeignTranscript[];
}

export interface ImportedConversationDetail extends ImportedConversation {
  readonly events: readonly TranscriptEvent[];
}

interface Candidate {
  readonly harness: TranscriptHarness;
  readonly source: string;
}

function idFor(harness: TranscriptHarness, source: string): string {
  return createHash('sha256').update(`${harness}\u0000${source}`, 'utf8').digest('base64url');
}

/**
 * A conversation's title: the first thing the owner said in it. A harness's own events, its tagged
 * blocks and an unread hand-off pointer say nothing about the conversation, so the first message that
 * survives `spokenText` names it.
 */
function titleFrom(events: readonly TranscriptEvent[], fallback: string): string {
  const text = events.flatMap(event => (isOwnerMessage(event) ? [spokenText(event.text)] : [])).find(Boolean);
  return text === undefined ? fallback : text.slice(0, 120);
}

function startedAt(events: readonly TranscriptEvent[]): string | undefined {
  return events.find(event => event.timestamp !== undefined)?.timestamp;
}

/**
 * Lists a tree without following links. Harnesses' JSONL layouts are nested by project/date, and
 * following a link would turn a read of a known harness home into an unbounded read elsewhere.
 */
async function jsonlBelow(files: ForeignHistoryFiles, root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of await files.entries(directory)) {
      const child = join(directory, entry.name);
      if (entry.kind === 'directory') pending.push(child);
      else if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) found.push(child);
    }
  }
  return found.sort((left, right) => left.localeCompare(right));
}

/**
 * Read-only index over a person's pre-Ferretry Claude/Codex homes.
 *
 * Nothing is copied or persisted: the source stays authoritative, which avoids making a stale copy
 * look resumable and ensures this daemon never touches another daemon's state. Each request builds
 * a fresh index, so a repaired harness file is visible without a background writer.
 */
export class ForeignHistoryImporter {
  constructor(
    private readonly files: ForeignHistoryFiles,
    private readonly roots: ForeignHistoryRoots,
    /** Paced, because a listing parses every file up to 32 MiB whole and would hold the loop through each. */
    private readonly parsers: Readonly<Record<TranscriptHarness, PacedTranscriptParser>>,
  ) {}

  async list(): Promise<ForeignHistoryListing> {
    const candidates: Candidate[] = [
      ...(await jsonlBelow(this.files, this.roots.claudeProjects)).map(source => ({
        harness: 'claude' as const,
        source,
      })),
      ...(await jsonlBelow(this.files, this.roots.codexSessions)).map(source => ({
        harness: 'codex' as const,
        source,
      })),
    ];
    const conversations: ImportedConversation[] = [];
    const skipped: SkippedForeignTranscript[] = [];
    for (const candidate of candidates) {
      const detail = await this.readCandidate(candidate);
      if ('reason' in detail) skipped.push({ ...candidate, reason: detail.reason });
      else conversations.push(detail.conversation);
    }
    return { conversations, skipped };
  }

  async get(id: string): Promise<ImportedConversationDetail | undefined> {
    const candidates: Candidate[] = [
      ...(await jsonlBelow(this.files, this.roots.claudeProjects)).map(source => ({
        harness: 'claude' as const,
        source,
      })),
      ...(await jsonlBelow(this.files, this.roots.codexSessions)).map(source => ({
        harness: 'codex' as const,
        source,
      })),
    ];
    const candidate = candidates.find(item => idFor(item.harness, item.source) === id);
    if (candidate === undefined) return undefined;
    const detail = await this.readCandidate(candidate);
    return 'reason' in detail ? undefined : { ...detail.conversation, events: detail.events };
  }

  private async readCandidate(
    candidate: Candidate,
  ): Promise<
    | { readonly conversation: ImportedConversation; readonly events: readonly TranscriptEvent[] }
    | { readonly reason: string }
  > {
    const size = await this.files.size(candidate.source);
    if (size !== undefined && size > FOREIGN_HISTORY_READ_MAX_BYTES)
      return {
        reason: `the transcript is ${String(Math.ceil(size / (1024 * 1024)))} MB, more than the ${String(FOREIGN_HISTORY_READ_MAX_BYTES / (1024 * 1024))} MB a history listing reads`,
      };
    const text = size === undefined ? undefined : await this.files.text(candidate.source);
    if (text === undefined) return { reason: 'the transcript could not be read' };
    const parsed = await this.parsers[candidate.harness].parse({ text, source: candidate.source, endOfInput: true });
    // An invalid/partial transcript is lost history, never a shorter conversation. The list reports
    // every skipped source rather than silently showing a plausible but incomplete subset.
    if (parsed.issues.length > 0 || parsed.remainder.length > 0) {
      return {
        reason:
          parsed.issues.length > 0
            ? parsed.issues.map(issue => issue.code).join(', ')
            : 'the transcript ends with an incomplete record',
      };
    }
    const events = parsed.events;
    if (!events.some(event => event.kind === 'message'))
      return { reason: 'the transcript contains no renderable messages' };
    const conversation: ImportedConversation = {
      id: idFor(candidate.harness, candidate.source),
      harness: candidate.harness,
      title: titleFrom(events, basename(candidate.source)),
      source: candidate.source,
      eventCount: events.length,
      ...(startedAt(events) === undefined ? {} : { startedAt: startedAt(events) }),
      readOnly: true,
    };
    return { conversation, events };
  }
}
