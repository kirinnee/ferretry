import { defineConfig } from '@ferretry/kernel/contract';
import { type LessonsConfig, LessonsConfigSchema } from './wire.ts';

/** The schedule a daemon with no `lessons.yaml` behaves as (today's `DEFAULT_LEARNING_CONFIG`). */
export const DEFAULT_LESSONS_CONFIG: LessonsConfig = {
  enabled: true,
  agent: 'claude',
  intervalMinutes: 60,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxFerretsPerRun: 40,
  minSpawnGapMinutes: 30,
  passiveDefault: true,
};

/** `lessons.yaml` as written: every setting optional, an unknown key refused. */
export const LessonsFileSchema = LessonsConfigSchema.strict().partial();
export type LessonsFile = typeof LessonsFileSchema extends { _output: infer O } ? O : never;

/** The settings a parsed `lessons.yaml` means. */
export function lessonsConfigFromFile(file: Partial<LessonsConfig> | undefined): LessonsConfig {
  return LessonsConfigSchema.parse({ ...DEFAULT_LESSONS_CONFIG, ...file });
}

const raised = (before: number, after: number, what: string): readonly string[] =>
  after > before ? [`${what} goes up from ${String(before)} to ${String(after)}`] : [];

const lowered = (before: number, after: number, what: string): readonly string[] =>
  after < before ? [`${what} goes down from ${String(before)} to ${String(after)}`] : [];

const switchedOn = (before: boolean, after: boolean, what: string): readonly string[] =>
  !before && after ? [what] : [];

/**
 * Which edits of `lessons.yaml` LOOSEN what lesson mining may spend (docs/config-files.md rule 2, today's
 * `learningLoosening`): a loosening edit is HELD for the owner and the tighter version stays in effect. Mining is real
 * ferret launches, so switching it on, raising how many miners or ferrets one run may take, or shortening its cadence
 * spends. Each entry is a plain sentence naming what widened. Switching mining off, lowering a cap, lengthening the
 * cadence, the agent or model a miner runs on and the passive default never loosen.
 */
export function lessonsLoosens(before: LessonsFile | undefined, after: LessonsFile | undefined): readonly string[] {
  const was = lessonsConfigFromFile(before);
  const now = lessonsConfigFromFile(after);
  return [
    ...switchedOn(was.enabled, now.enabled, 'lesson mining may now spend on ferrets'),
    ...raised(was.maxMinersPerRun, now.maxMinersPerRun, 'the lesson miners one run may start'),
    ...raised(was.maxFerretsPerRun, now.maxFerretsPerRun, 'the ferrets one lesson run may read'),
    ...raised(was.batchSize, now.batchSize, 'the ferrets one lesson miner reads'),
    ...lowered(was.intervalMinutes, now.intervalMinutes, 'the minutes between lesson runs'),
    ...lowered(was.minSpawnGapMinutes, now.minSpawnGapMinutes, 'the minutes between two lesson miners'),
  ];
}

/**
 * `lessons.yaml` picks a schedule, the miner's agent and a default; a hand edit that loosens what mining may spend
 * ({@link lessonsLoosens}) is held for the owner.
 */
export const LESSONS_CONFIG = defineConfig({
  file: 'lessons.yaml',
  schema: LessonsFileSchema,
  axis: 'configure',
  loosens: lessonsLoosens,
});
