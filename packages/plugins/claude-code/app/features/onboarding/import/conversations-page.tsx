/**
 * "Conversations": no choice. Ferretry reads the conversations Claude Code keeps on this computer automatically, one way,
 * and the page says so in one sentence beside a clearly generic example. It asks nothing and writes nothing, so it is ready
 * at once and Next only records that it was seen. Stopping the reading is a Settings matter (`hostHistory`), not a step here.
 */
import { StepDemo } from '@ferretry/app';
import { useEffect } from 'react';
import type { ClaudeCodeClient } from '../../../lib/client.ts';
import { ConversationsDemo } from '../demos.tsx';
import type { StepPageProps } from '../props.ts';

/** The owner's words: binding. */
export const ONE_WAY =
  'Ferretry reads the Claude Code conversations on this computer by itself, one way: it never changes them, and copies one only when you continue it here.';

export function ConversationsPage({ step }: StepPageProps<ClaudeCodeClient>) {
  useEffect(() => {
    step?.ready();
  }, [step]);
  return (
    <div className="cc-step" data-onboarding-step="claude-code.conversations">
      <p className="cc-step__line" data-conversations-one-way="">
        {ONE_WAY}
      </p>
      <StepDemo>
        <ConversationsDemo />
      </StepDemo>
    </div>
  );
}
