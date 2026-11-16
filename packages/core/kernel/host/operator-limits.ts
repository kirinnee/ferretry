import { parseBackgroundDelay } from './jobs.ts';
import { parseWatchdogLimit, WATCHDOG_VARIABLE } from './loop-health.ts';

/** The two numbers an operator sets by environment variable, read once at boot. */
export type OperatorLimits =
  | { readonly ok: true; readonly backgroundDelayMs: number; readonly watchdogLimitMs: number }
  | { readonly ok: false; readonly sentence: string };

/** `FYD_BACKGROUND_DELAY_SECONDS` and `FYD_WATCHDOG_SECONDS`: a value that is not a whole number of seconds refuses the boot, naming it. */
export function operatorLimits(env: Readonly<Record<string, string | undefined>>): OperatorLimits {
  try {
    return {
      ok: true,
      backgroundDelayMs: parseBackgroundDelay(env.FYD_BACKGROUND_DELAY_SECONDS),
      watchdogLimitMs: parseWatchdogLimit(env[WATCHDOG_VARIABLE]),
    };
  } catch (error) {
    return { ok: false, sentence: error instanceof Error ? error.message : String(error) };
  }
}
