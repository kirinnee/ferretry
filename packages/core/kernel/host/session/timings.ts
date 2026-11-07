/**
 * THE DAEMON'S TIME-BOUND RULES, SHORTENED FOR A TEST — never lengthened (R247). Copied from today's
 * `packages/daemon/src/lib/runtime/timings.ts`.
 *
 * A session's lease (fifteen minutes), its cap (twelve hours) and the shortest idle period a machine
 * may set (one day) are what make a revoked or forgotten device lose its access, and a compiled daemon
 * fixes all three. An end-to-end run cannot wait them out, so `FYD_TEST_TIMINGS` names shorter ones:
 *
 *     {"leaseSeconds": 6, "renewLeadSeconds": 2, "maxSessionSeconds": 20, "idleDaySeconds": 5}
 *
 * EVERY FIELD CAN ONLY NARROW. A value longer than the shipped one is refused rather than clamped,
 * because a variable that could stretch a lease would be a way to keep a revoked device's channel open
 * longer — and an operator who set one by mistake should hear about it at boot, not find it in effect.
 * Absent or empty means the shipped numbers, exactly.
 */

import { z } from 'zod';
import type { DaemonTimings } from '../../contract/ports.ts';
import { DEFAULT_ACCESS_LEASE_POLICY } from './limits.ts';

/** The variable a test sets; read once, at boot. */
export const TEST_TIMINGS_VARIABLE = 'FYD_TEST_TIMINGS';

const DAY_SECONDS = 24 * 60 * 60;

/** The contract's shape (`kernel.timings`), re-exported where it is parsed. */
export type { DaemonTimings } from '../../contract/ports.ts';

export const DEFAULT_DAEMON_TIMINGS: DaemonTimings = Object.freeze({
  lease: DEFAULT_ACCESS_LEASE_POLICY,
  idleDayMs: DAY_SECONDS * 1_000,
});

const atMost = (shipped: number) => z.number().int().positive().max(shipped);

const TimingOverridesSchema = z
  .strictObject({
    leaseSeconds: atMost(DEFAULT_ACCESS_LEASE_POLICY.leaseMs / 1_000).optional(),
    renewLeadSeconds: atMost(DEFAULT_ACCESS_LEASE_POLICY.renewLeadMs / 1_000).optional(),
    maxSessionSeconds: atMost(DEFAULT_ACCESS_LEASE_POLICY.maxSessionMs / 1_000).optional(),
    idleDaySeconds: atMost(DAY_SECONDS).optional(),
  })
  .refine(
    value =>
      (value.renewLeadSeconds ?? DEFAULT_ACCESS_LEASE_POLICY.renewLeadMs / 1_000) <
      (value.leaseSeconds ?? DEFAULT_ACCESS_LEASE_POLICY.leaseMs / 1_000),
    'renewLeadSeconds must be shorter than leaseSeconds, or no renewal is ever asked for',
  );

/** The timings in force for this `FYD_TEST_TIMINGS` value. Throws, naming the variable, on anything else. */
export function parseDaemonTimings(raw: string | undefined): DaemonTimings {
  const text = raw?.trim() ?? '';
  if (text === '') return DEFAULT_DAEMON_TIMINGS;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${TEST_TIMINGS_VARIABLE} is not JSON: ${text}`);
  }
  const parsed = TimingOverridesSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `${TEST_TIMINGS_VARIABLE} may only shorten the shipped timings: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ')}`,
    );
  const seconds = parsed.data;
  const lease = DEFAULT_ACCESS_LEASE_POLICY;
  return {
    lease: {
      leaseMs: (seconds.leaseSeconds ?? lease.leaseMs / 1_000) * 1_000,
      renewLeadMs: (seconds.renewLeadSeconds ?? lease.renewLeadMs / 1_000) * 1_000,
      maxSessionMs: (seconds.maxSessionSeconds ?? lease.maxSessionMs / 1_000) * 1_000,
    },
    idleDayMs: (seconds.idleDaySeconds ?? DAY_SECONDS) * 1_000,
  };
}

/** One line for the boot log while shortened timings are in force, or nothing when none are. */
export function describeDaemonTimings(timings: DaemonTimings): string | undefined {
  if (timings === DEFAULT_DAEMON_TIMINGS) return undefined;
  const { leaseMs, renewLeadMs, maxSessionMs } = timings.lease;
  return `${TEST_TIMINGS_VARIABLE} in force: lease ${String(leaseMs / 1_000)}s (renewed ${String(renewLeadMs / 1_000)}s ahead), session cap ${String(maxSessionMs / 1_000)}s, one idle day ${String(timings.idleDayMs / 1_000)}s`;
}

/**
 * The boot step: the timings for this value, with the one log line said ONCE when they are shortened, or the
 * sentence the boot is refused with. `fyd` calls it exactly once, before the host starts.
 */
export function bootTimings(
  raw: string | undefined,
  log: (line: string) => void,
): { readonly ok: true; readonly timings: DaemonTimings } | { readonly ok: false; readonly sentence: string } {
  let timings: DaemonTimings;
  try {
    timings = parseDaemonTimings(raw);
  } catch (error) {
    return { ok: false, sentence: `fyd: ${error instanceof Error ? error.message : String(error)}` };
  }
  const line = describeDaemonTimings(timings);
  if (line !== undefined) log(line);
  return { ok: true, timings };
}
