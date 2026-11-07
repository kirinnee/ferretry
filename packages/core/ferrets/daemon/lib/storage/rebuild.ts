import { type JsonValue, jsonObject } from '@ferretry/std';
import { InstantSchema } from '../protocol/common.ts';
import type { SessionId } from '../session-id.ts';
import type {
  EventPointer,
  IndexedSession,
  JournalFingerprint,
  JournalProblem,
  RebuildPlan,
} from '../storage-types.ts';
import type { JournalScan } from './journal.ts';

/**
 * One session document as the state port read it: its value, or why it could not be used.
 *
 * Today's `TextSource`; the state port parses the document and checks its format, so what reaches the plan is the
 * value or the damage sentence, never text.
 */
export interface DocumentSource {
  readonly file: string;
  readonly value?: JsonValue;
  readonly problem?: string;
}

export interface JournalSource {
  readonly file: string;
  readonly scan: Pick<JournalScan, 'pointers' | 'problems' | 'scannedTo' | 'lastSequence'> & {
    /** One-based source line at `scannedTo`, retained for suffix-only reconciliation. */
    readonly lineAtOffset: number;
  };
  readonly fingerprint: JournalFingerprint;
}

export interface SessionSource {
  readonly id: SessionId;
  readonly config?: DocumentSource;
  readonly state?: DocumentSource;
  readonly journal?: JournalSource;
}

function parsedDocument(source: DocumentSource | undefined, problems: JournalProblem[]): JsonValue | undefined {
  if (source === undefined) return undefined;
  if (source.problem === undefined) return source.value;
  problems.push({ file: source.file, line: 1, byteOffset: 0, message: source.problem });
  return undefined;
}

function stringField(value: JsonValue | undefined, field: string): string | undefined {
  const candidate = jsonObject(value)?.[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function instantField(
  value: JsonValue | undefined,
  field: string,
  source: DocumentSource | undefined,
  problems: JournalProblem[],
): string | undefined {
  const candidate = stringField(value, field);
  if (candidate === undefined) return undefined;
  const parsed = InstantSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  if (source !== undefined) {
    problems.push({ file: source.file, line: 1, byteOffset: 0, message: `${field} must be an ISO 8601 instant` });
  }
  return undefined;
}

export function planIndexRebuild(sources: readonly SessionSource[]): RebuildPlan {
  const sessions: IndexedSession[] = [];
  const events: EventPointer[] = [];
  const problems: JournalProblem[] = [];
  const seen = new Set<string>();

  for (const source of [...sources].sort((left, right) => left.id.localeCompare(right.id))) {
    if (seen.has(source.id)) {
      problems.push({ file: source.id, line: 1, byteOffset: 0, message: `duplicate session ${source.id}` });
      continue;
    }
    seen.add(source.id);

    const config = parsedDocument(source.config, problems);
    const state = parsedDocument(source.state, problems);
    const scan = source.journal?.scan;
    if (scan) {
      events.push(...scan.pointers);
      problems.push(...scan.problems);
    }
    const createdAt =
      instantField(config, 'createdAt', source.config, problems) ??
      instantField(state, 'startedAt', source.state, problems);
    const updatedAt =
      instantField(config, 'updatedAt', source.config, problems) ??
      instantField(state, 'finishedAt', source.state, problems) ??
      instantField(state, 'lastActivityAt', source.state, problems) ??
      createdAt;
    sessions.push({
      id: source.id,
      status: stringField(state, 'status'),
      createdAt,
      updatedAt,
      lastSequence: scan?.lastSequence ?? 0,
      journalLine: scan?.lineAtOffset ?? 1,
      journal: source.journal?.fingerprint ?? null,
    });
  }

  return { sessions, events, problems };
}
