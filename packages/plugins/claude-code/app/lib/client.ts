import type { PluginClient } from '@ferretry/kernel/manifest';

/** The refusal an answer raises: a status, the daemon's sentence, and its code. */
export class AnswerRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AnswerRefusal';
  }
}

/** The generated client, narrowed to the one call the answers make. */
export type ClaudeCodeClient = Pick<PluginClient, 'call'>;

/** Whether a thrown thing is the generated client's refusal (a status and the daemon's code), not a bug. */
export const refusedWith = (error: unknown, status: number, code: string): error is Error =>
  error instanceof Error &&
  (error as { status?: unknown }).status === status &&
  (error as { code?: unknown }).code === code;
