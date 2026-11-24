/**
 * STEP PAGE FRAME: the one layout of a stepper page (the onboarding pages, the create-project stepper, any future
 * "new X" flow), so every stepper looks and behaves the same.
 *
 *   <StepPageFrame title="Which side?" line="You can change it later." progress={…}
 *     demo={<SettingPreview … />} back={{ onClick: back }} next={{ label: 'Next', onClick: next }}>
 *     <ChoiceCards … />
 *   </StepPageFrame>
 *
 * The title, one line, the body, and a demo column on the right at >= 900px of the frame (one reading column of 520..600px
 * at the same place on every page, with or without a demo | demo, the demo sticky; above the body, <= 140px tall, on a phone). A page fills the column with `demo` or, from anywhere in its body,
 * with `<StepDemo>` (`step-demo.tsx`); a page with neither draws no column.
 * The footer may carry one `note` line above the buttons. It holds Back (ghost), an optional Later (secondary) and Next (primary), in that order: each exactly 8.5rem wide
 * (136px), 44px tall, 12px apart, right-aligned to the reading column's edge; the note is drawn over the page just above the footer, never in its height; on a phone the three share the row in equal thirds, sticky at the bottom of the screen. `next.busy` locks Next
 * and shows the spinner. Any Button in the body is the same width and height (one rule in the CSS).
 * Layout and motion live in `step-page-frame.css`; this file chooses no colour.
 */

import { type ReactNode, useState } from 'react';
import { useHeldLoading } from '../ui/loading.tsx';
import { Button } from '../ui/primitives.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { StepDemoSlotContext } from './step-demo.tsx';
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

export interface StepPageLater {
  /** Defaults to "Later". */
  readonly label?: string;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly onClick?: () => void;
  /** Extra `data-*` marks for the caller's own tests and styles. */
  readonly marks?: Readonly<Record<`data-${string}`, string>>;
}

export interface StepPageFrameProps {
  readonly title: string;
  readonly line?: string;
  /** A decorative mini-scene beside (or above, on a phone) the body. */
  readonly demo?: ReactNode;
  readonly children: ReactNode;
  readonly back?: StepPageBack;
  readonly next: StepPageNext;
  /** "Come back to this later": a real secondary button in the footer row, never a link in the page. */
  readonly later?: StepPageLater;
  /** One short line in the footer, above the buttons, so it stays on screen with them (a failed save, say). The caller draws and colours it. */
  readonly note?: ReactNode;
  readonly progress?: StepProgressProps;
}

export function StepPageFrame({ title, line, demo, children, back, next, later, note, progress }: StepPageFrameProps) {
  const locked = next.disabled === true || next.busy === true;
  // The in-button mark keeps its minimum on screen once shown (the same hold as the page loader); it sits in the button, over nothing.
  const marked = useHeldLoading(next.busy === true);
  // The demo column always exists so a StepDemo can portal into it; `:empty` (css) hides it while nothing is drawn there.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <StepDemoSlotContext.Provider value={slot}>
      <section className="fy-spf" data-step-page="" aria-busy={next.busy === true || undefined}>
        <div className="fy-spf__page">
          {progress === undefined ? null : <StepProgress {...progress} />}
          {/* The pin holds the heading and the demo: on a phone a pinned demo (`<StepDemo pinned>`) keeps both on screen. */}
          <div className="fy-spf__pin">
            <header className="fy-spf__head">
              <h1 className="fy-spf__title">{title}</h1>
              {line === undefined ? null : <p className="fy-spf__line">{line}</p>}
            </header>
            <aside className="fy-spf__demo" aria-hidden="true" data-step-demo="" ref={setSlot}>
              {demo}
            </aside>
          </div>
          <div className="fy-spf__main">
            <div className="fy-spf__body">{children}</div>
          </div>
        </div>
        <footer className="fy-spf__footer" data-step-footer="">
          {note === undefined ? null : <div className="fy-spf__note">{note}</div>}
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
            {later === undefined ? null : (
              <Button
                variant="outline"
                className="fy-spf__button"
                disabled={later.disabled === true}
                onClick={later.onClick}
                {...(later.title === undefined ? {} : { title: later.title })}
                {...later.marks}
                data-step-later=""
              >
                {later.label ?? 'Later'}
              </Button>
            )}
            <Button
              variant="primary"
              className="fy-spf__button"
              disabled={locked}
              onClick={next.onClick}
              data-step-next=""
            >
              {marked ? <Spinner size={14} wait /> : null}
              {next.label}
            </Button>
          </div>
        </footer>
      </section>
    </StepDemoSlotContext.Provider>
  );
}
