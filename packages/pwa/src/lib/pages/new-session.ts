import { type StartSessionRequest, StartSessionRequestSchema } from '@ferretry/protocol';

import type { DaemonConnection } from '../daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../daemon-scope.ts';

export interface NewSessionDraft {
  agent: string;
  cwd: string;
  model: string;
  mode: 'auto' | 'interactive';
  label: string;
  prompt: string;
}

export const emptyNewSessionDraft: NewSessionDraft = {
  agent: '',
  cwd: '',
  model: '',
  mode: 'auto',
  label: '',
  prompt: '',
};

export function canSubmitNewSession(
  draft: NewSessionDraft,
  connection: DaemonConnection | undefined,
  isSubmitting: boolean,
): boolean {
  if (connection === undefined || isSubmitting || draft.agent.trim() === '') {
    return false;
  }

  return draft.mode === 'interactive' || draft.prompt.trim() !== '';
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function buildStartSessionRequest(draft: NewSessionDraft): StartSessionRequest {
  const agent = draft.agent.trim();
  const cwd = optionalText(draft.cwd);
  const model = optionalText(draft.model);
  const label = optionalText(draft.label);
  const prompt = optionalText(draft.prompt);

  return StartSessionRequestSchema.parse({
    agent,
    ...(cwd === undefined ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
    mode: draft.mode,
    ...(label === undefined ? {} : { label }),
    ...(prompt === undefined ? {} : { prompt }),
  });
}

export interface DaemonBoundSessionStarter {
  readonly connection: DaemonConnection;
  start(request: StartSessionRequest): Promise<{
    config: { id: string };
  }>;
}

export async function submitNewSession(
  draft: NewSessionDraft,
  starter: DaemonBoundSessionStarter,
): Promise<DaemonSessionScope> {
  const result = await starter.start(buildStartSessionRequest(draft));
  return daemonSessionScope(starter.connection, result.config.id);
}
