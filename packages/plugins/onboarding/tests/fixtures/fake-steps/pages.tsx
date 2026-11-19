/**
 * The fake plugin's pages: the smallest honest uses of `StepHost`. `choose` is the conditional one: it skips as
 * `not-needed` when an earlier page of the same plugin chose `mode: 'everything'`, and otherwise offers the choice.
 */
import { useEffect } from 'react';
import type { StepHost } from '@ferretry/kernel/contract';

interface Props {
  readonly step: StepHost;
}

export function WelcomePage({ step }: Props) {
  useEffect(() => step.ready(), [step]);
  return (
    <div>
      <button type="button" onClick={() => step.remember({ mode: 'everything' })}>
        Everything
      </button>
      <button type="button" onClick={() => step.remember({ mode: 'choose' })}>
        Choose
      </button>
      <button type="button" onClick={() => step.next()}>
        Go on
      </button>
    </div>
  );
}

export function ChoosePage({ step }: Props) {
  const skipped = step.segment.mode === 'everything';
  useEffect(() => {
    if (skipped) step.skip('not-needed');
    else step.ready();
  }, [skipped, step]);
  return skipped ? null : (
    <button type="button" onClick={() => step.done()}>
      Pick
    </button>
  );
}

export function FinishPage({ step }: Props) {
  useEffect(() => step.ready(), [step]);
  return (
    <button type="button" onClick={() => step.done()}>
      Finish
    </button>
  );
}

export function LookPage({ step }: Props) {
  useEffect(() => step.ready(), [step]);
  return (
    <button type="button" onClick={() => step.done()}>
      Looks good
    </button>
  );
}
