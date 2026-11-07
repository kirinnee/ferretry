import type { ConfigPort, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import {
  DEFAULT_LESSONS_CONFIG,
  LESSONS_CONFIG,
  type LessonsConfig,
  type LessonsConfigPatch,
  LessonsConfigSchema,
  type LessonsFile,
  lessonsConfigFromFile,
} from '../../contract/index.ts';

/**
 * EVERY key of `lessons.yaml` (the schema's whole shape, so `model`, which has no default, is one), as `next` means it,
 * for the kernel to patch over the disk text (today's `renderConfigFile` of the whole settings,
 * `packages/daemon/src/adapters/learning/config-store.ts`). A key the version in effect states, or one whose value is
 * not the default, is written; any other is removed (`undefined`), so its default stands. The kernel still edits only
 * the keys whose value changes, so the owner's comments survive, and whatever else the disk says (a broken value, an
 * unreloaded hand edit) is overwritten with the value in effect, never carried into effect.
 */
export function wholeLessonsSettings(next: LessonsConfig, inEffect: LessonsFile): Record<string, unknown> {
  const stated = inEffect as Record<string, unknown>;
  const defaults = DEFAULT_LESSONS_CONFIG as Record<string, unknown>;
  const values = next as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(LessonsConfigSchema.shape).map(key => [
      key,
      stated[key] !== undefined || values[key] !== defaults[key] ? values[key] : undefined,
    ]),
  );
}

/**
 * The owner's save of `lessons.yaml` (Settings › Lessons): the WHOLE settings in effect plus the owner's patch, through
 * the kernel's config write port, which checks the schema, refuses a raw secret, keeps the comments and HOLDS a
 * loosening for the owner unless Gate's judge lets this call put it into effect. Because the settings in effect are the
 * base, the kernel judges only the owner's own patch, and a broken file's other keys never ride into effect with it.
 */
export async function writeLessonsSettings(config: ConfigPort, patch: LessonsConfigPatch): Promise<ConfigWriteOutcome> {
  const inEffect = (config.file(LESSONS_CONFIG) ?? {}) as LessonsFile;
  const next: LessonsConfig = { ...lessonsConfigFromFile(inEffect), ...patch };
  return await config.write(LESSONS_CONFIG, undefined, { patch: wholeLessonsSettings(next, inEffect) });
}
