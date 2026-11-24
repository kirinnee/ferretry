/**
 * Step `conversations`: no choice. Ferretry reads the conversations from the person's own terminal Codex automatically, one
 * way, and the page says so in one sentence beside a clearly generic example. It asks nothing and writes nothing, so it is
 * ready at once and Next only records that it was seen. Stopping the reading is a Settings matter (`hostHistory`), not a step.
 */
import { StepDemo } from '@ferretry/app';
import { StepBody, StepLine } from '@ferretry/plugin-runtimes/import-kit';
import { useEffect } from 'react';
import { ConversationsDemo } from '../demos.tsx';
import type { StepHost } from '../onboarding-api.ts';

/** The owner's words: binding. */
export const ONE_WAY_WORDS =
  'Ferretry reads the Codex conversations on this computer by itself, one way: it never changes them, and copies one only when you continue it here.';

export function ConversationsPage({ step }: { readonly step: StepHost }) {
  useEffect(() => {
    step.ready();
  }, [step]);
  return (
    <StepBody step="codex.conversations" label="Codex conversations" data-codex-step="conversations">
      <StepLine data-conversations-words="">{ONE_WAY_WORDS}</StepLine>
      <StepDemo>
        <ConversationsDemo />
      </StepDemo>
    </StepBody>
  );
}
