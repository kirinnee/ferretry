import { z } from 'zod';

/**
 * Every threshold the health slice reasons with, injected rather than hard-coded.
 *
 * These decide whether the daemon disturbs working agents, so they are exactly the numbers an
 * operator needs to move when a deployment's timings differ from ours: a wedge threshold that
 * cannot be tuned is a threshold that gets worked around.
 */
export interface SessionHealthSettings {
  /** Expected cadence of the self-check timer. Lag is the gap ABOVE this, not the whole gap. */
  readonly selfCheckIntervalMs: number;
  /**
   * A self-check tick this late means the event loop stopped running. Three missed ticks at the
   * default cadence is unambiguous — one slow tick is not.
   */
  readonly wedgeGapMs: number;
  /** Consecutive consistency passes that failed to heal the index before a restart is requested. */
  readonly incoherentRestartThreshold: number;
  /** Minimum wall-clock gap between two self-restarts, across process lifetimes. */
  readonly selfRestartCooldownMs: number;
  /** Longest a sweep may be missing before the warden is treated as dead rather than merely late. */
  readonly wardenSweepStaleFloorMs: number;
  /** Sweep intervals that may be missed before staleness is declared, when that exceeds the floor. */
  readonly wardenSweepStaleIntervals: number;
  /**
   * How long a queued first launch is excluded from "running but unmonitored" repair. A bootstrap
   * that never finishes must not hide its session from repair forever.
   */
  readonly launchGraceMs: number;
  /**
   * How long a finished session's journal may keep growing before it counts as a zombie: work
   * nothing supervises, which `ps` cannot show because the pane is gone.
   */
  readonly terminalActivityGraceMs: number;
  /** Unhealable session ids named in a restart announcement before it summarizes the remainder. */
  readonly unhealablePreviewLimit: number;
  /** Unhealable session ids retained in the durable restart stamp. */
  readonly selfRestartStampSessionLimit: number;
}

/**
 * Parsed rather than asserted: a deployment that configures a wedge threshold BELOW the self-check
 * interval declares every healthy tick a wedge, and one that configures a zero threshold restarts
 * the daemon on the first imperfect pass. Both are caught here instead of in production.
 */
export const SessionHealthSettingsSchema = z
  .object({
    selfCheckIntervalMs: z.number().int().positive(),
    wedgeGapMs: z.number().int().positive(),
    incoherentRestartThreshold: z.number().int().min(1),
    selfRestartCooldownMs: z.number().int().positive(),
    wardenSweepStaleFloorMs: z.number().int().positive(),
    wardenSweepStaleIntervals: z.number().int().min(1),
    launchGraceMs: z.number().int().positive(),
    terminalActivityGraceMs: z.number().int().positive(),
    unhealablePreviewLimit: z.number().int().min(1),
    selfRestartStampSessionLimit: z.number().int().min(1),
  })
  .refine(
    value => value.wedgeGapMs > value.selfCheckIntervalMs,
    'wedgeGapMs must exceed selfCheckIntervalMs, or every on-time tick reads as a wedge',
  );

export const defaultSessionHealthSettings: SessionHealthSettings = {
  selfCheckIntervalMs: 60_000,
  wedgeGapMs: 180_000,
  incoherentRestartThreshold: 3,
  selfRestartCooldownMs: 30 * 60_000,
  wardenSweepStaleFloorMs: 120_000,
  wardenSweepStaleIntervals: 3,
  launchGraceMs: 10 * 60_000,
  terminalActivityGraceMs: 60_000,
  unhealablePreviewLimit: 10,
  selfRestartStampSessionLimit: 20,
};

/** Validates an operator-supplied override set before anything reasons with it. */
export function parseSessionHealthSettings(value: unknown): SessionHealthSettings {
  return SessionHealthSettingsSchema.parse(value);
}
