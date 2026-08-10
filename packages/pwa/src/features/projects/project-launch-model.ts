import { type StartSessionRequest, StartSessionRequestSchema } from '@ferretry/protocol';

/** Builds the existing top-level interactive-session contract for one Project. */
export const projectLaunchRequest = (agent: string, cwd: string): StartSessionRequest =>
  StartSessionRequestSchema.parse({ agent: agent.trim(), cwd, mode: 'interactive', boardAccess: 'none' });
