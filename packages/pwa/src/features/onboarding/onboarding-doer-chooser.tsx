/**
 * THE FIRST SCREEN ASKS WHO IS DOING THIS: an agent, or the reader.
 *
 * It used to ask what this DEVICE was, and the agent path was folded into the
 * install step as an alternative WAY of running one command. That was wrong, and
 * the difference is not a matter of taste: if an agent does the setup there is no
 * platform picker, no command to copy, no `fy pair` to run by hand, and no device
 * question left to ask — the agent is on the machine that becomes the daemon, so
 * this browser is the client and nothing about it is in doubt. A journey that
 * differs at every step belongs before the question it deletes.
 *
 * THE WORK HAPPENS SOMEWHERE ELSE, AND THAT MUST BE UNMISSABLE. Both answers name
 * "the machine that will run your agents" rather than "this machine", because a
 * reader who pastes the prompt into an agent that is not on that machine has
 * installed Ferretry on the wrong host. The line under the question says the same
 * thing once, plainly, before either answer is read.
 *
 * IT IS A REAL LIST OF REAL BUTTONS. `<ul>`/`<li>` because it is a list, one
 * `<button>` per row because each is an action; no `role` anywhere, and nothing
 * that needs `aria-label` to have a name. The rows carry no `aria-pressed`
 * either: this is a choice that navigates, not a toggle that sticks.
 */

import { Bot, ChevronRight, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';

import { ONBOARDING_DOERS, type OnboardingDoerId } from './onboarding-model.ts';

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

export interface OnboardingDoerChooserProps {
  readonly onChoose: (doer: OnboardingDoerId) => void;
}

export function OnboardingDoerChooser({ onChoose }: OnboardingDoerChooserProps) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="onboarding-doer-title">
      <div className="min-w-0">
        <h2 id="onboarding-doer-title" className="m-0 font-display text-title font-bold tracking-display text-fg">
          Who is doing this?
        </h2>
        <p className="m-0 text-meta leading-base text-muted">
          Either way, Ferretry is installed on the machine that will run your agents — not on this page.
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {ONBOARDING_DOERS.map(doer => (
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
    </section>
  );
}
