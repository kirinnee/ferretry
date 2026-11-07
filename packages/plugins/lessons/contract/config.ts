import { defineConfig, neverLoosens } from '@ferretry/kernel/contract';
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

/** Nothing in `lessons.yaml` widens authority or spends: it picks a schedule and a default. */
export const LESSONS_CONFIG = defineConfig({
  file: 'lessons.yaml',
  schema: LessonsFileSchema,
  axis: 'configure',
  loosens: neverLoosens,
});
