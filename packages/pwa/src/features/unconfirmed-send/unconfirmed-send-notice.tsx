/**
 * THE UNCONFIRMED-SEND NOTICE — under the composer, when a message was typed into the agent's own box
 * and the agent never showed it there in time.
 *
 * The person's text stays in the composer above, so nothing is lost. Three taps, each on exactly that
 * send: "Send it" presses Enter on it in the agent's box, "Clear it" takes it back out, and "Retry"
 * types it again — which the daemon does only when it can prove no copy is sitting there. No session
 * id and no terminal remedy: the person is in the app, and the app can do it.
 */

import { Button } from '../../shell/primitives.tsx';
import type { UnconfirmedAction } from './unconfirmed-send.ts';

export interface UnconfirmedSendNoticeProps {
  /** A tap is in flight; every button waits for it. */
  readonly busy: boolean;
  /** One plain sentence when the last tap did not take. */
  readonly failure?: string | undefined;
  /** The actions this composer can perform; a missing one draws no button. */
  readonly actions: readonly UnconfirmedAction[];
  readonly onAct: (action: UnconfirmedAction) => void;
}

const LABELS: Readonly<Record<UnconfirmedAction, string>> = {
  submit: 'Send it',
  clear: 'Clear it',
  retry: 'Retry',
};

export function UnconfirmedSendNotice({ busy, failure, actions, onAct }: UnconfirmedSendNoticeProps) {
  return (
    <section aria-label="Message not confirmed" className="fy-occupied-composer" data-unconfirmed-send="">
      <p className="fy-occupied-composer__ask">
        Your message was typed into the agent’s box, but the agent hasn’t shown it yet, so it wasn’t sent.
      </p>
      {actions.length === 0 ? null : (
        <div className="fy-occupied-composer__actions">
          {actions.map(action => (
            <Button
              data-unconfirmed-action={action}
              disabled={busy}
              key={action}
              onClick={() => onAct(action)}
              type="button"
              variant={action === 'submit' ? 'primary' : 'outline'}
            >
              {LABELS[action]}
            </Button>
          ))}
        </div>
      )}
      <p className="fy-occupied-composer__hint">
        {actions.length === 0
          ? 'Check the agent’s box in the terminal before sending it again.'
          : 'Send it presses Enter on it in the agent’s box. Clear it takes it out and keeps your text here. Retry types it again only if the box is empty.'}
      </p>
      {failure === undefined ? null : (
        <p className="fy-occupied-composer__failure" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
