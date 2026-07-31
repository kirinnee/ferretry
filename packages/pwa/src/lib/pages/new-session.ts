import { StartSessionRequestSchema } from '@ferretry/protocol';

import type { DaemonConnection } from '../daemon-connection.ts';
import { daemonSessionScope } from '../daemon-scope.ts';

export type { DaemonConnection } from '../daemon-connection.ts';

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

export function buildStartSessionRequest(draft: NewSessionDraft) {
  const agent = draft.agent.trim();
  const prompt = optionalText(draft.prompt);

  return StartSessionRequestSchema.parse({
    agent,
    ...(optionalText(draft.cwd) === undefined ? {} : { cwd: optionalText(draft.cwd) }),
    ...(optionalText(draft.model) === undefined ? {} : { model: optionalText(draft.model) }),
    mode: draft.mode,
    ...(optionalText(draft.label) === undefined ? {} : { label: optionalText(draft.label) }),
    ...(prompt === undefined ? {} : { prompt }),
  });
}

export interface DaemonBoundSessionStarter {
  connection: DaemonConnection;
  start(request: ReturnType<typeof buildStartSessionRequest>): Promise<{
    config: { id: string };
  }>;
}

export async function submitNewSession(draft: NewSessionDraft, starter: DaemonBoundSessionStarter) {
  const result = await starter.start(buildStartSessionRequest(draft));
  return daemonSessionScope(starter.connection, result.config.id);
}
