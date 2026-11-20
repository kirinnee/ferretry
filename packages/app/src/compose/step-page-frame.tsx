/**
 * STEP PAGE FRAME: the one layout of a stepper page (the onboarding pages, the create-project stepper, any future
 * "new X" flow), so every stepper looks and behaves the same.
 *
 *   <StepPageFrame title="Which side?" line="You can change it later." progress={…}
 *     demo={<SettingPreview … />} back={{ onClick: back }} next={{ label: 'Next', onClick: next }}>
 *     <ChoiceCards … />
 *   </StepPageFrame>
 *
 * The title, one line, the body, and a demo box on the right at >= 900px (above the body, <= 120px tall, on a phone).
 * The footer holds Back (ghost) and Next (primary): auto width, min-height 44px, 12-16px vertical padding, right
 * aligned, and sticky at the bottom of the screen on a phone. `next.busy` locks Next and shows the spinner.
 * Layout and motion live in `step-page-frame.css`; this file chooses no colour.
 */

import type { ReactNode } from 'react';
import { Button } from '../ui/primitives.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { StepProgress, type StepProgressProps } from './step-progress.tsx';
import './step-page-frame.css';

export interface StepPageBack {
  /** Defaults to "Back". */
  readonly label?: string;
  /** Locked while the page is working (Next is locked then too). */
  readonly disabled?: boolean;
  /** Optional: a caller that routes elsewhere (a link, a form submit) may omit it. */
  readonly onClick?: () => void;
}

export interface StepPageNext {
  readonly label: string;
  readonly disabled?: boolean;
  /** Working: Next is locked and shows the busy mark. */
  readonly busy?: boolean;
  /** Optional: a caller that routes elsewhere (a link, a form submit) may omit it. */
  readonly onClick?: () => void;
}

export interface StepPageFrameProps {
  readonly title: string;
  readonly line?: string;
  /** A decorative mini-scene beside (or above, on a phone) the body. */
  readonly demo?: ReactNode;
  readonly children: ReactNode;
  readonly back?: StepPageBack;
  readonly next: StepPageNext;
  readonly progress?: StepProgressProps;
}

export function StepPageFrame({ title, line, demo, children, back, next, progress }: StepPageFrameProps) {
  const locked = next.disabled === true || next.busy === true;
  return (
    <section className="fy-spf" data-step-page="" aria-busy={next.busy === true || undefined}>
      <div className="fy-spf__page">
        {progress === undefined ? null : <StepProgress {...progress} />}
        <header className="fy-spf__head">
          <h1 className="fy-spf__title">{title}</h1>
          {line === undefined ? null : <p className="fy-spf__line">{line}</p>}
        </header>
        <div className="fy-spf__main">
          <div className="fy-spf__body">{children}</div>
          {demo === undefined ? null : (
            <aside className="fy-spf__demo" aria-hidden="true" data-step-demo="">
              {demo}
            </aside>
          )}
        </div>
      </div>
      <footer className="fy-spf__footer" data-step-footer="">
        <div className="fy-spf__actions">
          {back === undefined ? null : (
            <Button
              variant="ghost"
              className="fy-spf__button"
              disabled={back.disabled === true}
              onClick={back.onClick}
              data-step-back=""
            >
              {back.label ?? 'Back'}
            </Button>
          )}
          <Button
            variant="primary"
            className="fy-spf__button"
            disabled={locked}
            onClick={next.onClick}
            data-step-next=""
          >
            {next.busy === true ? <Spinner size={14} /> : null}
            {next.label}
          </Button>
        </div>
      </footer>
    </section>
  );
}
