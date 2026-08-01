import { z } from 'zod';
import { WAITING_BACKSTOP_MS } from '../../warden/detect.ts';

/** Every tunable the monitor slice owns, injected rather than hard-coded. */
export interface SessionMonitorSettings {
  /**
   * How often the loop looks at the fleet.
   *
   * It bounds how LATE a wake can be, not how often anything is written: a park whose deadline falls
   * between two ticks is woken on the next one, so the interval is the wake's worst-case error.
   */
  readonly tickIntervalMs: number;
  /**
   * How often a park republishes the proof that it is still being watched.
   *
   * Much longer than the tick, because a heartbeat is a durable write per parked session and the
   * thing it proves — that the loop is running — changes on the order of minutes, not seconds.
   */
  readonly heartbeatIntervalMs: number;
  /**
   * How far past its interval a tick may fall before the loop is reported as behind.
   *
   * A LOOP THAT CAN WAKE A WAIT CAN ALSO FAIL TO WAKE ONE, and a scheduler whose failure looks
   * identical to "nothing was waiting" is undetectable. This is the threshold that makes the two
   * distinguishable: the published tick record says when the loop last ran, and anything older than
   * one interval plus this grace is a loop that is not doing its job.
   */
  readonly tickGraceMs: number;
  /**
   * The ceiling on every park, however it was declared.
   *
   * The same constant the signal slice clamps `--until` to, so the deadline the monitor enforces can
   * never disagree with the one the park was accepted under.
   */
  readonly backstopMs: number;
}

export const SessionMonitorSettingsSchema = z.object({
  tickIntervalMs: z.number().int().positive(),
  heartbeatIntervalMs: z.number().int().positive(),
  tickGraceMs: z.number().int().nonnegative(),
  backstopMs: z.number().int().positive(),
});

export const defaultSessionMonitorSettings: SessionMonitorSettings = {
  tickIntervalMs: 15_000,
  heartbeatIntervalMs: 300_000,
  tickGraceMs: 30_000,
  backstopMs: WAITING_BACKSTOP_MS,
};

export function parseSessionMonitorSettings(value: unknown): SessionMonitorSettings {
  return SessionMonitorSettingsSchema.parse(value);
}
