/**
 * The PASSIVE Codex usage reading of design §8.2.3: the newest `token_count` event's `rate_limits` in a rollout. Zero
 * network — Codex already wrote this down on its own last turn.
 *
 * A rollout is one JSON object per line. The event this reads is
 * `{"timestamp": "<ISO>", "type": "event_msg", "payload": {"type": "token_count", "rate_limits":
 * {"primary": {…}, "secondary": {…}}}}`; `primary` is the 5-hour window and `secondary` the weekly one.
 *
 * Attribution is NOT this file's: it reads the one transcript it is handed (a ferret's proved rollout) and nothing else,
 * so a rollout this daemon did not launch is never read. Nothing here is credential material, and nothing is written.
 */
import { parseCodexRateLimits } from './quota.ts';
import type { PassiveUsageRecord } from './usage.ts';

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

/** The part of a proved transcript the reader needs: its size, and a bounded window of its bytes. */
export interface RolloutBytes {
  readonly size: number;
  /** The file's modification time, epoch milliseconds: the instant a reading without a timestamp is dated. */
  readonly mtimeMs: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** The newest `token_count` reading in one block of a rollout's text, scanning from the end. */
export function newestRateLimitsInText(text: string, fallbackAt: number): PassiveUsageRecord | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.includes('token_count') || !line.includes('rate_limits')) continue;
    let event: Readonly<Record<string, unknown>>;
    try {
      event = asRecord(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
    const payload = asRecord(event.payload);
    if (payload.type !== 'token_count') continue;
    const stamped = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
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

/**
 * How much of a rollout each step scans, walking back from its END. A rollout grows for as long as its agent works and
 * its newest `token_count` is one of its last records, so the first small window almost always answers; when it does
 * not, the walk continues towards the start in fixed windows (each within the root's own window limit) until one does
 * or the file is exhausted. The whole file is consulted at most, never as one string.
 */
export const ROLLOUT_FIRST_WINDOW_BYTES = 256 * 1024;
const ROLLOUT_WINDOW_BYTES = 2 * 1024 * 1024;
/** A single record longer than this is skipped rather than carried into the next window: no event is near it. */
export const ROLLOUT_MAX_RECORD_BYTES = 16 * 1024 * 1024;

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

const joined = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
  const both = new Uint8Array(head.byteLength + tail.byteLength);
  both.set(head, 0);
  both.set(tail, head.byteLength);
  return both;
};

/**
 * The newest reading in a rollout, scanned from its end one window at a time. A window that does not start at byte zero
 * begins mid-record, so its bytes up to the first newline are held back and joined to the window before it: every
 * record is scanned whole, exactly once, and never split across two scans.
 */
export async function newestRolloutReading(rollout: RolloutBytes): Promise<PassiveUsageRecord | undefined> {
  let end = rollout.size;
  let carry: Uint8Array = new Uint8Array(0);
  let window = ROLLOUT_FIRST_WINDOW_BYTES;
  while (end > 0) {
    const start = Math.max(0, end - window);
    window = ROLLOUT_WINDOW_BYTES;
    let chunk = joined(await rollout.read(start, end - start), carry);
    end = start;
    if (start > 0) {
      const newline = chunk.indexOf(NEWLINE);
      if (newline < 0) {
        carry = chunk.byteLength > ROLLOUT_MAX_RECORD_BYTES ? new Uint8Array(0) : chunk;
        continue;
      }
      carry = chunk.slice(0, newline);
      chunk = chunk.subarray(newline + 1);
    } else {
      carry = new Uint8Array(0);
    }
    const reading = newestRateLimitsInText(decoder.decode(chunk), Math.trunc(rollout.mtimeMs));
    if (reading !== undefined) return reading;
  }
  return undefined;
}
