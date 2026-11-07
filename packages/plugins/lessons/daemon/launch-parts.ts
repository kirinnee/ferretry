import type { LaunchPart, LaunchPartSource } from '@ferretry/core-ferrets/contract';
import { LESSONS_INSTRUCTION } from './lib/instruction.ts';

export interface LaunchLessons {
  /** Whether this ferret is instructed to file lessons (a new ferret takes the machine default, once). */
  passive(ferret: string, name: string): Promise<boolean>;
  /** The Global lessons document, or `undefined` before the first Apply. */
  global(): Promise<string | undefined>;
}

/**
 * What Lessons adds to every launch (`launch.parts`, §4.9): the Global lessons document, so every ferret after a
 * correction reads the rule, and the teaching to file lessons for a ferret that is instructed to. Inert text.
 */
export function lessonsParts(lessons: LaunchLessons, binaryName: string): LaunchPartSource {
  return {
    async parts(spec): Promise<readonly LaunchPart[]> {
      const parts: LaunchPart[] = [];
      const document = await lessons.global();
      if (document !== undefined && document.trim() !== '')
        parts.push({ kind: 'instruction', id: 'lessons-global', text: document });
      if (await lessons.passive(spec.ferret, spec.name))
        parts.push({ kind: 'instruction', id: 'lessons', text: LESSONS_INSTRUCTION(binaryName) });
      return parts;
    },
  };
}
