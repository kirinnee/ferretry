/**
 * `fy statusline`: what every Claude runtime's `statusLine.command` runs (`'fy' statusline [--then '<own>']`, the one
 * spelling Runtimes materialises).
 *
 * Claude hands that command the turn's JSON on stdin, `rate_limits` included. This records that block as the login's
 * PASSIVE usage reading (`<fleet>/credentials/<FY_CREDENTIAL>/usage.json`, the file Logins' daemon reads), then runs the
 * person's OWN status line command with the same stdin, so what they see is what they saw before. A status line must
 * never break a session: input that is not JSON, no `FY_CREDENTIAL` or a failed write skip the recording and still
 * exit 0; with `--then` the exit code is theirs.
 *
 * It never opens the daemon connection: it runs after every turn, and it must work with no daemon up.
 *
 * The record's shape and the percentage/reset rules are Logins' (`plugins/logins/daemon/lib/credentials/usage.ts` and
 * `quota.ts`), whose daemon library is not part of its contract: like Runtimes' copy of the statusLine spelling, this
 * is a small copy of the one reading, kept to the same rules.
 */
import { optionText } from '../argv.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

/** The environment variable naming the login a runtime spends (`CREDENTIAL_ENV`, set by materialisation). */
const CREDENTIAL_ENV = 'FY_CREDENTIAL';
/** The most of stdin a status line reads. Claude's payload is a few kilobytes. */
const INPUT_LIMIT = 1024 * 1024;

interface StatuslineWindow {
  readonly usedPercent?: number;
  readonly resetAt?: number;
}

/** One passive reading, exactly as `usage.json` holds it (`PassiveUsageRecordSchema`). */
export interface StatuslineUsageRecord {
  readonly version: 1;
  readonly source: 'claude-statusline';
  readonly at: number;
  readonly fiveHour?: StatuslineWindow;
  readonly weekly?: StatuslineWindow;
}

/** What `fy statusline` needs from the machine beyond stdin and the environment. */
export interface StatuslinePorts {
  /** Writes the login's passive reading atomically (temp file, then rename), `0600`. */
  writeUsage(credentialId: string, record: StatuslineUsageRecord): Promise<void>;
  /** Runs the person's own command through `sh -c` with this stdin; its output goes straight to ours. Answers its exit code. */
  chain(command: string, stdin: string): Promise<number>;
  now(): number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}

/** ISO timestamps, epoch seconds and epoch milliseconds, as milliseconds. */
function resetAt(value: unknown): number | undefined {
  let milliseconds: number | undefined;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) milliseconds = parsed;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.trunc(milliseconds);
}

function windowOf(raw: unknown): { readonly window?: StatuslineWindow; readonly measured: boolean } {
  const record = asRecord(raw);
  const usedPercent = percent(record.used_percentage);
  const reset = resetAt(record.resets_at);
  if (usedPercent === undefined && reset === undefined) return { measured: false };
  return {
    window: {
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(reset === undefined ? {} : { resetAt: reset }),
    },
    measured: usedPercent !== undefined,
  };
}

/** The passive record one statusLine payload yields, or nothing when it measured nothing. */
function statuslineUsageRecord(payload: string, at: number): StatuslineUsageRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  const limits = asRecord(asRecord(parsed).rate_limits);
  const short = windowOf(limits.five_hour);
  const long = windowOf(limits.seven_day);
  if (!short.measured && !long.measured) return undefined;
  return {
    version: 1,
    source: 'claude-statusline',
    at,
    ...(short.window === undefined ? {} : { fiveHour: short.window }),
    ...(long.window === undefined ? {} : { weekly: long.window }),
  };
}

/** The whole of stdin, bounded; an unreadable stdin is empty. */
async function readInput(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  let kept = 0;
  try {
    for await (const chunk of stream) {
      if (kept >= INPUT_LIMIT) continue;
      const slice = chunk.byteLength > INPUT_LIMIT - kept ? chunk.slice(0, INPUT_LIMIT - kept) : chunk;
      kept += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
    }
  } catch {
    return text;
  }
  return text + decoder.decode();
}

export const statuslineVerb: ShellVerb = async (context: ShellContext): Promise<number> => {
  const { world, invocation } = context;
  const ports = world.statusline;
  const payload = await readInput(world.host.stdin());
  const id = world.environment[CREDENTIAL_ENV]?.trim();
  if (ports !== undefined && id !== undefined && id !== '') {
    const record = statuslineUsageRecord(payload, ports.now());
    if (record !== undefined) {
      try {
        await ports.writeUsage(id, record);
      } catch {
        /* a status line never fails over its own bookkeeping */
      }
    }
  }
  const own = optionText(invocation, 'then')?.trim() ?? '';
  if (own === '' || ports === undefined) return 0;
  return await ports.chain(own, payload);
};
