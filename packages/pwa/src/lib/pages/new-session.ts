import { StartSessionRequestSchema } from '@ferretry/protocol';

import { daemonSessionScope } from '../daemon-scope';

export type DaemonConnection = Parameters<typeof daemonSessionScope>[0];

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

export function canSubmit(
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
