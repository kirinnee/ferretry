import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { TranscriptEvent, TranscriptHarness, TranscriptParser } from '../transcript/index.ts';

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
  text(file: string): Promise<string | undefined>;
}

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

function titleFrom(events: readonly TranscriptEvent[], fallback: string): string {
  const first = events.find(event => event.kind === 'message' && event.role === 'user');
  const text = first?.kind === 'message' ? first.text.trim().replace(/\s+/gu, ' ') : '';
  return text.length === 0 ? fallback : text.slice(0, 120);
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
    private readonly parsers: Readonly<Record<TranscriptHarness, TranscriptParser>>,
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
    const text = await this.files.text(candidate.source);
    if (text === undefined) return { reason: 'the transcript could not be read' };
    const parsed = this.parsers[candidate.harness].parse({ text, source: candidate.source, endOfInput: true });
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
