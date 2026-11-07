import { z } from 'zod';
import { NonEmptyStringSchema } from './common.ts';
import { LoginIdSchema } from './ids.ts';

/** Why a login is paused: the period, the limit reached and when it resets (carries no running amount). */
export const PauseSchema = z.strictObject({
  period: z.enum(['daily', 'weekly']),
  level: z.enum(['over_trigger', 'over_hard']),
  limitUsd: z.number().finite().positive(),
  resetsAtMs: z.number().finite().nonnegative(),
  timeZone: NonEmptyStringSchema,
});

/** `state/usage/pauses.json`: the pauses last published, kept so a restart starts from them (those whose reset is ahead). */
export const PausesFileSchema = z.strictObject({ pauses: z.record(z.string(), PauseSchema) });
export type PausesFile = z.infer<typeof PausesFileSchema>;

/** `state/usage/pause-told.json`: which (login, period, period start) the owner was already told about; never twice. */
export const PauseToldFileSchema = z.strictObject({ told: z.array(z.string()) });
export type PauseToldFile = z.infer<typeof PauseToldFileSchema>;

/** One paused login, for a view. */
export const LoginPauseSchema = z.strictObject({ login: LoginIdSchema, pause: PauseSchema, phrase: z.string() });
export type LoginPause = z.infer<typeof LoginPauseSchema>;
