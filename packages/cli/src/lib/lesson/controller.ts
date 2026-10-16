import { AgentLessonToolCallSchema } from '@ferretry/protocol';
import type { z } from 'zod';
import type { ILessonGateway, ILessonOutput } from './ports.ts';
import { renderLessonSuggestion } from './render.ts';

/** Options `fy lesson suggest` accepts. */
export interface LessonCommandOptions {
  /** Emit the protocol payload verbatim instead of the daemon's sentence. */
  readonly json?: boolean;
}

/** The first thing the call schema refused, said with where it was. */
function refusal(error: z.ZodError): string {
  // A failed parse always carries at least one issue.
  const [issue] = error.issues as [z.core.$ZodIssue];
  return issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`;
}

/**
 * Drives `fy lesson suggest "<rule>" --scope global|repo`.
 *
 * It acts as the agent session this runs inside — the same route the `lessons_suggest` MCP tool
 * dials — so run outside a session, the gateway's own refusal (the daemon's 401/403 sentence) is
 * what the human sees.
 */
export class LessonController {
  constructor(
    private readonly gateway: ILessonGateway,
    private readonly out: ILessonOutput,
  ) {}

  async suggest(rule: string, scope: string, options: LessonCommandOptions): Promise<void> {
    const parsed = AgentLessonToolCallSchema.safeParse({ tool: 'lessons.suggest', rule, scope });
    if (!parsed.success) throw new Error(refusal(parsed.error));
    const result = await this.gateway.lessons(parsed.data);
    this.out.success(options.json === true ? JSON.stringify(result, null, 2) : renderLessonSuggestion(result));
  }
}
