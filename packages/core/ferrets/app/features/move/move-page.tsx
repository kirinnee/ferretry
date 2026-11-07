/**
 * THE MOVE PAGE: one ferret, moved onto another account. The former sheet for changing a ferret’s account and the "Move to Codex… / Move to
 * Claude…" sheet, drawn as one screen with a switch between them: change the model or account on the ferret's own
 * CLI, or carry its conversation to the other CLI.
 *
 * The page reads the ferret once, and draws the runtime field through the slot `ferrets.move-account` (see
 * `account-slot.tsx`). Moving is the owner's act or a governed device's, exactly as before: this page only calls the
 * move routes, and whatever the daemon refuses (a device without the fleet capability, a step-up it wants) is shown as
 * the daemon's own sentence.
 */

import { ArrowLeftRight, LoaderCircle, ServerCog } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import type { FerretsClient } from '../../lib/client.ts';
import { Button } from '../../ui.ts';
import type { RenderAccountSlot } from './account-slot.tsx';
import { ChangeAccount } from './change-account.tsx';
import { moveCallFailure } from './call-failure.ts';
import { ConvertHarness } from './convert-harness.tsx';
import { HARNESS_SHORT, otherHarness } from './conversion-model.ts';
import { askToStopJobs, moveFerret, moveToOtherHarness, readConversionPreview, readFerret } from './move-api.ts';

export interface MovePageProps {
  readonly client: FerretsClient;
  /** The ferret id (the screen's `ferret` parameter). */
  readonly ferret: string;
  readonly slot: RenderAccountSlot;
  /** Back to the ferret. */
  readonly onClose: () => void;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly summary: FerretSummary }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'moved'; readonly summary: FerretSummary; readonly notice: string };

type Mode = 'account' | 'cli';

export function MovePage({ client, ferret, slot, onClose }: MovePageProps) {
  const headingId = useId().replace(/:/gu, '');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [mode, setMode] = useState<Mode>('account');
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the deliberate re-read trigger
  useEffect(() => {
    let current = true;
    setLoad({ status: 'loading' });
    readFerret(client, ferret)
      .then(summary => {
        if (current) setLoad({ status: 'ready', summary });
      })
      .catch((reason: unknown) => {
        if (current) setLoad({ status: 'failed', message: moveCallFailure(reason).message });
      });
    return () => {
      current = false;
    };
  }, [client, ferret, attempt]);

  const moved = useCallback(
    (summary: FerretSummary, notice: string) => setLoad({ status: 'moved', summary, notice }),
    [],
  );

  const summary = load.status === 'ready' || load.status === 'moved' ? load.summary : null;
  const otherName = summary === null ? 'the other CLI' : HARNESS_SHORT[otherHarness(summary.harness)];

  return (
    <main aria-labelledby={headingId} className="flex min-h-0 flex-1 flex-col bg-surface" data-move-page="">
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y pt-4">
        <div className="flex items-center gap-sm">
          <ServerCog aria-hidden="true" className="text-accent" size={16} />
          <h1 id={headingId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
            Move {summary === null ? 'ferret' : summary.name}
          </h1>
        </div>
        <p className="mt-1 text-ui leading-base text-muted">
          Relaunch this conversation on another account or model, or carry it to {otherName}.
        </p>
        {load.status === 'ready' ? (
          // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, grouped for assistive technology as in today's sheet
          <div aria-label="What to change" className="mt-3 flex flex-wrap gap-sm" role="group">
            <Button
              aria-pressed={mode === 'account'}
              data-move-mode="account"
              onClick={() => setMode('account')}
              size="sm"
              type="button"
              variant={mode === 'account' ? 'primary' : 'outline'}
            >
              Change model or account
            </Button>
            <Button
              aria-pressed={mode === 'cli'}
              data-move-mode="cli"
              onClick={() => setMode('cli')}
              size="sm"
              type="button"
              variant={mode === 'cli' ? 'primary' : 'outline'}
            >
              <ArrowLeftRight aria-hidden="true" size={13} />
              Move to {otherName}
            </Button>
          </div>
        ) : null}
      </div>

      {load.status === 'loading' ? (
        <p className="m-0 flex items-center gap-sm px-panel py-4 text-ui text-muted" data-move-loading="" role="status">
          <LoaderCircle aria-hidden="true" className="animate-spin text-accent" size={16} />
          Reading the ferret…
        </p>
      ) : load.status === 'failed' ? (
        <section className="m-4 rounded-control border border-err bg-surface-2 p-4" data-move-failed="" role="alert">
          <p className="m-0 break-words text-ui leading-base text-err">{load.message}</p>
          <div className="mt-3 flex gap-sm">
            <Button onClick={() => setAttempt(count => count + 1)} type="button">
              Try again
            </Button>
            <Button onClick={onClose} type="button">
              Back
            </Button>
          </div>
        </section>
      ) : load.status === 'moved' ? (
        <section className="m-4 rounded-control border border-border bg-surface-2 p-4" data-move-done="" role="status">
          <p className="m-0 text-title font-semibold text-fg">{load.notice}</p>
          <p className="mt-1 text-ui leading-base text-muted">
            {load.summary.name} is relaunching on {load.summary.runtime ?? 'its new account'}.
          </p>
          <Button className="mt-3 min-h-[44px]" data-move-open="" onClick={onClose} type="button" variant="primary">
            Back to {load.summary.name}
          </Button>
        </section>
      ) : mode === 'account' ? (
        <ChangeAccount
          askToStopJobs={() => askToStopJobs(client, ferret)}
          move={(target, requestId) => moveFerret(client, ferret, target, requestId)}
          onCancel={onClose}
          onMoved={next => moved(next, `Moved to ${next.runtime ?? 'the new account'}.`)}
          slot={slot}
          summary={load.summary}
        />
      ) : (
        <ConvertHarness
          move={(agent, requestId, force) => moveToOtherHarness(client, ferret, agent, requestId, force)}
          onCancel={onClose}
          onMoved={moved}
          readPreview={agent => readConversionPreview(client, ferret, agent)}
          slot={slot}
          summary={load.summary}
        />
      )}
    </main>
  );
}
