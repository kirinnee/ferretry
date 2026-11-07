import { definePort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { defineEvent } from '@ferretry/kernel/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { AgentLessonToolResult } from './suggest.ts';
import type { ProposalCategory } from './wire.ts';

/** What other plugins and the app read through Lessons. The rules themselves reach a ferret through `launch.parts`. */
export interface LessonsApi {
  /** Whether a ferret is instructed to file lessons (a ferret with no record takes the machine default). */
  passive(ferret: FerretId): Promise<boolean>;
  /** A ferret files one lesson; the evidence is the owner's latest message, read by Lessons itself. */
  suggest(ferret: FerretId, rule: string, scope: ProposalCategory): Promise<AgentLessonToolResult>;
}
export const LessonsPort = definePort<LessonsApi>('lessons');

/** The board of lessons changed (filed, judged, applied). A wake-up for views; the truth is the daemon's board. */
export const LessonsChanged = defineEvent('lessons.changed', z.strictObject({ generation: z.number().int() }));
