import { stat } from 'node:fs/promises';
import type { AnalyticsTranscriptEvidence } from '../../lib/analytics/usage-fold.ts';
import type { TranscriptHarness, TranscriptSource } from '../../lib/transcript/types.ts';
import { DEFAULT_MAX_READ_BYTES } from '../transcript/file-source.ts';

/**
 * A finished session's whole transcript, read once, as the evidence the analytics fold consumes.
 *
 * ONE READ, shared by the event loop's evidence source and the analytics worker, so where a transcript
 * is read can never change what the fold is given. It reports how the read ENDED — the issues raised and
 * the bytes still pending — so the fold can refuse a total it cannot prove complete instead of returning
 * a smaller number that looks like a cheaper session.
 *
 * A transcript longer than one bounded read can never be proven complete, so reading — and parsing — its
 * first 32 MiB only to refuse it was pure cost: on a Mac with three 200 MB transcripts it was seconds of a
 * blocked loop every pass and every boot. It is refused unread, with the bytes it could not account for,
 * which is the refusal the read itself would have made.
 */
export async function readAnalyticsTranscriptEvidence(
  source: TranscriptSource,
  file: string,
  sessionId: string,
  harness: TranscriptHarness,
): Promise<AnalyticsTranscriptEvidence> {
  const size = await stat(file).then(
    info => info.size,
    () => undefined,
  );
  if (size !== undefined && size > DEFAULT_MAX_READ_BYTES)
    return { kind: 'read', harness, events: [], issues: ['source-truncated'], pendingBytes: size };
  const batch = await source.read(file, { sessionId }).catch(() => undefined);
  if (batch === undefined) return { kind: 'unreadable' };
  return {
    kind: 'read',
    harness,
    events: batch.events,
    issues: batch.issues.map(issue => issue.code),
    pendingBytes: batch.cursor.pendingBytes,
  };
}
