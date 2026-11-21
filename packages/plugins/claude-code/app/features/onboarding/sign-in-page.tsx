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

const HOLD = 'Sign in to Claude to continue';

export function SignInPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const placed = useSlotHasPanels(CLAUDE_CODE_SIGN_IN_SLOT);
  const daemon = daemonOfClient(client);
  const available = placed && daemon !== undefined;
  const told = useRef(false);

  useEffect(() => {
    // No panel to ask: show the page (it says where to sign in) instead of leaving it under the loading cover, and hold
    // Next: nobody has signed in, and the shell records the default on Next as done (O1 rule 5). Later and Skip stay.
    if (available || told.current) return;
    told.current = true;
    step?.ready();
    step?.busy(HOLD);
  }, [available, step]);

  return (
    <div className="cc-step" data-onboarding-step="claude-code.sign-in">
      <p className="cc-step__line">Sign in to Claude on this machine. Ferretry never sees it: Claude Code keeps it.</p>
      {available ? (
        <PanelSlot
          daemon={daemon}
          slot={CLAUDE_CODE_SIGN_IN_SLOT}
          props={{
            // The panel is up and nobody is signed in: hold Next (the shell records the default on Next, O1 rule 5) until
            // the sign-in has really succeeded. Later and Skip stay available.
            onShown: () => {
              step?.ready();
              step?.busy(HOLD);
            },
            onAlreadySignedIn: () => step?.skip('not-needed'),
            onSignedIn: () => {
              step?.busy(null);
              step?.done();
            },
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
