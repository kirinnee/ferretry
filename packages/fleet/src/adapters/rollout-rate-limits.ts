/**
 * The PASSIVE Codex usage reading of design §8.2.3: the newest `token_count` event's `rate_limits` in
 * a rollout. Zero network — Codex already wrote this down on its own last turn.
 *
 * A rollout is one JSON object per line. The event this reads is
 * `{"timestamp": "<ISO>", "type": "event_msg", "payload": {"type": "token_count", "rate_limits":
 * {"primary": {…}, "secondary": {…}}}}` (VERIFIED in codex-rs; the field names are INFERRED from that
 * reading rather than pinned by a run). `primary` is the 5-hour window and `secondary` the weekly one.
 * Recent rollouts are `*.jsonl`; older ones are compressed to `*.jsonl.zst`, which Bun decompresses
 * natively.
 *
 * **Attribution is the caller's, never this file's.** The history pool mixes every credential's
 * rollouts (H1), so a reading belongs to a credential only through Ferretry's own session records: the
 * session that launched a conversation names its runtime, and so its credential. This adapter reads
 * the files it is GIVEN and nothing else; {@link listRollouts} and {@link rolloutConversationId} exist
 * so a caller can pick that set. A rollout Ferretry did not launch is simply never handed in.
 *
 * Nothing here is credential material, and nothing is written.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCodexRateLimits } from '../lib/quota.ts';
import type { PassiveUsageRecord } from '../lib/usage.ts';

/** One rollout file, as a caller chooses among them. */
export interface RolloutFile {
  readonly path: string;
  /** Modification time, epoch milliseconds: the newest file is read first. */
  readonly modifiedAt: number;
  /** The conversation it records, from its file name, when the name carries one. */
  readonly conversationId?: string;
}

const ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/u;

/** The conversation id a rollout's file name carries (`rollout-<time>-<uuid>.jsonl[.zst]`). */
export function rolloutConversationId(name: string): string | undefined {
  return ROLLOUT_NAME.exec(name)?.[1];
}

/** How deep {@link listRollouts} walks: `sessions/<yyyy>/<mm>/<dd>/` is three levels. */
const MAX_DEPTH = 4;

/**
 * Every rollout under one sessions directory, newest first. A directory that is missing or cannot be
 * read contributes nothing: "no rollout" is the honest reading, and usage then reads "unknown".
 */
export async function listRollouts(directory: string): Promise<readonly RolloutFile[]> {
  const found: RolloutFile[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(path, depth + 1);
        continue;
      }
      const conversationId = rolloutConversationId(entry.name);
      if (!entry.isFile() || conversationId === undefined) continue;
      try {
        found.push({ path, modifiedAt: Math.trunc((await stat(path)).mtimeMs), conversationId });
      } catch {
        /* vanished between the listing and the stat */
      }
    }
  };
  await walk(directory, 0);
  return found.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** The newest `token_count` reading in one rollout's text, scanning from the end. */
export function newestRateLimitsInRollout(text: string, fallbackAt: number): PassiveUsageRecord | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.includes('token_count') || !line.includes('rate_limits')) continue;
    let event: Readonly<Record<string, unknown>> | undefined;
    try {
      event = asRecord(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
    const payload = asRecord(event?.payload);
    if (payload?.type !== 'token_count') continue;
    const stamped = typeof event?.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
    const at = Number.isFinite(stamped) && stamped >= 0 ? Math.trunc(stamped) : fallbackAt;
    const reading = parseCodexRateLimits(payload.rate_limits, at);
    if (!reading.hasQuotaSignal) continue;
    return {
      version: 1,
      source: 'codex-rollout',
      at,
      ...(reading.shortWindow === undefined ? {} : { fiveHour: reading.shortWindow }),
      ...(reading.longWindow === undefined ? {} : { weekly: reading.longWindow }),
    };
  }
  return undefined;
}

/** A rollout's text, decompressing a `.zst` one. */
async function rolloutText(path: string): Promise<string> {
  const bytes = await readFile(path);
  return path.endsWith('.zst') ? new TextDecoder().decode(Bun.zstdDecompressSync(bytes)) : bytes.toString('utf8');
}

/**
 * The newest reading across the rollouts a caller attributed to one credential.
 *
 * Files are read newest first and the first that carries a reading answers — a newer file's last
 * event is newer than anything in an older file. A file that cannot be read or decompressed is
 * skipped rather than fatal.
 */
export async function newestRolloutRateLimits(files: readonly RolloutFile[]): Promise<PassiveUsageRecord | undefined> {
  const ordered = [...files].sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const file of ordered) {
    let text: string;
    try {
      text = await rolloutText(file.path);
    } catch {
      continue;
    }
    const reading = newestRateLimitsInRollout(text, file.modifiedAt);
    if (reading !== undefined) return reading;
  }
  return undefined;
}
