/**
 * THE BODY AND THE STEPS OF ONE AGENDA ITEM: full Markdown through the caller's prose renderer (the
 * chat's own, so hypermedia blocks and the proof-before-link reference gate behave exactly as in a
 * message), the steps as a checklist.
 *
 * A tick is OPTIMISTIC: it shows at once and goes to the machine as the `progress` action, so every
 * device sees it; a refusal rolls it back and says so on the step. A long body shows a short preview with
 * "Show more", never clipped without a way to the rest.
 */

import { type ReactNode, useId, useState } from 'react';
import { collapsesByDefault } from './agenda-board.tsx';

type Prose = (text: string) => ReactNode;

export function AgendaBody({ text, renderProse }: { readonly text: string; readonly renderProse: Prose }) {
  const [all, setAll] = useState(false);
  const folds = collapsesByDefault(text);
  const regionId = useId();
  return (
    <div className="fy-attn-body" data-agenda-body="" data-folded={(folds && !all) || undefined} id={regionId}>
      <div className="fy-attn-body__text">{renderProse(text)}</div>
      {folds ? (
        <button
          aria-controls={regionId}
          aria-expanded={all}
          className="fy-attn-card__more"
          data-agenda-body-toggle=""
          onClick={() => setAll(open => !open)}
          type="button"
        >
          {all ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

export interface AgendaStepsProps {
  readonly steps: readonly string[];
  /** The indices already ticked on the machine. */
  readonly done: readonly number[];
  readonly renderProse: Prose;
  /** Sends one tick; a rejection rolls it back. Absent: the list is read-only. */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  readonly disabled?: boolean;
}

export function AgendaSteps({ steps, done, renderProse, onProgress, disabled = false }: AgendaStepsProps) {
  const [pending, setPending] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [failure, setFailure] = useState<{ readonly step: number; readonly message: string } | null>(null);
  const confirmed = new Set(done);
  const ticked = (step: number): boolean => pending.get(step) ?? confirmed.has(step);
  const count = steps.reduce((total, _, step) => total + (ticked(step) ? 1 : 0), 0);

  const settle = (step: number): void =>
    setPending(current => {
      const next = new Map(current);
      next.delete(step);
      return next;
    });

  const toggle = (step: number): void => {
    if (onProgress === undefined || pending.has(step)) return;
    const next = !ticked(step);
    setFailure(null);
    setPending(current => new Map(current).set(step, next));
    onProgress(step, next).then(
      () => settle(step),
      (reason: unknown) => {
        settle(step);
        setFailure({
          step,
          message: reason instanceof Error ? reason.message : 'the machine did not accept it',
        });
      },
    );
  };

  return (
    <section aria-label="Steps" className="fy-attn-steps" data-agenda-steps="">
      <p className="fy-attn-steps__count" data-agenda-steps-count="">
        {count} of {steps.length} done
      </p>
      <ol className="fy-attn-steps__list">
        {steps.map((text, step) => {
          const on = ticked(step);
          const saving = pending.has(step);
          return (
            <li
              className="fy-attn-step"
              data-agenda-step={step}
              data-done={on || undefined}
              // biome-ignore lint/suspicious/noArrayIndexKey: a step's position is its identity on the wire
              key={step}
            >
              <input
                aria-label={`Step ${step + 1}`}
                aria-busy={saving || undefined}
                checked={on}
                className="fy-attn-step__box"
                data-agenda-tick={step}
                disabled={disabled || onProgress === undefined}
                onChange={() => toggle(step)}
                type="checkbox"
              />
              <div className="fy-attn-step__text">{renderProse(text)}</div>
              {failure?.step === step ? (
                <p className="fy-attn-step__error m-0 text-meta text-err" role="alert">
                  Step {step + 1} was not saved: {failure.message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
