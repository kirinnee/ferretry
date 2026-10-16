import type { AgentLessonToolCall, AgentLessonToolResult } from '@ferretry/protocol';

/**
 * Presentation port for `fy lesson suggest` — the narrowest slice of the shipped `ConsoleIo` adapter
 * this context uses, so the production adapter satisfies it structurally.
 */
export interface ILessonOutput {
  success(message: string): void;
}

/**
 * The one daemon call `fy lesson suggest` needs: the same agent route the `lessons_suggest` MCP
 * tool dials. Declared here so the controller never sees a header or a status code.
 */
export interface ILessonGateway {
  lessons(call: AgentLessonToolCall): Promise<AgentLessonToolResult>;
}
