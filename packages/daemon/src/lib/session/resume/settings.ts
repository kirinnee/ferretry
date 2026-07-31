import { z } from 'zod';

/**
 * Every tunable the resume slice owns, injected rather than hard-coded.
 *
 * Reviving a session replaces a live terminal, so these are the numbers that decide how long a
 * caller waits before a pending launch is reported as pending, and how hard an automatic retry
 * tries before it stops. Both are deployment-shaped, not universal.
 */
export interface SessionResumeSettings {
  /**
   * How long a resume queues behind an in-flight FIRST launch before answering "still launching".
   * Long enough to swallow a slow provider's bootstrap, short enough to stay under a client's
   * request timeout.
   */
  readonly controlLaunchWaitMs: number;
  /** What an auto session is told when a resume carries no message of its own. */
  readonly defaultResumePrompt: string;
  /** Appended to every written turn document, so a revived agent keeps the same protocol. */
  readonly turnProtocolReminder: string;
  /** First backoff step; attempt N waits `base * 2^(N-1)`. */
  readonly retryBackoffBaseMs: number;
  /**
   * Ceiling on that backoff. Uncapped doubling reaches days by the twentieth attempt, which is
   * indistinguishable from having given up while still holding the session in `retrying`.
   */
  readonly retryBackoffMaxMs: number;
}

export const SessionResumeSettingsSchema = z
  .object({
    controlLaunchWaitMs: z.number().int().positive(),
    defaultResumePrompt: z.string().min(1),
    turnProtocolReminder: z.string().min(1),
    retryBackoffBaseMs: z.number().int().positive(),
    retryBackoffMaxMs: z.number().int().positive(),
  })
  .refine(
    value => value.retryBackoffMaxMs >= value.retryBackoffBaseMs,
    'retryBackoffMaxMs must be at least retryBackoffBaseMs, or the first backoff is already capped away',
  );

export const defaultSessionResumeSettings: SessionResumeSettings = {
  controlLaunchWaitMs: 60_000,
  defaultResumePrompt: 'Continue the assigned task from where you stopped.',
  turnProtocolReminder: 'Continue using the same completion and interaction protocol.',
  retryBackoffBaseMs: 2_000,
  retryBackoffMaxMs: 5 * 60_000,
};

export function parseSessionResumeSettings(value: unknown): SessionResumeSettings {
  return SessionResumeSettingsSchema.parse(value);
}
