import type { LaunchPart, LaunchPartSource } from '@ferretry/core-ferrets/contract';
import { LESSONS_INSTRUCTION } from './lib/instruction.ts';

export interface LaunchLessons {
  /** Whether this ferret is instructed to file lessons (a new ferret takes the machine default, once). */
  passive(ferret: string, name: string): Promise<boolean>;
  /** The Global lessons document, or `undefined` before the first Apply. */
  global(): Promise<string | undefined>;
}

/** The pane's passive-learning variable (read by `instructions` and the launch wrappers): `1` instructed, `0` not. */
export const LESSONS_PASSIVE_ENV = 'FY_LEARNING_PASSIVE';

/**
 * What Lessons adds to every launch (`launch.parts`, §4.9): the Global lessons document, so every ferret after a
 * correction reads the rule, the teaching to file lessons for a ferret that is instructed to (inert text), and
 * `FY_LEARNING_PASSIVE` for every ferret, so Ferrets records the switch for `instructions`.
 */
export function lessonsParts(lessons: LaunchLessons, binaryName: string): LaunchPartSource {
  return {
    async parts(spec): Promise<readonly LaunchPart[]> {
      const parts: LaunchPart[] = [];
      const passive = await lessons.passive(spec.ferret, spec.name);
      parts.push({ kind: 'env', env: { [LESSONS_PASSIVE_ENV]: passive ? '1' : '0' } });
      const document = await lessons.global();
      if (document !== undefined && document.trim() !== '')
        parts.push({ kind: 'instruction', id: 'lessons-global', text: document });
      if (passive) parts.push({ kind: 'instruction', id: 'lessons', text: LESSONS_INSTRUCTION(binaryName) });
      return parts;
    },
  };
}
