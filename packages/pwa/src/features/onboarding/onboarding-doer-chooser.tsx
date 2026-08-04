/**
 * WHO INSTALLS IT: an agent, or the reader.
 *
 * Asked on every daemon journey and on every device, because it changes every
 * screen after it. An agent has a terminal on the machine that becomes the daemon
 * and needs one prompt — no platform picker, no commands on the glass, no
 * `fy pair` by hand. A reader typing the commands needs all of those things.
 *
 * THIS SCREEN ALSO SAYS WHERE THE DAEMON IS GOING TO LIVE, and that line is the
 * point of the whole unit rather than a caption.
 *
 * - ON A PHONE IT STATES A FACT. The first question was skipped because the
 *   hardware answers it, so this says so plainly: Ferretry runs on a computer, and
 *   this phone becomes the remote control. A reader who is told that once, before
 *   anything else, is never surprised by a screen that sends them to a desk.
 * - ON A COMPUTER STARTING FROM SCRATCH IT STATES AN ASSUMPTION, with the way out
 *   beside it. Assuming "this one" makes the common path one question shorter, and
 *   the escape is what makes the assumption honest rather than a guess the reader
 *   has to discover being wrong three screens later.
 * - WHEN THE READER CHOSE IT THEMSELVES it is a receipt, not an offer: no escape
 *   is drawn, because Back reaches the question they just answered.
 *
 * The two answers are worded for the machine that was chosen — "this computer" or
 * "that computer" — because a reader who pastes the prompt into an agent on the
 * wrong host installs Ferretry on the wrong host.
 *
 * IT IS A REAL LIST OF REAL BUTTONS. `<ul>`/`<li>` because it is a list, one
 * `<button>` per row because each is an action; no `role` anywhere, and nothing
 * that needs `aria-label` to have a name.
 */

import { ArrowLeft, Bot, ChevronRight, Smartphone, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  type OnboardingDoerId,
  type OnboardingQuestion,
  onboardingDoers,
  type SetupTargetId,
  type TargetBasis,
} from './onboarding-model.ts';

/**
 * One glyph per answer, chosen so the two shapes differ at a glance rather than
 * merely decorating: a robot, and a prompt waiting for typing. Hidden from
 * assistive technology — the title beside each already says the same thing.
 */
const ICON: Readonly<Record<OnboardingDoerId, ReactNode>> = {
  agent: <Bot size={22} aria-hidden="true" />,
  self: <SquareTerminal size={22} aria-hidden="true" />,
};

const ROW =
  'flex w-full min-w-0 items-center gap-3 rounded-control border border-border bg-surface-2 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent-bg focus-visible:outline-focus focus-visible:outline-offset-focus';

/** What the machine line says, per how the machine came to be decided. */
const WHERE: Readonly<Record<TargetBasis, Readonly<Record<SetupTargetId, string>>>> = {
  forced: {
    this: 'This computer will run your agents.',
    other: 'Ferretry runs on a computer. This phone becomes your remote control.',
  },
  assumed: {
    this: 'This computer will run your agents.',
    other: 'Another computer will run your agents.',
  },
  chosen: {
    this: 'This computer will run your agents.',
    other: 'Another computer will run your agents.',
  },
};

export interface OnboardingDoerChooserProps {
  /** Which machine this journey settled on, however it settled. */
  readonly target: SetupTargetId;
  /** How it settled, which decides whether an escape is offered. */
  readonly basis: TargetBasis;
  /** What Back lands on, said out loud so the markup can be asserted against it. */
  readonly behind: OnboardingQuestion;
  readonly onChoose: (doer: OnboardingDoerId) => void;
  readonly onBack: () => void;
  /** Leave the assumption behind: it is another machine after all. */
  readonly onChooseTarget: (target: SetupTargetId) => void;
}

export function OnboardingDoerChooser({
  target,
  basis,
  behind,
  onChoose,
  onBack,
  onChooseTarget,
}: OnboardingDoerChooserProps) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-doer-title">
      <div className="min-w-0 flex-col gap-1">
        {/*
          THE MACHINE, BEFORE THE QUESTION. It is read first because it is the
          thing the reader has to disagree with if we got it wrong, and a reader
          who reads it after choosing an answer has already spent a tap.
        */}
        <p
          className="m-0 flex min-w-0 items-center gap-1 text-meta leading-base text-fg"
          data-onboarding-where={`${basis}:${target}`}
        >
          {basis === 'forced' ? <Smartphone size={16} aria-hidden="true" className="shrink-0 text-accent" /> : null}
          <span className="min-w-0">{WHERE[basis][target]}</span>
        </p>
        <h2 id="onboarding-doer-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
          Who installs it?
        </h2>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {onboardingDoers(target).map(doer => (
          <li key={doer.id} className="min-w-0">
            <button type="button" className={ROW} onClick={() => onChoose(doer.id)} data-onboarding-doer={doer.id}>
              <span className="shrink-0 text-accent">{ICON[doer.id]}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-display text-title font-bold tracking-display text-fg">{doer.title}</span>
                <span className="text-meta leading-base text-muted">{doer.answer}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className="kt-btn min-h-[44px]"
          data-variant="ghost"
          onClick={onBack}
          data-onboarding-back={behind}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
        {/*
          THE ESCAPE FROM AN ASSUMPTION WE MADE, and only from one we made. It is
          quiet because it is the uncommon answer, and it is a real control on the
          screen that states the assumption rather than a discovery three steps
          into a list of commands for the wrong machine.
        */}
        {basis === 'assumed' ? (
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-variant="ghost"
            onClick={() => onChooseTarget(target === 'this' ? 'other' : 'this')}
            data-onboarding-switch-target={target === 'this' ? 'other' : 'this'}
          >
            {target === 'this' ? 'Actually, another machine' : 'Actually, this machine'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
