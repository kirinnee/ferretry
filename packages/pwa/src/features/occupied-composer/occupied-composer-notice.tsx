/**
 * THE OCCUPIED-COMPOSER NOTICE — under the composer, when a send found the agent's own message box
 * already holding the person's unsent text.
 *
 * One sentence, the text quoted so it can be recognised, and two buttons that each finish the job in a
 * tap: "Send it" presses Enter on that text, "Clear it" erases it — both only while the box still holds
 * exactly that — and then the person's new message goes on its own. No session id, no terminal remedy:
 * the person is in the app, and the app can now do it.
 */

import { Button } from '../../shell/primitives.tsx';
import { draftQuote } from './occupied-draft.ts';

export interface OccupiedComposerNoticeProps {
  readonly draft: string;
  /** A tap is in flight; both buttons wait for it. */
  readonly busy: boolean;
  /** One plain sentence when the last tap did not take. */
  readonly failure?: string | undefined;
  /** Absent when this composer cannot act on the box, which leaves the sentence alone. */
  readonly onResolve?: ((action: 'submit' | 'clear') => void) | undefined;
}

export function OccupiedComposerNotice({ draft, busy, failure, onResolve }: OccupiedComposerNoticeProps) {
  return (
    <section aria-label="Unsent text in the agent’s box" className="fy-occupied-composer" data-occupied-composer="">
      <p className="fy-occupied-composer__ask">
        The agent’s message box already has text that wasn’t sent. Yours is waiting until that’s dealt with.
      </p>
      <p className="fy-occupied-composer__draft">“{draftQuote(draft)}”</p>
      {onResolve === undefined ? null : (
        <div className="fy-occupied-composer__actions">
          <Button
            data-occupied-action="submit"
            disabled={busy}
            onClick={() => onResolve('submit')}
            type="button"
            variant="primary"
          >
            Send it
          </Button>
          <Button
            data-occupied-action="clear"
            disabled={busy}
            onClick={() => onResolve('clear')}
            type="button"
            variant="outline"
          >
            Clear it
          </Button>
        </div>
      )}
      <p className="fy-occupied-composer__hint">
        {onResolve === undefined
          ? 'Press Enter on it, or clear it, in the terminal.'
          : 'Send it sends that text first, then yours. Clear it erases it, then sends yours.'}
      </p>
      {failure === undefined ? null : (
        <p className="fy-occupied-composer__failure" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
