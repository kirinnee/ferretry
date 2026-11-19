/**
 * "Sign in" — the second page of the Claude segment. The sign-in is Logins': this page only offers the slot Logins
 * fills (`claude-code.sign-in`) and passes it three plain callbacks. The panel reads the logins itself, then says
 * `onAlreadySignedIn` (a Claude login is ready → this page skips, nothing drawn) or `onShown` (the page lifts its loading
 * cover), and later `onSignedIn`. Nothing here ever sees a token, a code or an address, and this plugin never calls
 * Logins' routes.
 */
import { daemonOfClient, PanelSlot, useSlotHasPanels } from '@ferretry/app';
import { useEffect, useRef } from 'react';
import { CLAUDE_CODE_SIGN_IN_SLOT } from '../../../contract/index.ts';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import type { StepPageProps } from './props.ts';

export function SignInPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const placed = useSlotHasPanels(CLAUDE_CODE_SIGN_IN_SLOT);
  const daemon = daemonOfClient(client);
  const available = placed && daemon !== undefined;
  const told = useRef(false);

  useEffect(() => {
    // No panel to ask: show the page (it says where to sign in) instead of leaving it under the loading cover.
    if (available || told.current) return;
    told.current = true;
    step?.ready();
  }, [available, step]);

  return (
    <div className="cc-step" data-onboarding-step="claude-code.sign-in">
      <p className="cc-step__line">
        Sign in to your Claude account on this machine. Ferretry never sees the sign-in: Claude Code keeps it.
      </p>
      {available ? (
        <PanelSlot
          daemon={daemon}
          slot={CLAUDE_CODE_SIGN_IN_SLOT}
          props={{
            onShown: () => step?.ready(),
            onAlreadySignedIn: () => step?.skip('not-needed'),
            onSignedIn: () => step?.done(),
          }}
        />
      ) : (
        <p className="cc-step__line" data-sign-in-missing="">
          The sign-in panel is not available here. Sign in from Settings › Logins, then come back.
        </p>
      )}
    </div>
  );
}
