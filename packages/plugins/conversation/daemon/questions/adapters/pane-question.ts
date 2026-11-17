import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { harnessFormPane } from './harness-form-pane.ts';
import { numberedFormShown, type OpenForm, questionScreen, readOpenForm } from '../lib/rendered-form.ts';

/**
 * M7: what a ferret's pane shows of a structured question, through the same form seam the answer driver reads
 * (`FerretHarness.form.capture`: masked, guarded, reads only). Replaces Claude's `PreToolUse` hook as the place an OPEN
 * question is seen.
 *
 * `form` is the question on screen. `ownsPane` is a numbered surface that is not a question this can extract (the review
 * page, a form whose top scrolled out): it keeps a stored question open instead of reading as gone. A pane the runner's
 * own permission or dialog readers claim is neither — a permission prompt shares a form's rows and is never a question.
 * A pane that cannot be read (no harness, no form seam, a refusal, a dead pane) is `'unreadable'` and decides nothing.
 */
export function panePending(
  ferrets: Pick<FerretsApi, 'harness'>,
): (ferret: string) => Promise<{ readonly form?: OpenForm; readonly ownsPane: boolean } | 'unreadable'> {
  const pane = harnessFormPane(ferrets);
  return async ferret => {
    const captured = await pane.state(ferret).then(
      state => state,
      () => undefined,
    );
    if (captured === undefined || !captured.alive || captured.dead) return 'unreadable';
    if (captured.blocking !== undefined) return { ownsPane: true };
    const screen = questionScreen(captured.visible, captured.history);
    const form = readOpenForm(screen);
    return form === undefined ? { ownsPane: numberedFormShown(screen) } : { form, ownsPane: true };
  };
}
