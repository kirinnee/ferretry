/** "Claude Code is ready" — the last page of the Claude segment: the runtime the pick ended with (the shared body is Runtimes' kit). */
import { RuntimeReadyPage } from '@ferretry/plugin-runtimes/import-kit';
import { CLAUDE_CODE } from '../../../contract/index.ts';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import type { StepPageProps } from './props.ts';

export function ReadyPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  return <RuntimeReadyPage client={client} harness={CLAUDE_CODE} label="Claude Code" step={step} />;
}
